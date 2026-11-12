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
app.use(express.json({ limit: "8mb" }));

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
async function requireTeacher(req, subject) {
  const role = await roleOf(req.user.uid);
  if (!["teacher", "admin", "superadmin"].includes(role)) fail("permission-denied", "यह सुविधा केवल Teacher या Admin के लिए है।");
  if (["admin", "superadmin"].includes(role)) return true;
  const snap = await db.doc("teacherAssignments/" + req.user.uid).get();
  const subjects = snap.exists ? (snap.data().subjects || []) : [];
  if (subject && !subjects.some(x => String(x).toLowerCase() === String(subject).toLowerCase())) fail("permission-denied", "यह विषय आपको assign नहीं किया गया है।");
  return true;
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
      const duration = Number(d.duration);
      if (!title || !questions.length || questions.length > 1000) fail("invalid-argument", "Quiz title और 1 से 1000 questions जरूरी हैं।");
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
      if (d.publish !== false) await quizRef.update({ status: "published", publishedAt: FieldValue.serverTimestamp() });
      return { id: quizRef.id, questionCount: questions.length, totalMarks };
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
      const [answerSnap, questionSnap] = await Promise.all([
        quizRef.collection("privateAnswers").get(),
        quizRef.collection("publicQuestions").orderBy("index").get()
      ]);
      const validIds = new Set(answerSnap.docs.map(x => x.id));
      if (Object.keys(answers).some(k => !validIds.has(k))) fail("invalid-argument", "Invalid answer key.");
      if (Buffer.byteLength(JSON.stringify(answers), "utf8") > 700 * 1024) fail("invalid-argument", "उत्तर बहुत बड़े हैं। कृपया उत्तर छोटा करके फिर submit करें।");
      const questionById = new Map(questionSnap.docs.map(x => [x.id, x.data()]));
      let score = 0, pendingReview = 0;
      answerSnap.forEach(x => {
        const a = x.data(), q = questionById.get(x.id) || {};
        if (a.type === "subjective" || q.type === "subjective") {
          if (String(answers[x.id] || "").trim()) pendingReview++;
        } else if (Number.isInteger(answers[x.id]) && answers[x.id] === a.answer) {
          score += Number(a.marks || q.marks || 1);
        }
      });
      const userRecord = await auth.getUser(uid);
      const releaseAt = Timestamp.fromMillis(Date.now() + 48 * 60 * 60 * 1000);
      const totalMarks = Number((await quizRef.get()).data().totalMarks || questionSnap.docs.reduce((n,x)=>n+Number(x.data().marks||1),0));
      await db.runTransaction(async tx => {
        const current = await tx.get(attemptRef);
        if (!current.exists || current.data().status !== "started" || current.data().uid !== uid) fail("already-exists", "यह Quiz पहले submit हो चुका है।");
        if (Date.now() > current.data().expiresAt.toMillis() + 30000) fail("deadline-exceeded", "Quiz का समय समाप्त हो गया।");
        tx.update(attemptRef, { status: "submitted", answers, objectiveScore: score, pendingReview, releaseAt, submittedAt: FieldValue.serverTimestamp() });
        tx.set(quizRef.collection("leaderboard").doc(uid), {
          uid, email: (userRecord.email || "").toLowerCase(), displayName: userRecord.displayName || "",
          score, total: totalMarks, pendingReview, releaseAt, submittedAt: FieldValue.serverTimestamp()
        });
      });
      return { submitted: true, objectiveScore: score, pendingReview, releaseAt: releaseAt.toDate().toISOString() };
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
      return { released: isAdmin || rows.length > 0, rows: rows.map((x, i) => ({ uid: x.uid, name: x.displayName || "Student", score: x.score, total: x.total, pendingReview: x.pendingReview || 0, rank: i + 1 })) };
    }
    case "getMyResults": {
      const quizzes = await db.collection("quizzes").get();
      const now = Date.now(), results = [];
      for (const q of quizzes.docs) {
        const snap = await q.ref.collection("leaderboard").doc(uid).get();
        if (!snap.exists) continue;
        const data = snap.data(), released = !!data.releaseAt && now >= data.releaseAt.toMillis();
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
      return { students: snap.docs.map(x => ({ uid: x.id, email: x.data().email || "", displayName: x.data().displayName || "" })) };
    }
    case "assignTeacher": {
      await requireAdmin(req);
      const email = String(d.email || "").trim().toLowerCase();
      const subjects = Array.isArray(d.subjects) ? [...new Set(d.subjects.map(x => String(x).trim()).filter(Boolean))].slice(0,30) : [];
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !subjects.length) fail("invalid-argument", "Teacher का registered email और कम-से-कम एक subject दें।");
      let target;
      try { target = await auth.getUserByEmail(email); } catch { fail("not-found", "पहले इस email से Teacher account बनवाएँ।"); }
      const targetRole = await roleOf(target.uid);
      if (["admin", "superadmin"].includes(targetRole)) fail("failed-precondition", "Admin या Super Admin को Teacher में नहीं बदला जा सकता।");
      await setRole(target.uid, "teacher", { assignedBy: uid });
      await db.doc("teacherAssignments/" + target.uid).set({ subjects, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid }, { merge: true });
      return { ok: true, uid: target.uid, subjects };
    }
    case "createDoubt": {
      const question = String(d.question || "").trim();
      const subject = String(d.subject || "").trim();
      if (!question || question.length > 5000 || !subject) fail("invalid-argument", "Subject और doubt लिखें (अधिकतम 5000 अक्षर)।");
      const ref = await db.collection("doubts").add({
        uid, studentName: req.user.name || req.user.email || "Student",
        subject, topic: String(d.topic || "").trim(), question,
        status: "open", createdAt: FieldValue.serverTimestamp()
      });
      return { id: ref.id };
    }
    case "listDoubts": {
      const role = await roleOf(uid);
      let snap;
      if (role === "student") snap = await db.collection("doubts").where("uid", "==", uid).limit(100).get();
      else if (["teacher","admin","superadmin"].includes(role)) {
        let subjects = [];
        if (role === "teacher") {
          const a = await db.doc("teacherAssignments/" + uid).get();
          subjects = a.exists ? (a.data().subjects || []) : [];
          if (!subjects.length) return { doubts: [] };
        }
        snap = await db.collection("doubts").limit(300).get();
        if (role === "teacher") snap = { docs: snap.docs.filter(x => subjects.some(v => String(v).toLowerCase() === String(x.data().subject).toLowerCase())) };
      } else fail("permission-denied", "Access denied.");
      return { doubts: snap.docs.map(x => ({ id:x.id, ...x.data(), createdAt:x.data().createdAt?.toDate().toISOString() || null })) };
    }
    case "replyDoubt": {
      const ref = db.doc("doubts/" + String(d.id || ""));
      const snap = await ref.get();
      if (!snap.exists) fail("not-found", "Doubt नहीं मिला।");
      await requireTeacher(req, snap.data().subject);
      const reply = String(d.reply || "").trim();
      if (!reply || reply.length > 5000) fail("invalid-argument", "Reply 1 से 5000 अक्षर का होना चाहिए।");
      await ref.update({ reply, repliedBy: uid, repliedAt: FieldValue.serverTimestamp(), status: "answered" });
      return { ok: true };
    }
    case "listTeacherStudents": {
      await requireTeacher(req);
      const snap = await db.collection("roles").where("role","==","student").limit(500).get();
      return { students: snap.docs.map(x=>({uid:x.id,email:x.data().email||"",displayName:x.data().displayName||""})) };
    }
    case "listSubjectiveSubmissions": {
      const role = await roleOf(uid);
      if (!["teacher","admin","superadmin"].includes(role)) fail("permission-denied", "केवल Teacher या Admin उपयोग कर सकता है।");
      let subjects = [];
      if (role === "teacher") {
        const assigned = await db.doc("teacherAssignments/" + uid).get();
        subjects = assigned.exists ? (assigned.data().subjects || []) : [];
      }
      const quizzes = await db.collection("quizzes").limit(200).get(), items = [];
      for (const quizDoc of quizzes.docs) {
        const quiz = quizDoc.data();
        if (role === "teacher" && !subjects.some(v => String(v).toLowerCase() === String(quiz.subject).toLowerCase())) continue;
        const [attempts, questions, answers] = await Promise.all([
          quizDoc.ref.collection("attempts").where("status","==","submitted").limit(100).get(),
          quizDoc.ref.collection("publicQuestions").orderBy("index").get(),
          quizDoc.ref.collection("privateAnswers").get()
        ]);
        const answerMap = new Map(answers.docs.map(x=>[x.id,x.data()]));
        for (const attemptDoc of attempts.docs) {
          const attempt = attemptDoc.data(), grades = attempt.grades || {};
          const pending = questions.docs.filter(x=>{
            const a=answerMap.get(x.id)||{};
            return (x.data().type==="subjective"||a.type==="subjective") && String((attempt.answers||{})[x.id]||"").trim() && !grades[x.id];
          }).map(x=>({questionId:x.id,question:x.data().text,studentAnswer:String((attempt.answers||{})[x.id]||""),maxMarks:Number(x.data().marks||1),modelAnswer:(answerMap.get(x.id)||{}).modelAnswer||""}));
          if (pending.length) {
            let studentName="Student";
            try { const u=await auth.getUser(attempt.uid); studentName=u.displayName||u.email||studentName; } catch {}
            items.push({quizId:quizDoc.id,quizTitle:quiz.title,subject:quiz.subject,uid:attempt.uid,studentName,questions:pending});
          }
        }
      }
      return { submissions: items };
    }
    case "gradeSubjective": {
      const quizId = String(d.quizId || ""), attemptUid = String(d.uid || ""), questionId = String(d.questionId || "");
      const marks = Number(d.marks);
      const quizRef = db.doc("quizzes/" + quizId), quizSnap = await quizRef.get();
      if (!quizSnap.exists) fail("not-found", "Quiz नहीं मिला।");
      await requireTeacher(req, quizSnap.data().subject);
      const maxSnap = await quizRef.collection("privateAnswers").doc(questionId).get();
      if (!maxSnap.exists || maxSnap.data().type !== "subjective") fail("invalid-argument", "Subjective question नहीं मिला।");
      if (!Number.isFinite(marks) || marks < 0 || marks > Number(maxSnap.data().marks || 1)) fail("invalid-argument", "दिए गए अंक प्रश्न के अधिकतम अंकों के भीतर रखें।");
      const attemptRef = quizRef.collection("attempts").doc(attemptUid);
      const attemptSnap = await attemptRef.get();
      if (!attemptSnap.exists || attemptSnap.data().status !== "submitted") fail("not-found", "Submitted attempt नहीं मिला।");
      const attemptData = attemptSnap.data();
      if (!String((attemptData.answers || {})[questionId] || "").trim()) fail("failed-precondition", "इस प्रश्न का कोई उत्तर जमा नहीं हुआ है।");
      const grades = attemptData.grades || {};
      grades[questionId] = { marks, gradedBy: uid, gradedAt: new Date().toISOString() };
      const allAnswers = await quizRef.collection("privateAnswers").get();
      let pendingReview = 0;
      allAnswers.forEach(x => {
        if (x.data().type === "subjective" && String((attemptData.answers || {})[x.id] || "").trim() && !grades[x.id]) pendingReview++;
      });
      let finalScore = Number(attemptData.objectiveScore || 0);
      Object.values(grades).forEach(x => { finalScore += Number(x.marks || 0); });
      await attemptRef.update({ grades, pendingReview, finalScore });
      await quizRef.collection("leaderboard").doc(attemptUid).update({ score: finalScore, pendingReview });
      return { ok: true, pendingReview, score: finalScore };
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
