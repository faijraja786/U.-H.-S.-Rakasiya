const express = require("express");
const cors = require("cors");
const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp, FieldPath } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const https = require("https");

const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
if (!rawServiceAccount) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON environment variable is required.");
const serviceAccount = JSON.parse(rawServiceAccount);
if (!getApps().length) initializeApp({ credential: cert(serviceAccount) });

const db = getFirestore();
const auth = getAuth();
const app = express();
const allowedOrigins = new Set([
  "https://edufuture-1c3dd.web.app",
  "https://edufuture-1c3dd.firebaseapp.com",
  "http://localhost:5000",
  "http://127.0.0.1:5000"
]);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin) || (process.env.EXTRA_ALLOWED_ORIGIN && origin === process.env.EXTRA_ALLOWED_ORIGIN)) return callback(null, true);
    return callback(new Error("Origin is not allowed by EduFuture API."));
  },
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-File-Name", "X-File-Type"]
}));
app.use(express.json({ limit: "20mb" }));

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function geminiHttpsRequest(endpoint, body, timeoutMs = 75000) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const request = https.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, response => {
      const chunks = [];
      let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) {
          request.destroy(Object.assign(new Error("Gemini response बहुत बड़ा है।"), { code: "RESPONSE_TOO_LARGE" }));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        const status = Number(response.statusCode || 0);
        resolve({ status, ok: status >= 200 && status < 300, raw: Buffer.concat(chunks).toString("utf8") });
      });
      response.on("error", reject);
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(Object.assign(new Error("Gemini ने समय पर जवाब नहीं दिया।"), { code: "ETIMEDOUT" }));
    });
    request.on("error", reject);
    request.end(body);
  });
}
const storageBucket = process.env.SUPABASE_BUCKET || "learning";
function storagePathUrl(path) {
  return String(path).split("/").map(encodeURIComponent).join("/");
}

async function deleteStorageObject(path) {
  const clean = String(path || "").replace(/^\/+/, "");
  if (!clean || clean.split("/").some(part => !part || part === "." || part === "..")) return;
  await supabaseStorageRequest("/object/" + encodeURIComponent(storageBucket), {
    method: "DELETE", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prefixes: [clean] })
  });
}
async function signedStorageUrl(path, expiresIn = 3600) {
  const signed = await supabaseStorageRequest("/object/sign/" + encodeURIComponent(storageBucket) + "/" + storagePathUrl(path), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn })
  });
  const relative = signed.signedURL || signed.signedUrl;
  if (!relative) fail("internal", "Secure media link नहीं बन सका।");
  const base = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  return /^https?:\/\//i.test(relative) ? relative :
    (relative.startsWith("/storage/v1/") ? base + relative : base + "/storage/v1" + (relative.startsWith("/") ? relative : "/" + relative));
}
async function supabaseStorageRequest(endpoint, options = {}) {
  const base = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const secret = process.env.SUPABASE_SECRET_KEY || "";
  if (!base || !secret) fail("failed-precondition", "Supabase Storage की server key अभी Render में configure नहीं है।");
  const response = await fetch(base + "/storage/v1" + endpoint, {
    ...options,
    headers: {
      apikey: secret,
      ...(!secret.startsWith("sb_secret_") ? { Authorization: "Bearer " + secret } : {}),
      ...(options.headers || {})
    }
  });
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { message: raw }; }
  if (!response.ok) {
    const error = new Error(data.message || data.error || "Supabase Storage request failed (" + response.status + ").");
    error.code = response.status === 404 ? "not-found" : "internal";
    error.status = response.status;
    error.supabaseCode = typeof data.code === "string" ? data.code : (typeof data.error === "string" ? data.error : null);
    throw error;
  }
  return data;
}
async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const match = header.match(/^Bearer (.+)$/i);
    if (!match) return res.status(401).json({ error: { code: "unauthenticated", message: "कृपया पहले लॉगिन करें।" } });
    req.user = await auth.verifyIdToken(match[1]);
    next();
  } catch (error) {
    return res.status(401).json({ error: { code: "unauthenticated", message: "Login session मान्य नहीं है। दोबारा login करें।" } });
  }
}
async function roleOf(uid) {
  const snap = await db.doc("roles/" + uid).get();
  return snap.exists ? snap.data().role : "student";
}
async function requireAdmin(req, superOnly = false) {
  const role = await roleOf(req.user.uid);
  if (!["admin", "superadmin"].includes(role) || (superOnly && role !== "superadmin")) {
    fail("permission-denied", superOnly ? "यह सुविधा केवल Super Admin के लिए है।" : "केवल Admin उपयोग कर सकता है।");
  }
  return req.user.uid;
}
async function requireTeacher(req, subject, className) {
  const role = await roleOf(req.user.uid);
  if (!["teacher", "admin", "superadmin"].includes(role)) fail("permission-denied", "यह सुविधा केवल Teacher या Admin के लिए है।");
  if (["admin", "superadmin"].includes(role)) return true;
  const snap = await db.doc("teacherAssignments/" + req.user.uid).get();
  const assignment = snap.exists ? snap.data() : {};
  const subjects = assignment.subjects || [];
  const classes = assignment.classes || [];
  if (subject && !subjects.some(x => String(x).toLowerCase() === String(subject).toLowerCase())) fail("permission-denied", "यह विषय आपको assign नहीं किया गया है।");
  if (subject && (!className || !classes.length || !classes.some(x => normalizeClassName(x) === normalizeClassName(className)))) fail("permission-denied", "यह कक्षा आपको assign नहीं की गई है।");
  return true;
}

function normalizeClassName(value) {
  return String(value || "").toLowerCase().replace(/^(class|कक्षा)\s*/i, "").replace(/[^\p{L}\p{N}]/gu, "");
}

async function setRole(uid, role, extra = {}) {
  const user = await auth.getUser(uid);
  await db.doc("roles/" + uid).set({
    role, email: (user.email || "").toLowerCase(),
    displayName: user.displayName || "", updatedAt: FieldValue.serverTimestamp(), ...extra
  }, { merge: true });
  const claims = { ...(user.customClaims || {}) };
  if (role === "student") delete claims.role;
  else claims.role = role;
  await auth.setCustomUserClaims(uid, claims);
}

async function run(name, req) {
  const uid = req.user.uid;
  const d = req.body && req.body.data && typeof req.body.data === "object" ? req.body.data : {};
  switch (name) {
    case "ensureStudentRole": {
      const ref = db.doc("roles/" + uid);
      await db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists) tx.create(ref, {
          role: "student", email: (req.user.email || "").toLowerCase(),
          displayName: req.user.name || "", className: "", createdAt: FieldValue.serverTimestamp()
        });
        else if (!snap.data().displayName && req.user.name) tx.set(ref, {
          displayName: req.user.name, email: (req.user.email || "").toLowerCase(),
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
      });
      return { role: await roleOf(uid) };
    }
    case "saveStudentProfile": {
      const currentRole = await roleOf(uid);
      if (currentRole !== "student") fail("permission-denied", "केवल Student अपना profile पूरा कर सकता है।");
      const displayName = String(d.displayName || "").trim().replace(/\s+/g, " ").slice(0, 80);
      const className = String(d.className || "").trim().slice(0, 30);
      if (displayName.length < 2 || !className) fail("invalid-argument", "पूरा नाम और कक्षा भरना जरूरी है।");
      await auth.updateUser(uid, { displayName });
      await db.doc("roles/" + uid).set({
        role: "student", email: (req.user.email || "").toLowerCase(),
        displayName, className, profileCompleted: true,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      return { ok: true, displayName, className };
    }
    case "bootstrapFirstAdmin": {
      const email = (req.user.email || "").toLowerCase();
      const allowed = (process.env.BOOTSTRAP_ADMIN_EMAIL || "").trim().toLowerCase();
      if (!allowed || email !== allowed) fail("permission-denied", "यह ईमेल First Super Admin के लिए configured नहीं है।");
      const lockRef = db.doc("system/bootstrap");
      const roleRef = db.doc("roles/" + uid);
      await db.runTransaction(async tx => {
        const lock = await tx.get(lockRef);
        if (lock.exists && lock.data().completed) fail("already-exists", "First Admin setup पहले ही हो चुका है।");
        tx.set(lockRef, { completed: true, uid, email, createdAt: FieldValue.serverTimestamp() });
        tx.set(roleRef, { role: "superadmin", email, displayName: req.user.name || "", createdAt: FieldValue.serverTimestamp() }, { merge: true });
      });
      const user = await auth.getUser(uid);
      await auth.setCustomUserClaims(uid, { ...(user.customClaims || {}), role: "superadmin" });
      return { ok: true, role: "superadmin" };
    }
    case "addAdmin": {
      const actor = await requireAdmin(req, true);
      const email = String(d.email || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("invalid-argument", "सही ईमेल लिखें।");
      let target;
      try { target = await auth.getUserByEmail(email); }
      catch { fail("not-found", "इस ईमेल से पहले एक बार account बनाकर login करना होगा।"); }
      if (target.uid === actor) fail("invalid-argument", "अपने account की role बदलने के लिए यह विकल्प उपयोग न करें।");
      if (await roleOf(target.uid) === "superadmin") fail("failed-precondition", "किसी दूसरे Super Admin को Admin में नहीं बदला जा सकता।");
      await setRole(target.uid, "admin", { addedBy: actor });
      return { ok: true };
    }
    case "removeAdmin": {
      const actor = await requireAdmin(req, true);
      const targetUid = String(d.uid || "");
      if (!targetUid || targetUid === actor) fail("invalid-argument", "किसी दूसरे Admin को चुनें।");
      if (await roleOf(targetUid) !== "admin") fail("failed-precondition", "यह account Admin नहीं है या Super Admin है।");
      await setRole(targetUid, "student", { removedBy: actor, removedAt: FieldValue.serverTimestamp() });
      return { ok: true };
    }
    case "listAdmins": {
      await requireAdmin(req, true);
      const snap = await db.collection("roles").where("role", "in", ["admin", "superadmin"]).get();
      return { admins: snap.docs.map(x => ({ uid: x.id, ...x.data() })) };
    }
    case "saveQuiz": {
      await requireAdmin(req);
      const questions = Array.isArray(d.questions) ? d.questions : [];
      const title = String(d.title || "").trim();
      const duration = Number(d.duration);
      if (!title || !questions.length || questions.length > 2000) fail("invalid-argument", "Quiz title और 1 से 2000 questions जरूरी हैं।");
      if (!Number.isFinite(duration) || duration < 1 || duration > 600) fail("invalid-argument", "Timer 1 से 600 मिनट के बीच रखें।");
      let totalMarks = 0;
      questions.forEach((q, i) => {
        const type = q.type === "subjective" ? "subjective" : "objective";
        const marks = Number(q.marks ?? 1);
        if (!String(q.text || "").trim() || !Number.isFinite(marks) || marks <= 0 || marks > 100) fail("invalid-argument", "Question " + (i + 1) + " का text और marks जाँचें।");
        if (type === "objective" && (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 6 ||
          q.options.some(x => !String(x || "").trim()) || !Number.isInteger(q.answer) || q.answer < 0 || q.answer >= q.options.length)) {
          fail("invalid-argument", "Objective Question " + (i + 1) + " में options या सही answer जाँचें।");
        }
        totalMarks += marks;
      });
      const quizRef = db.collection("quizzes").doc();
      await quizRef.set({
        title, subject: String(d.subject || "General").trim(),
        topic: String(d.topic || "").trim(), className: String(d.className || "").trim(),
        duration, questionCount: questions.length, totalMarks,
        quizType: ["objective","subjective","mixed"].includes(d.quizType) ? d.quizType : (questions.every(q=>q.type==="subjective")?"subjective":questions.every(q=>q.type!=="subjective")?"objective":"mixed"),
        status: "draft",
        createdBy: uid, createdAt: FieldValue.serverTimestamp()
      });
      const writer = db.bulkWriter();
      questions.forEach((q, i) => {
        const type = q.type === "subjective" ? "subjective" : "objective";
        writer.set(quizRef.collection("publicQuestions").doc(String(i)), {
          text: String(q.text).trim(), type,
          options: type === "objective" ? q.options.map(x => String(x).trim()) : [],
          marks: Number(q.marks ?? 1), index: i,
          topic: String(q.topic || d.topic || d.subject || "General").trim(),
          difficulty: ["easy", "medium", "hard"].includes(q.difficulty) ? q.difficulty : "medium"
        });
        writer.set(quizRef.collection("privateAnswers").doc(String(i)), {
          answer: type === "objective" ? q.answer : null,
          modelAnswer: type === "subjective" ? String(q.modelAnswer || "") : "",
          explanation: String(q.explanation || ""),
          marks: Number(q.marks ?? 1), type
        });
      });
      await writer.close();
      let publishedAt = null, closesAt = null, resultsAt = null;
      if (d.publish !== false) {
        const publishedMs = Date.now();
        publishedAt = Timestamp.fromMillis(publishedMs);
        closesAt = Timestamp.fromMillis(publishedMs + 48 * 60 * 60 * 1000);
        resultsAt = Timestamp.fromMillis(publishedMs + 72 * 60 * 60 * 1000);
        await quizRef.update({ status: "published", publishedAt, closesAt, resultsAt });
      }
      return { id: quizRef.id, questionCount: questions.length, totalMarks,
        closesAt: closesAt?.toDate().toISOString() || null,
        resultsAt: resultsAt?.toDate().toISOString() || null };
    }
    case "startQuiz": {
      if (await roleOf(uid) !== "student") fail("permission-denied", "केवल Student Quiz attempt कर सकता है।");
      const quizId = String(d.id || "");
      if (!quizId) fail("invalid-argument", "Quiz ID missing.");
      const quizRef = db.doc("quizzes/" + quizId);
      const quizSnap = await quizRef.get();
      if (!quizSnap.exists || quizSnap.data().status !== "published") fail("not-found", "Quiz उपलब्ध नहीं है।");
      const quiz = quizSnap.data();
      if (await roleOf(uid) === "student") {
        const profileSnap = await db.doc("roles/" + uid).get();
        const studentClass = profileSnap.exists ? profileSnap.data().className : "";
        const quizClass = String(quiz.className || "").trim();
        const generalClass = !quizClass || ["all", "general", "सभी"].includes(quizClass.toLowerCase());
        if (!generalClass && normalizeClassName(studentClass) !== normalizeClassName(quizClass)) {
          fail("permission-denied", "यह Quiz आपकी कक्षा के लिए नहीं है।");
        }
      }
      const closesAtMs = quiz.closesAt?.toMillis?.() || (quiz.publishedAt?.toMillis?.() || 0) + 48 * 60 * 60 * 1000;
      const attemptRef = quizRef.collection("attempts").doc(uid);
      let attemptData = null;
      await db.runTransaction(async tx => {
        const existing = await tx.get(attemptRef);
        if (existing.exists) {
          if (existing.data().status !== "started") fail("already-exists", "आप यह Quiz पहले submit कर चुके हैं। Result 72 घंटे बाद खुलेगा।");
          attemptData = existing.data();
          return;
        }
        if (!closesAtMs || Date.now() >= closesAtMs) fail("failed-precondition", "यह Quiz उपलब्ध नहीं है। Attempt करने की 48 घंटे की अवधि समाप्त हो गई है।");
        const expiresAt = Timestamp.fromMillis(Date.now() + quiz.duration * 60000);
        attemptData = { uid, status: "started", expiresAt, closesAt: Timestamp.fromMillis(closesAtMs) };
        tx.create(attemptRef, { ...attemptData, startedAt: FieldValue.serverTimestamp() });
      });
      const questions = await quizRef.collection("publicQuestions").orderBy("index").get();
      return { attemptId: uid, title: quiz.title, duration: quiz.duration,
        expiresAt: attemptData.expiresAt.toDate().toISOString(),
        questions: questions.docs.map(x => ({ id: x.id, ...x.data() })) };
    }
    case "submitQuiz": {
      if (await roleOf(uid) !== "student") fail("permission-denied", "केवल Student Quiz submit कर सकता है।");
      const quizId = String(d.id || "");
      const attemptId = String(d.attemptId || "");
      const answers = d.answers && typeof d.answers === "object" && !Array.isArray(d.answers) ? d.answers : {};
      if (!quizId || attemptId !== uid) fail("invalid-argument", "Quiz attempt मान्य नहीं है।");
      const quizRef = db.doc("quizzes/" + quizId);
      const quizSnap = await quizRef.get();
      if (!quizSnap.exists || quizSnap.data().status !== "published") fail("not-found", "Quiz उपलब्ध नहीं है।");
      const quizData = quizSnap.data();
      const profileSnap = await db.doc("roles/" + uid).get();
      const studentClass = profileSnap.exists ? profileSnap.data().className : "";
      const quizClass = String(quizData.className || "").trim();
      const generalClass = !quizClass || ["all", "general", "सभी"].includes(quizClass.toLowerCase());
      if (!generalClass && normalizeClassName(studentClass) !== normalizeClassName(quizClass)) fail("permission-denied", "यह Quiz आपकी कक्षा के लिए नहीं है।");
      const attemptRef = quizRef.collection("attempts").doc(uid);
      const [answerSnap, questionSnap] = await Promise.all([
        quizRef.collection("privateAnswers").get(),
        quizRef.collection("publicQuestions").orderBy("index").get()
      ]);
      const validIds = new Set(answerSnap.docs.map(x => x.id));
      if (Object.keys(answers).some(k => !validIds.has(k))) fail("invalid-argument", "Invalid answer key.");
      if (Buffer.byteLength(JSON.stringify(answers), "utf8") > 700 * 1024) fail("invalid-argument", "उत्तर बहुत बड़े हैं। कृपया उत्तर छोटा करके फिर submit करें।");
      const questionById = new Map(questionSnap.docs.map(x => [x.id, x.data()]));
      let objectiveScore = 0, subjectiveScore = 0, objectiveTotal = 0, subjectiveTotal = 0, pendingReview = 0;
      answerSnap.forEach(x => {
        const a = x.data(), q = questionById.get(x.id) || {}, marks = Number(a.marks || q.marks || 1);
        if (a.type === "subjective" || q.type === "subjective") {
          subjectiveTotal += marks;
          if (String(answers[x.id] || "").trim()) pendingReview++;
        } else {
          objectiveTotal += marks;
          if (Number.isInteger(answers[x.id]) && answers[x.id] === a.answer) objectiveScore += marks;
        }
      });
      const userRecord = await auth.getUser(uid);
      const releaseAt = quizData.resultsAt || Timestamp.fromMillis((quizData.publishedAt?.toMillis?.() || Date.now()) + 72 * 60 * 60 * 1000);
      const totalMarks = Number(quizData.totalMarks || questionSnap.docs.reduce((n,x)=>n+Number(x.data().marks||1),0));
      await db.runTransaction(async tx => {
        const current = await tx.get(attemptRef);
        if (!current.exists || current.data().status !== "started" || current.data().uid !== uid) fail("already-exists", "यह Quiz पहले submit हो चुका है।");
        if (Date.now() > current.data().expiresAt.toMillis() + 30000) fail("deadline-exceeded", "Quiz का समय समाप्त हो गया।");
        tx.update(attemptRef, { status: "submitted", answers, objectiveScore, subjectiveScore: 0, pendingReview, releaseAt, submittedAt: FieldValue.serverTimestamp() });
        tx.set(quizRef.collection("leaderboard").doc(uid), {
          uid, email: (userRecord.email || "").toLowerCase(), displayName: userRecord.displayName || "",
          score: objectiveScore, objectiveScore, subjectiveScore: 0, objectiveTotal, subjectiveTotal,
          total: totalMarks, pendingReview, releaseAt, submittedAt: FieldValue.serverTimestamp()
        });
      });
      return { submitted: true, objectiveScore, pendingReview, releaseAt: releaseAt.toDate().toISOString() };
    }
    case "getLeaderboard": {
      const quizRef = db.doc("quizzes/" + String(d.id || ""));
      const quiz = await quizRef.get();
      if (!quiz.exists) fail("not-found", "Quiz नहीं मिला।");
      const requesterRole = await roleOf(uid);
      const isAdmin = ["admin", "superadmin"].includes(requesterRole);
      const quizData = quiz.data();
      if (requesterRole === "student" && quizData.status !== "published") fail("not-found", "Quiz उपलब्ध नहीं है।");
      if (requesterRole === "student") {
        const profile = await db.doc("roles/" + uid).get();
        const studentClass = profile.exists ? profile.data().className : "";
        const quizClass = String(quizData.className || "").trim();
        const generalClass = !quizClass || ["all", "general", "सभी"].includes(quizClass.toLowerCase());
        if (!generalClass && normalizeClassName(studentClass) !== normalizeClassName(quizClass)) fail("permission-denied", "यह Quiz आपकी कक्षा के लिए नहीं है।");
      } else if (requesterRole === "teacher") {
        await requireTeacher(req, quizData.subject, quizData.className);
      } else if (!isAdmin) {
        fail("permission-denied", "यह परिणाम देखने की अनुमति नहीं है।");
      }
      const rankingType = d.rankingType === "subjective" ? "subjective" : "objective";
      const releaseAt = quizData.resultsAt || Timestamp.fromMillis((quizData.publishedAt?.toMillis?.() || Date.now()) + 72 * 60 * 60 * 1000);
      const snap = await quizRef.collection("leaderboard").get();
      const allRows = snap.docs.map(x => x.data());
      const pendingReview = allRows.reduce((n,x)=>n+Number(x.pendingReview||0),0);
      if (!isAdmin && Date.now() < releaseAt.toMillis()) {
        return { released: false, rankingType, releaseAt: releaseAt.toDate().toISOString(), pendingReview, rows: [] };
      }
      if (!isAdmin && rankingType === "subjective" && pendingReview > 0) {
        return { released: false, rankingType, releaseAt: releaseAt.toDate().toISOString(), pendingReview, rows: [] };
      }
      const scoreOf = x => Number(rankingType === "subjective" ? (x.subjectiveScore||0) : (x.objectiveScore ?? x.score ?? 0));
      allRows.sort((a,b)=>scoreOf(b)-scoreOf(a)||(a.submittedAt?.toMillis()||0)-(b.submittedAt?.toMillis()||0));
      let previousScore = null, previousRank = 0;
      const rows = await Promise.all(allRows.map(async (x,i)=>{
        const value=scoreOf(x);
        if(previousScore===null||value!==previousScore)previousRank=i+1;
        previousScore=value;
        let name=x.displayName||"";
        if(!name||name==="Student"){
          try { const profile=await db.doc("roles/"+x.uid).get(); name=profile.exists?(profile.data().displayName||"Student"):"Student"; } catch { name="Student"; }
        }
        return {uid:x.uid,name,score:value,total:Number(rankingType==="subjective"?(x.subjectiveTotal||0):(x.objectiveTotal??x.total??0)),pendingReview:Number(x.pendingReview||0),rank:previousRank};
      }));
      return { released: isAdmin || (Date.now() >= releaseAt.toMillis() && (rankingType !== "subjective" || pendingReview === 0)), rankingType, releaseAt: releaseAt.toDate().toISOString(), pendingReview, rows };
    }
    case "getMyResults": {
      if (await roleOf(uid) !== "student") fail("permission-denied", "यह सुविधा केवल Student के लिए है।");
      const profile = await db.doc("roles/" + uid).get();
      const studentClass = profile.exists ? profile.data().className : "";
      const quizzes = await db.collection("quizzes").get();
      const now = Date.now(), results = [];
      for (const q of quizzes.docs) {
        const quizData = q.data();
        const quizClass = String(quizData.className || "").trim();
        const generalClass = !quizClass || ["all", "general", "सभी"].includes(quizClass.toLowerCase());
        if (!generalClass && normalizeClassName(studentClass) !== normalizeClassName(quizClass)) continue;
        const snap = await q.ref.collection("leaderboard").doc(uid).get();
        if (!snap.exists) continue;
        const data = snap.data();
        const resultRelease = quizData.resultsAt || Timestamp.fromMillis((quizData.publishedAt?.toMillis?.() || Date.now()) + 72 * 60 * 60 * 1000);
        const released = now >= resultRelease.toMillis();
        let review = [];
        if (released) {
          const [attemptSnap, questionSnap, answerSnap] = await Promise.all([
            q.ref.collection("attempts").doc(uid).get(),
            q.ref.collection("publicQuestions").orderBy("index").get(),
            q.ref.collection("privateAnswers").get()
          ]);
          const attempt = attemptSnap.exists ? attemptSnap.data() : {};
          const chosen = attempt.answers || {}, grades = attempt.grades || {};
          const correctById = new Map(answerSnap.docs.map(x => [x.id, x.data()]));
          review = questionSnap.docs.map(questionDoc => {
            const question = questionDoc.data(), answer = correctById.get(questionDoc.id) || {};
            const subjective = question.type === "subjective" || answer.type === "subjective";
            const selectedAnswer = subjective ? String(chosen[questionDoc.id] || "") : (Number.isInteger(chosen[questionDoc.id]) ? chosen[questionDoc.id] : null);
            const correctAnswer = Number.isInteger(answer.answer) ? answer.answer : null;
            const grade = grades[questionDoc.id] || null;
            return {
              questionId: questionDoc.id, question: question.text || "", options: question.options || [],
              type: subjective ? "subjective" : "objective", marks: Number(question.marks || answer.marks || 1),
              awardedMarks: grade ? Number(grade.marks || 0) : (subjective ? null : (selectedAnswer !== null && selectedAnswer === correctAnswer ? Number(answer.marks || 1) : 0)),
              modelAnswer: answer.modelAnswer || "", topic: question.topic || q.data().subject || "General",
              difficulty: question.difficulty || "medium", selectedAnswer, correctAnswer,
              isCorrect: subjective ? null : selectedAnswer !== null && selectedAnswer === correctAnswer,
              explanation: answer.explanation || ""
            };
          });
        }
        results.push({
          quizId: q.id, title: q.data().title, released,
          ...(released ? { score: data.score, total: data.total, pendingReview: data.pendingReview || 0, review } : {}),
          releaseAt: resultRelease.toDate().toISOString()
        });
      }
      return { results };
    }
    case "getContentDownload": {
      const id = String(d.id || "").trim();
      if (!id) fail("invalid-argument", "Content ID missing.");
      const snap = await db.doc("content/" + id).get();
      if (!snap.exists) fail("not-found", "Content नहीं मिला।");
      const item = snap.data();
      if (item.published !== true) {
        await requireAdmin(req);
      }
      if (!item.storagePath) {
        if (/^https?:\/\//i.test(String(item.url || ""))) return { url: item.url, external: true };
        fail("not-found", "इस सामग्री की फ़ाइल उपलब्ध नहीं है।");
      }
      let objectPath = String(item.storagePath);
      if (objectPath.startsWith("learning/" + id + "/")) objectPath = objectPath.slice("learning/".length);
      if (!objectPath.startsWith(id + "/")) fail("invalid-argument", "Storage path मान्य नहीं है।");
      const signed = await supabaseStorageRequest("/object/sign/" + encodeURIComponent(storageBucket) + "/" + storagePathUrl(objectPath), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiresIn: 300 })
      });
      const relative = signed.signedURL || signed.signedUrl;
      if (!relative) fail("internal", "Secure download link नहीं बन सका।");
      const base = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
      const url = /^https?:\/\//i.test(relative) ? relative :
        (relative.startsWith("/storage/v1/") ? base + relative : base + "/storage/v1" + (relative.startsWith("/") ? relative : "/" + relative));
      return { url, expiresIn: 300 };
    }
    case "addContent": {
      await requireAdmin(req);
      if (!String(d.title || "").trim() || (!d.storagePath && !/^https?:\/\//i.test(String(d.url || "")))) fail("invalid-argument", "Title और valid file link जरूरी है।");
      const contentId = String(d.id || "").trim();
      if (d.storagePath && (!contentId || !String(d.storagePath).startsWith(contentId + "/"))) fail("invalid-argument", "Storage path मान्य नहीं है।");
      const ref = contentId ? db.collection("content").doc(contentId) : db.collection("content").doc();
      await ref.set({
        title: String(d.title).trim(), subject: String(d.subject || "General"),
        type: String(d.type || "note"), description: String(d.description || ""),
        url: String(d.url), storagePath: String(d.storagePath || ""), published: d.published !== false,
        createdBy: uid, createdAt: FieldValue.serverTimestamp()
      });
      return { id: ref.id };
    }
    case "deleteContent": {
      await requireAdmin(req);
      const id = String(d.id || "").trim();
      if (!id) fail("invalid-argument", "Content ID missing.");
      const ref = db.doc("content/" + id), snap = await ref.get();
      if (!snap.exists) return { ok: true, alreadyDeleted: true };
      const path = String(snap.data().storagePath || "");
      if (path) {
        const objectPath = path.startsWith("learning/" + id + "/") ? path.slice("learning/".length) : path;
        if (!objectPath.startsWith(id + "/")) fail("invalid-argument", "Storage path मान्य नहीं है; सुरक्षा के लिए delete रोका गया।");
        await deleteStorageObject(objectPath);
      }
      await ref.delete();
      return { ok: true };
    }
    case "createNotice": {
      await requireTeacher(req);
      const id = String(d.id || "").trim(), title = String(d.title || "").trim().slice(0,140);
      const body = String(d.body || "").trim().slice(0,5000), mediaPath = String(d.mediaPath || "").trim();
      const mediaType = ["image","video"].includes(d.mediaType) ? d.mediaType : "";
      if (!/^[A-Za-z0-9_-]{10,100}$/.test(id) || (!title && !body && !mediaPath)) fail("invalid-argument", "Notice में text, photo या video जोड़ें।");
      if (mediaPath && (!mediaPath.startsWith("notices/" + id + "/") || !mediaType)) fail("invalid-argument", "Notice media path मान्य नहीं है।");
      await db.doc("notices/" + id).set({ title, body, mediaPath, mediaType, createdBy: uid,
        createdAt: FieldValue.serverTimestamp(), expiresAt: Timestamp.fromMillis(Date.now()+30*24*60*60*1000) });
      return { id, expiresAt: new Date(Date.now()+30*24*60*60*1000).toISOString() };
    }
    case "listNotices": {
      const snap = await db.collection("notices").orderBy("createdAt","desc").limit(100).get();
      const cutoff = Date.now()-30*24*60*60*1000, notices=[];
      for (const item of snap.docs) {
        const value=item.data(), created=value.createdAt?.toMillis?.()||0;
        if (!created || created<cutoff) continue;
        let mediaUrl="";
        if(value.mediaPath){try{mediaUrl=await signedStorageUrl(value.mediaPath,3600)}catch(e){console.error("Notice media signing failed:",e.message)}}
        const role=await roleOf(uid);
        notices.push({id:item.id,title:value.title||"",body:value.body||"",mediaType:value.mediaType||"",mediaUrl,
          createdAt:value.createdAt?.toDate?.().toISOString()||null,expiresAt:value.expiresAt?.toDate?.().toISOString()||null,
          canDelete:value.createdBy===uid||["admin","superadmin"].includes(role)});
      }
      return { notices };
    }
    case "deleteNotice": {
      await requireTeacher(req);
      const id=String(d.id||"").trim();
      if(!id) fail("invalid-argument","Notice ID missing.");
      const ref=db.doc("notices/"+id), snap=await ref.get();
      if(!snap.exists) return {ok:true,alreadyDeleted:true};
      const role=await roleOf(uid);
      if(snap.data().createdBy!==uid&&!["admin","superadmin"].includes(role)) fail("permission-denied","केवल Notice बनाने वाला Teacher या Admin इसे हटा सकता है।");
      const path=String(snap.data().mediaPath||"");
      if(path){if(!path.startsWith("notices/"+id+"/"))fail("invalid-argument","Notice media path मान्य नहीं है।");await deleteStorageObject(path)}
      await ref.delete();
      return {ok:true};
    }
    case "setContentPublished": {
      await requireAdmin(req);
      const id = String(d.id || "");
      if (!id) fail("invalid-argument", "Content ID missing.");
      const published = d.published === true;
      const ref = db.doc("content/" + id);
      const snap = await ref.get();
      if (!snap.exists) fail("not-found", "Content नहीं मिला।");
      await ref.update({ published, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
      return { ok: true, published };
    }
    case "listStudents": {
      await requireAdmin(req);
      const snap = await db.collection("roles").where("role", "==", "student").limit(500).get();
      return { students: snap.docs.map(x => ({ uid: x.id, email: x.data().email || "", displayName: x.data().displayName || "", className: x.data().className || "" })) };
    }
    case "assignTeacher": {
      await requireAdmin(req);
      const email = String(d.email || "").trim().toLowerCase();
      const subjects = Array.isArray(d.subjects) ? [...new Set(d.subjects.map(x => String(x).trim()).filter(Boolean))].slice(0,30) : [];
      const classes = Array.isArray(d.classes) ? [...new Set(d.classes.map(x => String(x).trim()).filter(Boolean))].slice(0,30) : [];
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !subjects.length || !classes.length) fail("invalid-argument", "Teacher का registered email, कम-से-कम एक subject और assigned class देना जरूरी है।");
      let target;
      try { target = await auth.getUserByEmail(email); } catch { fail("not-found", "पहले इस email से Teacher account बनवाएँ।"); }
      const targetRole = await roleOf(target.uid);
      if (["admin", "superadmin"].includes(targetRole)) fail("failed-precondition", "Admin या Super Admin को Teacher में नहीं बदला जा सकता।");
      await setRole(target.uid, "teacher", { assignedBy: uid });
      await db.doc("teacherAssignments/" + target.uid).set({ subjects, classes, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid }, { merge: true });
      return { ok: true, uid: target.uid, subjects, classes };
    }
    case "createDoubt": {
      if (await roleOf(uid) !== "student") fail("permission-denied", "केवल Student Teacher को Doubt भेज सकता है।");
      const question = String(d.question || "").trim();
      const subject = String(d.subject || "").trim();
      const requestId = String(d.requestId || "");
      if (!/^[A-Za-z0-9_-]{12,100}$/.test(requestId)) fail("invalid-argument", "Doubt request ID मान्य नहीं है।");
      if (!question || question.length > 5000 || !subject) fail("invalid-argument", "Subject और doubt लिखें (अधिकतम 5000 अक्षर)।");
      const profileSnap = await db.doc("roles/" + uid).get();
      const studentName = profileSnap.exists ? (profileSnap.data().displayName || req.user.name || req.user.email || "Student") : (req.user.name || req.user.email || "Student");
      const ref = db.collection("doubts").doc(uid + "_" + requestId);
      await db.runTransaction(async tx => {
        const existing = await tx.get(ref);
        if (existing.exists) return;
        tx.create(ref, {
          uid, studentName, studentClass: profileSnap.exists ? (profileSnap.data().className || "") : "",
          subject, topic: String(d.topic || "").trim(), question,
          status: "open", createdAt: FieldValue.serverTimestamp()
        });
      });
      return { id: ref.id };
    }
    case "listDoubts": {
      const role = await roleOf(uid);
      let snap;
      if (role === "student") snap = await db.collection("doubts").where("uid", "==", uid).limit(100).get();
      else if (["teacher","admin","superadmin"].includes(role)) {
        let subjects = [], classes = [];
        if (role === "teacher") {
          const a = await db.doc("teacherAssignments/" + uid).get();
          subjects = a.exists ? (a.data().subjects || []) : [];
          classes = a.exists ? (a.data().classes || []) : [];
          if (!subjects.length || !classes.length) return { doubts: [] };
        }
        snap = await db.collection("doubts").limit(300).get();
        if (role === "teacher") snap = { docs: snap.docs.filter(x =>
          subjects.some(v => String(v).toLowerCase() === String(x.data().subject).toLowerCase()) &&
          classes.some(v => normalizeClassName(v) === normalizeClassName(x.data().studentClass))
        ) };
      } else fail("permission-denied", "Access denied.");
      return { doubts: snap.docs.map(x => ({ id:x.id, ...x.data(), createdAt:x.data().createdAt?.toDate().toISOString() || null })) };
    }
    case "replyDoubt": {
      const ref = db.doc("doubts/" + String(d.id || ""));
      const snap = await ref.get();
      if (!snap.exists) fail("not-found", "Doubt नहीं मिला।");
      await requireTeacher(req, snap.data().subject, snap.data().studentClass);
      const reply = String(d.reply || "").trim();
      if (!reply || reply.length > 5000) fail("invalid-argument", "Reply 1 से 5000 अक्षर का होना चाहिए।");
      await ref.update({ reply, repliedBy: uid, repliedAt: FieldValue.serverTimestamp(), status: "answered" });
      return { ok: true };
    }
    case "listTeacherStudents": {
      await requireTeacher(req);
      const currentRole = await roleOf(uid);
      const snap = await db.collection("roles").where("role","==","student").limit(500).get();
      if (["admin", "superadmin"].includes(currentRole)) {
        return { students: snap.docs.map(x=>({uid:x.id,email:x.data().email||"",displayName:x.data().displayName||"",className:x.data().className||""})), assignedClasses: [] };
      }
      const assignment = await db.doc("teacherAssignments/" + uid).get();
      const assignedClasses = assignment.exists ? (assignment.data().classes || []) : [];
      if (!assignedClasses.length) return { students: [], assignedClasses: [] };
      const allowed = new Set(assignedClasses.map(normalizeClassName));
      const students = snap.docs.filter(x => allowed.has(normalizeClassName(x.data().className)))
        .map(x=>({uid:x.id,email:x.data().email||"",displayName:x.data().displayName||"",className:x.data().className||""}));
      return { students, assignedClasses };
    }
    case "listSubjectiveSubmissions": {
      const role = await roleOf(uid);
      if (!["teacher","admin","superadmin"].includes(role)) fail("permission-denied", "केवल Teacher या Admin उपयोग कर सकता है।");
      let subjects = [], classes = [];
      if (role === "teacher") {
        const assigned = await db.doc("teacherAssignments/" + uid).get();
        subjects = assigned.exists ? (assigned.data().subjects || []) : [];
        classes = assigned.exists ? (assigned.data().classes || []) : [];
        if (!subjects.length || !classes.length) return { submissions: [], quizCursor: null, hasMoreQuizzes: false };
      }
      const pageSize = Math.min(25, Math.max(5, Number(d.limit) || 20));
      const quizDocs = [];
      let quizCursor = null, hasMoreQuizzes = false;
      if (d.quizId) {
        const q = await db.doc("quizzes/" + String(d.quizId)).get();
        if (q.exists) quizDocs.push(q);
      } else {
        let q = db.collection("quizzes").orderBy(FieldPath.documentId()).limit(pageSize + 1);
        if (d.cursor) {
          const cursorDoc = await db.doc("quizzes/" + String(d.cursor)).get();
          if (cursorDoc.exists) q = q.startAfter(cursorDoc);
        }
        const snap = await q.get();
        hasMoreQuizzes = snap.docs.length > pageSize;
        quizDocs.push(...snap.docs.slice(0, pageSize));
        if (quizDocs.length) quizCursor = quizDocs[quizDocs.length - 1].id;
      }
      const items = [];
      for (const quizDoc of quizDocs) {
        const quiz = quizDoc.data();
        if (role === "teacher" && (!subjects.some(v => String(v).toLowerCase() === String(quiz.subject || "").toLowerCase()) ||
          !classes.some(v => normalizeClassName(v) === normalizeClassName(quiz.className)))) continue;
        const pageAttempts = Math.min(50, Math.max(5, Number(d.attemptLimit) || 25));
        let attemptsQuery = quizDoc.ref.collection("attempts").where("status","==","submitted").orderBy(FieldPath.documentId()).limit(pageAttempts + 1);
        if (d.quizId && d.attemptCursor) {
          const cursorAttempt = await quizDoc.ref.collection("attempts").doc(String(d.attemptCursor)).get();
          if (cursorAttempt.exists) attemptsQuery = attemptsQuery.startAfter(cursorAttempt);
        }
        const attemptsSnap = await attemptsQuery.get();
        const hasMoreAttempts = attemptsSnap.docs.length > pageAttempts;
        const attemptDocs = attemptsSnap.docs.slice(0, pageAttempts);
        const [questions, answers] = await Promise.all([
          quizDoc.ref.collection("publicQuestions").orderBy("index").get(),
          quizDoc.ref.collection("privateAnswers").get()
        ]);
        const answerMap = new Map(answers.docs.map(x=>[x.id,x.data()]));
        for (const attemptDoc of attemptDocs) {
          const attempt = attemptDoc.data(), grades = attempt.grades || {};
          const reviewed = questions.docs.filter(x=>{
            const a=answerMap.get(x.id)||{};
            return (x.data().type==="subjective"||a.type==="subjective") && String((attempt.answers||{})[x.id]||"").trim();
          }).map(x=>{
            const grade=grades[x.id]||null, a=answerMap.get(x.id)||{};
            return {questionId:x.id,question:x.data().text,studentAnswer:String((attempt.answers||{})[x.id]||""),maxMarks:Number(x.data().marks||1),modelAnswer:a.modelAnswer||"",graded:Boolean(grade),awardedMarks:grade?Number(grade.marks||0):null,feedback:grade?.feedback||""};
          });
          if (reviewed.length) {
            let studentName="Student";
            try { const u=await auth.getUser(attempt.uid); studentName=u.displayName||u.email||studentName; } catch {}
            items.push({quizId:quizDoc.id,quizTitle:quiz.title,subject:quiz.subject,topic:quiz.topic||"",uid:attempt.uid,studentName,questions:reviewed,hasMoreAttempts,attemptCursor:attemptDocs.length?attemptDocs[attemptDocs.length-1].id:null});
          }
        }
        if (d.quizId) return { submissions: items, hasMoreAttempts, attemptCursor: attemptDocs.length ? attemptDocs[attemptDocs.length-1].id : null, quizCursor: null, hasMoreQuizzes: false };
      }
      return { submissions: items, quizCursor, hasMoreQuizzes };
    }
    case "gradeSubjective": {
      const quizId = String(d.quizId || ""), attemptUid = String(d.uid || ""), questionId = String(d.questionId || "");
      const marks = Number(d.marks);
      const quizRef = db.doc("quizzes/" + quizId), quizSnap = await quizRef.get();
      if (!quizSnap.exists) fail("not-found", "Quiz नहीं मिला।");
      await requireTeacher(req, quizSnap.data().subject, quizSnap.data().className);
      const maxSnap = await quizRef.collection("privateAnswers").doc(questionId).get();
      if (!maxSnap.exists || maxSnap.data().type !== "subjective") fail("invalid-argument", "Subjective question नहीं मिला।");
      if (!Number.isFinite(marks) || marks < 0 || marks > Number(maxSnap.data().marks || 1)) fail("invalid-argument", "दिए गए अंक प्रश्न के अधिकतम अंकों के भीतर रखें।");
      const attemptRef = quizRef.collection("attempts").doc(attemptUid);
      const attemptSnap = await attemptRef.get();
      if (!attemptSnap.exists || attemptSnap.data().status !== "submitted") fail("not-found", "Submitted attempt नहीं मिला।");
      const attemptData = attemptSnap.data();
      if (!String((attemptData.answers || {})[questionId] || "").trim()) fail("failed-precondition", "इस प्रश्न का कोई उत्तर जमा नहीं हुआ है।");
      const grades = attemptData.grades || {};
      const previousGrade = grades[questionId] || null;
      const feedback = String(d.feedback || "").trim().slice(0, 2000);
      const history = Array.isArray(attemptData.gradeHistory) ? attemptData.gradeHistory : [];
      if (previousGrade) history.push({ questionId, previousMarks: Number(previousGrade.marks || 0), newMarks: marks, changedBy: uid, changedAt: new Date().toISOString() });
      grades[questionId] = { marks, feedback, gradedBy: uid, gradedAt: new Date().toISOString() };
      const allAnswers = await quizRef.collection("privateAnswers").get();
      let pendingReview = 0;
      allAnswers.forEach(x => {
        if (x.data().type === "subjective" && String((attemptData.answers || {})[x.id] || "").trim() && !grades[x.id]) pendingReview++;
      });
      let subjectiveScore = 0;
      Object.values(grades).forEach(x => { subjectiveScore += Number(x.marks || 0); });
      const finalScore = Number(attemptData.objectiveScore || 0) + subjectiveScore;
      await attemptRef.update({ grades, gradeHistory: history.slice(-100), pendingReview, subjectiveScore, finalScore });
      await quizRef.collection("leaderboard").doc(attemptUid).update({ score: finalScore, subjectiveScore, pendingReview });
      return { ok: true, updated: Boolean(previousGrade), pendingReview, score: finalScore, subjectiveScore };
    }

    case "aiTutorChat": {
      const currentRole = await roleOf(uid);
      if (!["student","admin","superadmin"].includes(currentRole)) fail("permission-denied","AI Study Chat केवल Student और Admin के लिए उपलब्ध है।");
      const apiKey = String(process.env.GEMINI_API_KEY || "").trim();
      if (!apiKey) fail("failed-precondition","Gemini API Key Render में उपलब्ध नहीं है।");
      const profileSnap = await db.doc("roles/" + uid).get();
      const profile = profileSnap.exists ? profileSnap.data() : {};
      const student = currentRole === "student";
      const className = student ? String(profile.className || "").trim() : String(d.className || "").trim();
      const subject = String(d.subject || "सामान्य पढ़ाई").trim().slice(0,80);
      const topic = String(d.topic || ("कक्षा " + className + " का पाठ्यक्रम")).trim().slice(0,160);
      const question = String(d.question || "").trim().slice(0,3000);
      const history = Array.isArray(d.history) ? d.history.slice(-8).map(x => ({
        role: x.role === "model" ? "model" : "user",
        parts: [{ text: String(x.text || "").slice(0,1500) }]
      })).filter(x => x.parts[0].text) : [];
      if (student && !className) fail("failed-precondition","पहले Student Profile में अपनी कक्षा भरें।");
      if (!question) fail("invalid-argument","अपना पढ़ाई से जुड़ा सवाल लिखें।");
      const prompt = [
        "You are EduFuture Study Tutor for a school student in India.",
        "Answer school-learning and academic questions suitable for the declared class across school subjects. The student does not need to choose a subject or chapter.",
        "If the request is unrelated to studies, politely say you can only help with school learning and invite a study question.",
        "Use very simple everyday Hindi suitable for the declared class. Prefer familiar school textbook terms used in Bihar/NCERT books. Avoid difficult, artificial or machine-translated Hindi. Explain every new term in one short sentence.",
        "Keep the answer clear and not unnecessarily long. Use short headings, numbered steps and one simple example. For maths, show the standard school-book formula first, then substitute values step by step. End with one short practice question.",
        "Do not invent textbook page numbers, board syllabus claims, citations or facts. If unsure, clearly say so.",
        "For mathematics, preserve exact mathematical notation. Write inline formulas as \\( ... \\) and display formulas as \\[ ... \\]. Use standard LaTeX commands such as \\frac{a}{b}, \\sqrt{x}, x^2, \\times, \\div, \\le and \\ge; never replace formulas with vague words or malformed symbols.",
        "Do not ask for personal information. Avoid adult, dangerous or harmful content.",
        "Student class: " + className,
        "Latest student question: " + question
      ].join("\n");
      const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=" + encodeURIComponent(apiKey);
      const contents = [...history, { role:"user", parts:[{text:prompt}] }];
      const response = await geminiHttpsRequest(endpoint, JSON.stringify({
        contents, generationConfig:{maxOutputTokens:1400,temperature:0.35}
      }), 90000);
      let payload={};try{payload=JSON.parse(response.raw||"{}")}catch{}
      if(!response.ok){
        const error=new Error(payload.error?.message||"AI Tutor अभी जवाब नहीं दे पाया।");
        error.code=response.status===429?"resource-exhausted":[500,502,503,504].includes(response.status)?"unavailable":"failed-precondition";
        throw error;
      }
      const answer=String(payload.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join("")||"").trim();
      if(!answer)fail("unavailable","AI Tutor से खाली जवाब मिला। फिर कोशिश करें।");
      return {answer,className,subject,topic};
    }
    case "generateAiNotes": {
      await requireAdmin(req);
      const apiKey = String(process.env.GEMINI_API_KEY || "").trim();
      if (!apiKey) fail("failed-precondition","Gemini API Key Render में उपलब्ध नहीं है।");
      const className=String(d.className||"").trim().slice(0,40);
      const subject=String(d.subject||"").trim().slice(0,80);
      const topic=String(d.topic||"").trim().slice(0,160);
      const command=String(d.command||"").trim().slice(0,2500);
      const language=["Hindi","English","Bilingual"].includes(d.language)?d.language:"Hindi";
      const level=["Short Revision","Detailed Notes","Exam Preparation"].includes(d.level)?d.level:"Detailed Notes";
      if(!className||!subject||!topic||!command)fail("invalid-argument","Class, Subject, Topic और Admin Command भरना जरूरी है।");
      const prompt=[
        "Create original, accurate school study notes for an Indian school learner.",
        "Class: "+className,"Subject: "+subject,"Chapter/topic: "+topic,
        "Language: "+language,"Depth: "+level,
        "Admin's exact instruction: "+command,
        "Use a clear title, learning objectives, well-organized headings, definitions, explanations, worked examples where appropriate, key points, a short summary and 5 revision questions with answers.",
        "Keep the level appropriate to the declared class. Stay focused on the requested subject and chapter. Never invent board-specific textbook references or page numbers. If an instruction asks for unsupported facts, mark uncertainty rather than fabricate.",
        "Write in very simple, natural school-level Hindi. Use the exact familiar Hindi terms from school textbooks; do not invent translations. Explain hard words in brackets. For mathematics, use standard LaTeX notation: inline $x^2$, fractions $\\frac{a}{b}$, roots $\\sqrt{x}$, and display equations between $ ... $. Include a worked example with each important formula. Keep paragraphs short. Do not include HTML, scripts, fake citations or fabricated textbook page numbers."
      ].join("\n");
      const endpoint="https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key="+encodeURIComponent(apiKey);
      const response=await geminiHttpsRequest(endpoint,JSON.stringify({
        contents:[{role:"user",parts:[{text:prompt}]}],
        generationConfig:{maxOutputTokens:7000,temperature:0.3}
      }),120000);
      let payload={};try{payload=JSON.parse(response.raw||"{}")}catch{}
      if(!response.ok){
        const error=new Error(payload.error?.message||"AI Notes generate नहीं हो सके।");
        error.code=response.status===429?"resource-exhausted":[500,502,503,504].includes(response.status)?"unavailable":"failed-precondition";
        throw error;
      }
      const content=String(payload.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join("")||"").trim();
      if(!content)fail("unavailable","AI Notes का उत्तर खाली आया। फिर कोशिश करें।");
      const ref=db.collection("aiNotes").doc();
      await ref.set({className,subject,topic,command,language,level,content,createdBy:uid,createdAt:FieldValue.serverTimestamp()});
      return {id:ref.id,className,subject,topic,content};
    }
    case "listAiNotes": {
      await requireAdmin(req);
      const snap=await db.collection("aiNotes").orderBy("createdAt","desc").limit(30).get();
      return {notes:snap.docs.map(x=>({id:x.id,...x.data(),createdAt:x.data().createdAt?.toDate?.().toISOString?.()||null}))};
    }
    case "publishAiNote": {
      await requireAdmin(req);
      const id=String(d.id||"").trim();
      const published=d.published===true;
      if(!id||id.length>128)fail("invalid-argument","Notes ID मान्य नहीं है।");
      const ref=db.doc("aiNotes/"+id),snap=await ref.get();
      if(!snap.exists)fail("not-found","AI Notes नहीं मिले।");
      await ref.update({published,publishedAt:published?FieldValue.serverTimestamp():null,updatedAt:FieldValue.serverTimestamp()});
      return {ok:true,id,published};
    }
    case "listPublishedAiNotes": {
      const currentRole=await roleOf(uid);
      if(!["student","admin","superadmin","teacher"].includes(currentRole))fail("permission-denied","Login जरूरी है।");
      const snap=await db.collection("aiNotes").where("published","==",true).orderBy("publishedAt","desc").limit(50).get();
      const profileSnap=await db.doc("roles/"+uid).get(),profile=profileSnap.exists?profileSnap.data():{};
      const studentClass=String(profile.className||"").toLowerCase().replace(/^(class|कक्षा)\\s*/i,"").trim();
      const notes=snap.docs.map(x=>({id:x.id,...x.data(),createdAt:x.data().createdAt?.toDate?.().toISOString?.()||null})).filter(n=>{
        if(currentRole!=="student")return true;
        const noteClass=String(n.className||"").toLowerCase().replace(/^(class|कक्षा)\\s*/i,"").trim();
        return !studentClass||!noteClass||studentClass===noteClass;
      });
      return {notes};
    }
    case "deleteAiNote": {
      await requireAdmin(req);
      const id=String(d.id||"").trim();
      if(!id||id.length>128)fail("invalid-argument","Notes ID मान्य नहीं है।");
      const ref=db.doc("aiNotes/"+id);
      const snap=await ref.get();
      if(!snap.exists)fail("not-found","AI Notes नहीं मिले या पहले ही हटाए जा चुके हैं।");
      await ref.delete();
      return {ok:true,id};
    }
    case "generateQuestionDraft": {
      await requireAdmin(req);
      const apiKey = String(process.env.GEMINI_API_KEY || "").trim();
      if (!apiKey) fail("failed-precondition", "Gemini API Key अभी Render Environment में configure नहीं है।");
      const className = String(d.className || "").trim().slice(0, 40);
      const subject = String(d.subject || "").trim().slice(0, 80);
      const topic = String(d.topic || "").trim().slice(0, 160);
      const type = d.type === "subjective" ? "subjective" : "objective";
      const difficulty = ["easy","medium","hard"].includes(d.difficulty) ? d.difficulty : "medium";
      const count = Math.min(100, Math.max(10, Number(d.count) || 10));
      if (!className || !subject || !topic) fail("invalid-argument", "Class, Subject और Chapter/Topic भरना जरूरी है।");
      const model = "gemini-3.5-flash-lite";
      const prompt = [
        "Create exactly " + count + " original school-level practice questions.",
        "Class: " + className, "Subject: " + subject, "Chapter/topic: " + topic,
        "Difficulty: " + difficulty, "Question type: " + type,
        "Return ONLY a JSON array. Every item must have keys: text, options, answer, modelAnswer, explanation, marks, difficulty, topic. Include a meaningful explanation for every question and suitable marks.",
        type === "objective"
          ? "For each item, options must be exactly four short strings and answer must be a zero-based integer from 0 to 3. modelAnswer must be an empty string."
          : "For each item, options must be an empty array, answer must be null, modelAnswer must contain a correct reference answer, and explanation must clearly explain the answer step by step in simple Hindi so a teacher can use it while grading.",
        "Use clear age-appropriate Hindi. Do not include markdown fences. Ensure the answer is factually accurate."
      ].join("\n");
      const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(apiKey);
      const requestBody = JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", maxOutputTokens: 8192 }
      });
      let response, raw = "", payload = {};
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          response = await geminiHttpsRequest(endpoint, requestBody, 150000);
        } catch (error) {
          if (attempt === 0 && error.code !== "ETIMEDOUT" && error.code !== "RESPONSE_TOO_LARGE") {
            await new Promise(resolve => setTimeout(resolve, 700));
            continue;
          }
          const timeoutError = new Error(error.code === "ETIMEDOUT"
            ? "Gemini ने 150 सेकंड में जवाब नहीं दिया। कम प्रश्नों के साथ फिर कोशिश करें।"
            : "Gemini से सुरक्षित कनेक्शन नहीं बन पाया। थोड़ी देर बाद फिर कोशिश करें।");
          timeoutError.code = error.code === "ETIMEDOUT" ? "deadline-exceeded" : "unavailable";
          throw timeoutError;
        }
        raw = response.raw;
        payload = {};
        try { payload = raw ? JSON.parse(raw) : {}; } catch {}
        if (response.ok || ![429, 500, 502, 503, 504].includes(response.status) || attempt === 1) break;
        await new Promise(resolve => setTimeout(resolve, 700));
      }
      if (!response.ok) {
        const detail = payload.error?.message || "Gemini API request असफल रही (" + response.status + ").";
        const err = new Error(response.status === 503
          ? "Gemini अभी अधिक व्यस्त है। Retry के बाद भी उत्तर नहीं मिला। थोड़ी देर बाद फिर कोशिश करें।"
          : detail.slice(0, 500));
        err.code = response.status === 429 ? "resource-exhausted"
          : [500, 502, 503, 504].includes(response.status) ? "unavailable"
          : response.status === 400 ? "invalid-argument" : "failed-precondition";
        throw err;
      }
      const generatedText = payload.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
      let generated;
      try { generated = JSON.parse(generatedText); } catch { fail("internal", "AI का उत्तर सही JSON में नहीं आया। फिर से कोशिश करें।"); }
      if (!Array.isArray(generated) || generated.length !== count) fail("internal", "AI ने अपेक्षित संख्या में प्रश्न नहीं बनाए। फिर से कोशिश करें।");
      const batch = db.batch();
      const drafts = [];
      generated.forEach((q, index) => {
        const text = String(q.text || "").trim().slice(0, 3000);
        const options = type === "objective" && Array.isArray(q.options) ? q.options.slice(0,4).map(x => String(x || "").trim().slice(0,500)) : [];
        const answer = type === "objective" ? Number(q.answer) : null;
        if (!text || (type === "objective" && (options.length !== 4 || options.some(x => !x) || !Number.isInteger(answer) || answer < 0 || answer > 3))) {
          fail("internal", "AI से मिला प्रश्न " + (index + 1) + " जाँच में असफल रहा। दोबारा Generate करें।");
        }
        const ref = db.collection("aiQuestionDrafts").doc();
        const draft = {
          className, subject, topic, type, difficulty,
          text, options, answer,
          modelAnswer: type === "subjective" ? String(q.modelAnswer || "").trim().slice(0,5000) : "",
          explanation: String(q.explanation || (type === "subjective" ? "उत्तर की व्याख्या: " + String(q.modelAnswer || "").trim() : "")).trim().slice(0,2000),
          marks: Math.min(20, Math.max(1, Number(q.marks) || (type === "subjective" ? 5 : 1))),
          status: "pending", createdBy: uid, createdAt: FieldValue.serverTimestamp()
        };
        batch.set(ref, draft);
        drafts.push({ id: ref.id, ...draft, createdAt: null });
      });
      await batch.commit();
      return { drafts };
    }
    case "listQuestionDrafts": {
      await requireAdmin(req);
      const snap = await db.collection("aiQuestionDrafts").orderBy("createdAt", "desc").limit(100).get();
      return { drafts: snap.docs.map(x => ({ id: x.id, ...x.data(), createdAt: x.data().createdAt?.toDate?.().toISOString?.() || null })) };
    }
    case "listQuestionBank": {
      await requireAdmin(req);
      const snap = await db.collection("questionBank").where("status", "==", "approved").limit(100).get();
      const questions = snap.docs.map(x => ({ id: x.id, ...x.data(), approvedAt: x.data().approvedAt?.toDate?.().toISOString?.() || null }));
      questions.sort((a, b) => String(b.approvedAt || "").localeCompare(String(a.approvedAt || "")));
      return { questions };
    }
    case "reviewQuestionDraft": {
      await requireAdmin(req);
      const id = String(d.id || "");
      const decision = ["approve","reject","saveDraft"].includes(d.decision) ? d.decision : "";
      if (!id || !decision) fail("invalid-argument", "Draft और review action जरूरी हैं।");
      const ref = db.doc("aiQuestionDrafts/" + id);
      const snap = await ref.get();
      if (!snap.exists || snap.data().status !== "pending") fail("not-found", "यह pending AI draft नहीं मिला।");
      if (decision === "reject") {
        await ref.update({ status: "rejected", reviewedBy: uid, reviewedAt: FieldValue.serverTimestamp() });
        return { ok: true, status: "rejected" };
      }
      const original = snap.data();
      if (decision === "saveDraft") {
        const edited = d.question && typeof d.question === "object" ? d.question : {};
        const text = String(edited.text ?? original.text).trim().slice(0,3000);
        const type = original.type === "subjective" ? "subjective" : "objective";
        const options = type === "objective" ? (Array.isArray(edited.options) ? edited.options : original.options).slice(0,4).map(x=>String(x||"").trim().slice(0,500)) : [];
        const answer = type === "objective" ? Number(edited.answer ?? original.answer) : null;
        const modelAnswer = type === "subjective" ? String(edited.modelAnswer ?? original.modelAnswer ?? "").trim().slice(0,5000) : "";
        const explanation = String(edited.explanation ?? original.explanation ?? "").trim().slice(0,2000);
        const marks = Math.min(20,Math.max(1,Number(edited.marks ?? original.marks)||1));
        if (!text || (type === "objective" && (options.length !== 4 || options.some(x=>!x) || !Number.isInteger(answer) || answer<0 || answer>3))) fail("invalid-argument", "प्रश्न, चारों विकल्प और सही उत्तर जाँचें।");
        if (type === "subjective" && (!modelAnswer || !explanation)) fail("invalid-argument", "Subjective प्रश्न का Model Answer और Explanation जरूरी है।");
        await ref.update({ text, options, answer, modelAnswer, explanation, marks, status:"draft", savedAsDraftBy:uid, savedAsDraftAt:FieldValue.serverTimestamp() });
        return { ok:true, status:"draft" };
      }
      const edited = d.question && typeof d.question === "object" ? d.question : {};
      const text = String(edited.text ?? original.text).trim().slice(0,3000);
      const type = original.type === "subjective" ? "subjective" : "objective";
      const options = type === "objective" ? (Array.isArray(edited.options) ? edited.options : original.options).slice(0,4).map(x=>String(x||"").trim().slice(0,500)) : [];
      const answer = type === "objective" ? Number(edited.answer ?? original.answer) : null;
      const modelAnswer = type === "subjective" ? String(edited.modelAnswer ?? original.modelAnswer ?? "").trim().slice(0,5000) : "";
      if (!text || (type === "objective" && (options.length !== 4 || options.some(x=>!x) || !Number.isInteger(answer) || answer<0 || answer>3))) fail("invalid-argument", "Approve करने से पहले प्रश्न, चारों विकल्प और सही उत्तर जाँचें।");
      if (type === "subjective" && !modelAnswer) fail("invalid-argument", "Subjective प्रश्न का Model Answer भरें।");
      const bankRef = db.collection("questionBank").doc();
      const bankQuestion = {
        className: original.className, subject: original.subject, topic: original.topic,
        type, difficulty: original.difficulty, text, options, answer, modelAnswer,
        explanation: String(edited.explanation ?? original.explanation ?? "").trim().slice(0,2000),
        marks: Math.min(20,Math.max(1,Number(edited.marks ?? original.marks)||1)),
        status: "approved", source: "gemini", sourceDraftId: id,
        createdBy: original.createdBy, approvedBy: uid,
        createdAt: FieldValue.serverTimestamp(), approvedAt: FieldValue.serverTimestamp()
      };
      await db.runTransaction(async tx => {
        const current = await tx.get(ref);
        if (!current.exists || current.data().status !== "pending") fail("already-exists", "इस Draft की review पहले हो चुकी है।");
        tx.create(bankRef, bankQuestion);
        tx.update(ref, { status: "approved", reviewedBy: uid, reviewedAt: FieldValue.serverTimestamp(), questionBankId: bankRef.id, reviewedQuestion: { text, options, answer, modelAnswer, explanation: bankQuestion.explanation, marks: bankQuestion.marks } });
      });
      return { ok: true, status: "approved", questionBankId: bankRef.id };
    }
    case "setQuestionDraftStatus": {
      await requireAdmin(req);
      const ids = Array.isArray(d.ids) ? [...new Set(d.ids.map(x=>String(x||"").trim()).filter(Boolean))].slice(0,100) : [];
      const status = String(d.status || "");
      if (!ids.length || !["published"].includes(status)) fail("invalid-argument", "Draft IDs और valid status जरूरी हैं।");
      const batch = db.batch();
      for (const id of ids) {
        const ref = db.doc("aiQuestionDrafts/" + id);
        const snap = await ref.get();
        if (!snap.exists || snap.data().status !== "draft") fail("failed-precondition", "चुने गए Draft में से कोई Draft अब उपलब्ध नहीं है।");
        batch.update(ref, { status, publishedBy:uid, publishedAt:FieldValue.serverTimestamp() });
      }
      await batch.commit();
      return { ok:true, updated:ids.length };
    }
    case "deleteQuestionDraft": {
      await requireAdmin(req);
      const id = String(d.id || "").trim();
      if (!id) fail("invalid-argument", "Draft ID जरूरी है।");
      const ref = db.doc("aiQuestionDrafts/" + id), snap = await ref.get();
      if (!snap.exists || !["pending","draft","rejected"].includes(snap.data().status)) fail("not-found", "यह Draft हटाने योग्य नहीं मिला।");
      await ref.delete();
      return { ok:true };
    }
    case "deleteQuestionBankQuestion": {
      await requireAdmin(req);
      const id = String(d.id || "").trim();
      if (!id) fail("invalid-argument", "Question ID जरूरी है।");
      const ref = db.doc("questionBank/" + id), snap = await ref.get();
      if (!snap.exists || snap.data().status !== "approved") fail("not-found", "Approved प्रश्न नहीं मिला।");
      await ref.delete();
      return { ok:true };
    }
    case "updateQuestionBankQuestion": {
      await requireAdmin(req);
      const id = String(d.id || "").trim();
      if (!id) fail("invalid-argument", "Question ID जरूरी है।");
      const ref = db.doc("questionBank/" + id), snap = await ref.get();
      if (!snap.exists || snap.data().status !== "approved") fail("not-found", "Approved प्रश्न नहीं मिला।");
      const original = snap.data(), edited = d.question && typeof d.question === "object" ? d.question : {};
      const text = String(edited.text ?? original.text).trim().slice(0,3000);
      const type = original.type === "subjective" ? "subjective" : "objective";
      const options = type === "objective" ? (Array.isArray(edited.options) ? edited.options : original.options).slice(0,4).map(x=>String(x||"").trim().slice(0,500)) : [];
      const answer = type === "objective" ? Number(edited.answer ?? original.answer) : null;
      const modelAnswer = type === "subjective" ? String(edited.modelAnswer ?? original.modelAnswer ?? "").trim().slice(0,5000) : "";
      if (!text || (type === "objective" && (options.length !== 4 || options.some(x=>!x) || !Number.isInteger(answer) || answer<0 || answer>3))) fail("invalid-argument", "प्रश्न, चारों विकल्प और सही उत्तर जाँचें।");
      if (type === "subjective" && !modelAnswer) fail("invalid-argument", "Subjective प्रश्न का Model Answer जरूरी है।");
      await ref.update({ text, options, answer, modelAnswer, topic: String(edited.topic ?? original.topic ?? "").trim().slice(0,160),
        explanation: String(edited.explanation ?? original.explanation ?? "").trim().slice(0,2000),
        marks: Math.min(20,Math.max(1,Number(edited.marks ?? original.marks)||1)), updatedBy: uid, updatedAt: FieldValue.serverTimestamp() });
      return { ok: true };
    }
    default:
      fail("not-found", "Unknown API action.");
  }
}

app.get("/health", (_req, res) => res.json({
  ok: true,
  service: "EduFuture API",
  integrations: {
    firebaseAdmin: true,
    supabaseStorage: process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY ? "configured" : "needs_server_key"
  }
}));
app.get("/health/storage", async (_req, res) => {
  try {
    await supabaseStorageRequest("/bucket/" + encodeURIComponent(storageBucket), { method: "GET" });
    return res.json({ ok: true, bucket: storageBucket, access: "private server-side" });
  } catch (error) {
    return res.status(503).json({
      ok: false,
      bucket: storageBucket,
      message: "Storage health check failed.",
      upstreamStatus: Number.isInteger(error.status) ? error.status : null,
      supabaseCode: error.supabaseCode || error.code || "unknown",
      detail: String(error.message || "Unknown Storage error").slice(0, 180)
    });
  }
});
app.post("/api/content-upload/:id",
  express.raw({ type: "application/octet-stream", limit: "30mb" }),
  authenticate,
  async (req, res) => {
    try {
      const contentId = String(req.params.id || "");
      if (!/^[A-Za-z0-9_-]{10,100}$/.test(contentId)) fail("invalid-argument", "Content ID मान्य नहीं है।");
      await requireAdmin(req);
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) fail("invalid-argument", "खाली फ़ाइल upload नहीं हो सकती।");
      if (req.body.length > 30 * 1024 * 1024) fail("invalid-argument", "फ़ाइल 30 MB से छोटी होनी चाहिए।");
      let originalName = String(req.get("X-File-Name") || "EduFuture-file");
      try { originalName = decodeURIComponent(originalName); } catch {}
      const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || "EduFuture-file";
      const ext = safeName.toLowerCase().split(".").pop();
      const mimeByExt = {
        pdf: "application/pdf", doc: "application/msword",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ppt: "application/vnd.ms-powerpoint",
        pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp"
      };
      const allowed = new Set(Object.values(mimeByExt));
      const requestedMime = String(req.get("X-File-Type") || "").toLowerCase();
      const mime = !requestedMime || requestedMime === "application/octet-stream" ? mimeByExt[ext] : requestedMime;
      if (!allowed.has(mime)) fail("invalid-argument", "यह file type supported नहीं है।");
      const objectPath = contentId + "/" + Date.now() + "-" + safeName;
      await supabaseStorageRequest("/object/" + encodeURIComponent(storageBucket) + "/" + storagePathUrl(objectPath), {
        method: "POST",
        headers: { "Content-Type": mime, "x-upsert": "false" },
        body: req.body
      });
      return res.json({ data: { storagePath: objectPath } });
    } catch (error) {
      const code = error.code || "internal";
      const status = code === "unauthenticated" ? 401 : code === "permission-denied" ? 403 : code === "invalid-argument" ? 400 : code === "failed-precondition" ? 503 : code === "not-found" ? 404 : 500;
      if (status >= 500 && status !== 503) console.error("Storage upload error:", error);
      return res.status(status).json({ error: { code, message: status >= 500 && status !== 503 ? "फ़ाइल upload नहीं हो सकी। कृपया बाद में कोशिश करें।" : error.message } });
    }
  }
);
app.post("/api/notice-upload/:id", express.raw({type:"application/octet-stream",limit:"50mb"}), authenticate, async(req,res)=>{
  try{
    const id=String(req.params.id||"");
    if(!/^[A-Za-z0-9_-]{10,100}$/.test(id))fail("invalid-argument","Notice ID मान्य नहीं है।");
    await requireTeacher(req);
    if(!Buffer.isBuffer(req.body)||!req.body.length)fail("invalid-argument","खाली media upload नहीं हो सकता।");
    if(req.body.length>50*1024*1024)fail("invalid-argument","Photo या video 50 MB से छोटी होनी चाहिए।");
    const mime=String(req.get("X-File-Type")||"").toLowerCase().split(";")[0];
    if(!new Set(["image/jpeg","image/png","image/webp","image/gif","video/mp4","video/webm","video/quicktime"]).has(mime))fail("invalid-argument","केवल JPG, PNG, WEBP, GIF, MP4, WEBM या MOV स्वीकार है।");
    let name=String(req.get("X-File-Name")||"notice-media");try{name=decodeURIComponent(name)}catch{}
    const safe=name.replace(/[^a-zA-Z0-9._-]/g,"_").slice(-100)||"notice-media";
    const path="notices/"+id+"/"+Date.now()+"-"+safe;
    await supabaseStorageRequest("/object/"+encodeURIComponent(storageBucket)+"/"+storagePathUrl(path),{method:"POST",headers:{"Content-Type":mime,"x-upsert":"false"},body:req.body});
    return res.json({data:{storagePath:path,mediaType:mime.startsWith("video/")?"video":"image"}});
  }catch(error){
    const code=error.code||"internal",status=code==="unauthenticated"?401:code==="permission-denied"?403:code==="invalid-argument"?400:code==="failed-precondition"?503:500;
    if(status>=500&&status!==503)console.error("Notice media upload error:",error);
    return res.status(status).json({error:{code,message:status>=500&&status!==503?"Notice media upload नहीं हो सका।":error.message}});
  }
});
app.post("/api/:name", authenticate, async (req, res) => {
  if (["generateQuestionDraft","generateAiNotes"].includes(req.params.name)) { req.setTimeout(150000); res.setTimeout(150000); }
  if (req.params.name === "aiTutorChat") { req.setTimeout(110000); res.setTimeout(110000); }
  try {
    const data = await run(req.params.name, req);
    return res.json({ data });
  } catch (error) {
    const known = new Set(["invalid-argument", "unauthenticated", "permission-denied", "not-found", "already-exists", "failed-precondition", "deadline-exceeded", "resource-exhausted", "unavailable"]);
    const code = known.has(error.code) ? error.code : "internal";
    if (code === "internal") console.error("API error:", error);
    return res.status(code === "unauthenticated" ? 401 : code === "permission-denied" ? 403 : code === "not-found" ? 404 : code === "invalid-argument" ? 400 : code === "already-exists" ? 409 : code === "deadline-exceeded" ? 408 : code === "unavailable" ? 503 : code === "resource-exhausted" ? 429 : 500)
      .json({ error: { code, message: code === "internal" ? "Server में समस्या आई। कृपया बाद में कोशिश करें।" : error.message } });
  }
});
app.use((error, _req, res, _next) => {
  console.error("Request error:", error.message);
  res.status(400).json({ error: { code: "invalid-request", message: "Request स्वीकार नहीं हुई।" } });
});

const port = Number(process.env.PORT || 10000);
app.listen(port, "0.0.0.0", () => console.log("EduFuture API listening on", port));
