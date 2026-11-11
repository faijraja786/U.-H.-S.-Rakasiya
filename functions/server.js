const express = require("express");
const cors = require("cors");
const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

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
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json({ limit: "1mb" }));

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
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
          displayName: req.user.name || "", createdAt: FieldValue.serverTimestamp()
        });
      });
      return { role: await roleOf(uid) };
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
      if (!title || !questions.length || questions.length > 249) fail("invalid-argument", "Quiz title और 1 से 249 questions जरूरी हैं।");
      questions.forEach((q, i) => {
        if (!String(q.text || "").trim() || !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 6 ||
          q.options.some(x => !String(x || "").trim()) || !Number.isInteger(q.answer) || q.answer < 0 || q.answer >= q.options.length) {
          fail("invalid-argument", "Question " + (i + 1) + " में text, options या सही answer जाँचें।");
        }
      });
      const quizRef = db.collection("quizzes").doc();
      const batch = db.batch();
      batch.set(quizRef, {
        title, subject: String(d.subject || "General"),
        duration: Math.min(240, Math.max(1, Number(d.duration) || 30)),
        questionCount: questions.length, status: d.publish === false ? "draft" : "published",
        createdBy: uid, createdAt: FieldValue.serverTimestamp()
      });
      questions.forEach((q, i) => {
        batch.set(quizRef.collection("publicQuestions").doc(String(i)), {
          text: String(q.text).trim(), options: q.options.map(String), index: i,
          topic: String(q.topic || d.subject || "General").trim(),
          difficulty: ["easy", "medium", "hard"].includes(q.difficulty) ? q.difficulty : "medium"
        });
        batch.set(quizRef.collection("privateAnswers").doc(String(i)), { answer: q.answer, explanation: String(q.explanation || "") });
      });
      await batch.commit();
      return { id: quizRef.id };
    }
    case "startQuiz": {
      const quizId = String(d.id || "");
      if (!quizId) fail("invalid-argument", "Quiz ID missing.");
      const quizRef = db.doc("quizzes/" + quizId);
      const quizSnap = await quizRef.get();
      if (!quizSnap.exists || quizSnap.data().status !== "published") fail("not-found", "Quiz उपलब्ध नहीं है।");
      const quiz = quizSnap.data();
      const attemptRef = quizRef.collection("attempts").doc(uid);
      await db.runTransaction(async tx => {
        const existing = await tx.get(attemptRef);
        if (existing.exists) fail("already-exists", "आप यह Quiz पहले शुरू कर चुके हैं।");
        tx.create(attemptRef, {
          uid, status: "started", startedAt: FieldValue.serverTimestamp(),
          expiresAt: Timestamp.fromMillis(Date.now() + quiz.duration * 60000)
        });
      });
      const questions = await quizRef.collection("publicQuestions").orderBy("index").get();
      return { attemptId: uid, title: quiz.title, duration: quiz.duration, questions: questions.docs.map(x => ({ id: x.id, ...x.data() })) };
    }
    case "submitQuiz": {
      const quizId = String(d.id || "");
      const attemptId = String(d.attemptId || "");
      const answers = d.answers && typeof d.answers === "object" && !Array.isArray(d.answers) ? d.answers : {};
      if (!quizId || attemptId !== uid) fail("invalid-argument", "Quiz attempt मान्य नहीं है।");
      const quizRef = db.doc("quizzes/" + quizId);
      const attemptRef = quizRef.collection("attempts").doc(uid);
      const answerSnap = await quizRef.collection("privateAnswers").get();
      const validIds = new Set(answerSnap.docs.map(x => x.id));
      if (Object.keys(answers).some(k => !validIds.has(k) || !Number.isInteger(answers[k]) || answers[k] < 0 || answers[k] > 5)) fail("invalid-argument", "Invalid answer key.");
      let score = 0;
      answerSnap.forEach(x => { if (Number.isInteger(answers[x.id]) && answers[x.id] === x.data().answer) score++; });
      const user = await auth.getUser(uid);
      const releaseAt = Timestamp.fromMillis(Date.now() + 48 * 60 * 60 * 1000);
      await db.runTransaction(async tx => {
        const current = await tx.get(attemptRef);
        if (!current.exists || current.data().status !== "started" || current.data().uid !== uid) fail("already-exists", "यह Quiz पहले submit हो चुका है।");
        if (Date.now() > current.data().expiresAt.toMillis() + 30000) fail("deadline-exceeded", "Quiz का समय समाप्त हो गया।");
        tx.update(attemptRef, { status: "submitted", answers, releaseAt, submittedAt: FieldValue.serverTimestamp() });
        tx.set(quizRef.collection("leaderboard").doc(uid), {
          uid, email: (user.email || "").toLowerCase(), displayName: user.displayName || "",
          score, total: answerSnap.size, releaseAt, submittedAt: FieldValue.serverTimestamp()
        });
      });
      return { submitted: true, releaseAt: releaseAt.toDate().toISOString() };
    }
    case "getLeaderboard": {
      const quizRef = db.doc("quizzes/" + String(d.id || ""));
      const quiz = await quizRef.get();
      if (!quiz.exists) fail("not-found", "Quiz नहीं मिला।");
      const isAdmin = ["admin", "superadmin"].includes(await roleOf(uid));
      const snap = await quizRef.collection("leaderboard").orderBy("score", "desc").get();
      const now = Date.now();
      const rows = snap.docs.map(x => x.data()).filter(x => isAdmin || (x.releaseAt && now >= x.releaseAt.toMillis()));
      if (!isAdmin && rows.length === 0) {
        const future = snap.docs.map(x => x.data().releaseAt?.toMillis()).filter(t => t && t > now);
        return { released: false, releaseAt: future.length ? new Date(Math.min(...future)).toISOString() : null, rows: [] };
      }
      rows.sort((a, b) => b.score - a.score || (a.submittedAt?.toMillis() || 0) - (b.submittedAt?.toMillis() || 0));
      return { released: isAdmin || rows.length > 0, rows: rows.map((x, i) => ({ uid: x.uid, name: x.displayName || "Student", score: x.score, total: x.total, rank: i + 1 })) };
    }
    case "getMyResults": {
      const quizzes = await db.collection("quizzes").get();
      const now = Date.now();
      const results = [];
      for (const q of quizzes.docs) {
        const snap = await q.ref.collection("leaderboard").doc(uid).get();
        if (!snap.exists) continue;
        const data = snap.data();
        const released = !!data.releaseAt && now >= data.releaseAt.toMillis();
        let review = [];
        if (released) {
          const [attemptSnap, questionSnap, answerSnap] = await Promise.all([
            q.ref.collection("attempts").doc(uid).get(),
            q.ref.collection("publicQuestions").orderBy("index").get(),
            q.ref.collection("privateAnswers").get()
          ]);
          const chosen = attemptSnap.exists ? (attemptSnap.data().answers || {}) : {};
          const correctById = new Map(answerSnap.docs.map(x => [x.id, x.data()]));
          review = questionSnap.docs.map(questionDoc => {
            const question = questionDoc.data(), answer = correctById.get(questionDoc.id) || {};
            const selectedAnswer = Number.isInteger(chosen[questionDoc.id]) ? chosen[questionDoc.id] : null;
            const correctAnswer = Number.isInteger(answer.answer) ? answer.answer : null;
            return {
              questionId: questionDoc.id, question: question.text || "", options: question.options || [],
              topic: question.topic || q.data().subject || "General", difficulty: question.difficulty || "medium",
              selectedAnswer, correctAnswer, isCorrect: selectedAnswer !== null && selectedAnswer === correctAnswer,
              explanation: answer.explanation || ""
            };
          });
        }
        results.push({
          quizId: q.id, title: q.data().title, released,
          ...(released ? { score: data.score, total: data.total, review } : {}),
          releaseAt: data.releaseAt?.toDate().toISOString() || null
        });
      }
      return { results };
    }
    case "addContent": {
      await requireAdmin(req);
      if (!String(d.title || "").trim() || !/^https?:\/\//i.test(String(d.url || ""))) fail("invalid-argument", "Title और valid https/http file link जरूरी है।");
      const ref = await db.collection("content").add({
        title: String(d.title).trim(), subject: String(d.subject || "General"),
        type: String(d.type || "note"), description: String(d.description || ""),
        url: String(d.url), published: d.published !== false,
        createdBy: uid, createdAt: FieldValue.serverTimestamp()
      });
      return { id: ref.id };
    }
    case "listStudents": {
      await requireAdmin(req);
      const snap = await db.collection("roles").where("role", "==", "student").limit(500).get();
      return { students: snap.docs.map(x => ({ uid: x.id, email: x.data().email || "", displayName: x.data().displayName || "" })) };
    }
    default:
      fail("not-found", "Unknown API action.");
  }
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "EduFuture API" }));
app.post("/api/:name", authenticate, async (req, res) => {
  try {
    const data = await run(req.params.name, req);
    return res.json({ data });
  } catch (error) {
    const known = new Set(["invalid-argument", "unauthenticated", "permission-denied", "not-found", "already-exists", "failed-precondition", "deadline-exceeded"]);
    const code = known.has(error.code) ? error.code : "internal";
    if (code === "internal") console.error("API error:", error);
    return res.status(code === "unauthenticated" ? 401 : code === "permission-denied" ? 403 : code === "not-found" ? 404 : code === "invalid-argument" ? 400 : code === "already-exists" ? 409 : code === "deadline-exceeded" ? 408 : 500)
      .json({ error: { code, message: code === "internal" ? "Server में समस्या आई। कृपया बाद में कोशिश करें।" : error.message } });
  }
});
app.use((error, _req, res, _next) => {
  console.error("Request error:", error.message);
  res.status(400).json({ error: { code: "invalid-request", message: "Request स्वीकार नहीं हुई।" } });
});

const port = Number(process.env.PORT || 10000);
app.listen(port, "0.0.0.0", () => console.log("EduFuture API listening on", port));
