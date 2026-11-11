const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { defineString } = require("firebase-functions/params");

const BOOTSTRAP_ADMIN_EMAIL = defineString("BOOTSTRAP_ADMIN_EMAIL");
initializeApp();
const db = getFirestore();
const auth = getAuth();

function signedIn(req) {
  if (!req.auth) throw new HttpsError("unauthenticated", "कृपया पहले लॉगिन करें।");
  return req.auth.uid;
}
async function roleOf(uid) {
  const snap = await db.doc("roles/" + uid).get();
  return snap.exists ? snap.data().role : "student";
}
async function requireAdmin(req, superOnly = false) {
  const uid = signedIn(req);
  const role = await roleOf(uid);
  if (!["admin", "superadmin"].includes(role) || (superOnly && role !== "superadmin")) {
    throw new HttpsError("permission-denied", superOnly ? "यह सुविधा केवल Super Admin के लिए है।" : "केवल Admin उपयोग कर सकता है।");
  }
  return uid;
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

exports.ensureStudentRole = onCall(async req => {
  const uid = signedIn(req);
  const ref = db.doc("roles/" + uid);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) tx.create(ref, {
      role: "student", email: (req.auth.token.email || "").toLowerCase(),
      displayName: req.auth.token.name || "", createdAt: FieldValue.serverTimestamp()
    });
  });
  return { role: await roleOf(uid) };
});

exports.bootstrapFirstAdmin = onCall(async req => {
  const uid = signedIn(req);
  const email = (req.auth.token.email || "").toLowerCase();
  const allowed = (BOOTSTRAP_ADMIN_EMAIL.value() || "").trim().toLowerCase();
  if (!allowed || email !== allowed) throw new HttpsError("permission-denied", "यह ईमेल First Super Admin के लिए configured नहीं है।");
  const lockRef = db.doc("system/bootstrap");
  const roleRef = db.doc("roles/" + uid);
  await db.runTransaction(async tx => {
    const lock = await tx.get(lockRef);
    if (lock.exists && lock.data().completed) throw new HttpsError("already-exists", "First Admin setup पहले ही हो चुका है।");
    tx.set(lockRef, { completed: true, uid, email, createdAt: FieldValue.serverTimestamp() });
    tx.set(roleRef, { role: "superadmin", email, displayName: req.auth.token.name || "", createdAt: FieldValue.serverTimestamp() }, { merge: true });
  });
  const user = await auth.getUser(uid);
  await auth.setCustomUserClaims(uid, { ...(user.customClaims || {}), role: "superadmin" });
  return { ok: true, role: "superadmin" };
});

exports.addAdmin = onCall(async req => {
  const actor = await requireAdmin(req, true);
  const email = String(req.data?.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpsError("invalid-argument", "सही ईमेल लिखें।");
  let target;
  try { target = await auth.getUserByEmail(email); }
  catch { throw new HttpsError("not-found", "इस ईमेल से पहले एक बार account बनाकर login करना होगा।"); }
  if (target.uid === actor) throw new HttpsError("invalid-argument", "अपने account की role बदलने के लिए यह विकल्प उपयोग न करें।");
  const currentRole = await roleOf(target.uid);
  if (currentRole === "superadmin") throw new HttpsError("failed-precondition", "किसी दूसरे Super Admin को Admin में नहीं बदला जा सकता।");
  await setRole(target.uid, "admin", { addedBy: actor });
  return { ok: true };
});

exports.removeAdmin = onCall(async req => {
  const actor = await requireAdmin(req, true);
  const uid = String(req.data?.uid || "");
  if (!uid || uid === actor) throw new HttpsError("invalid-argument", "किसी दूसरे Admin को चुनें।");
  const targetRole = await roleOf(uid);
  if (targetRole !== "admin") throw new HttpsError("failed-precondition", "यह account Admin नहीं है या Super Admin है।");
  await setRole(uid, "student", { removedBy: actor, removedAt: FieldValue.serverTimestamp() });
  return { ok: true };
});

exports.listAdmins = onCall(async req => {
  await requireAdmin(req, true);
  const snap = await db.collection("roles").where("role", "in", ["admin", "superadmin"]).get();
  return { admins: snap.docs.map(d => ({ uid: d.id, ...d.data() })) };
});

exports.saveQuiz = onCall(async req => {
  await requireAdmin(req);
  const d = req.data || {};
  const questions = Array.isArray(d.questions) ? d.questions : [];
  const title = String(d.title || "").trim();
  if (!title || !questions.length || questions.length > 249) throw new HttpsError("invalid-argument", "Quiz title और 1 से 249 questions जरूरी हैं।");
  questions.forEach((q, i) => {
    if (!String(q.text || "").trim() || !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 6 ||
        q.options.some(x => !String(x || "").trim()) || !Number.isInteger(q.answer) || q.answer < 0 || q.answer >= q.options.length) {
      throw new HttpsError("invalid-argument", "Question " + (i + 1) + " में text, options या सही answer जाँचें।");
    }
  });
  const quizRef = db.collection("quizzes").doc();
  const batch = db.batch();
  batch.set(quizRef, {
    title, subject: String(d.subject || "General"), duration: Math.min(240, Math.max(1, Number(d.duration) || 30)),
    questionCount: questions.length, status: d.publish === false ? "draft" : "published",
    createdBy: req.auth.uid, createdAt: FieldValue.serverTimestamp()
  });
  questions.forEach((q, i) => {
    batch.set(quizRef.collection("publicQuestions").doc(String(i)), { text: String(q.text).trim(), options: q.options.map(String), index: i });
    batch.set(quizRef.collection("privateAnswers").doc(String(i)), { answer: q.answer, explanation: String(q.explanation || "") });
  });
  await batch.commit();
  return { id: quizRef.id };
});

exports.startQuiz = onCall(async req => {
  const uid = signedIn(req);
  const quizId = String(req.data?.id || "");
  if (!quizId) throw new HttpsError("invalid-argument", "Quiz ID missing.");
  const quizRef = db.doc("quizzes/" + quizId);
  const quizSnap = await quizRef.get();
  if (!quizSnap.exists || quizSnap.data().status !== "published") throw new HttpsError("not-found", "Quiz उपलब्ध नहीं है।");
  const data = quizSnap.data();
  const attemptRef = quizRef.collection("attempts").doc(uid);
  const old = await quizRef.collection("attempts").where("uid", "==", uid).limit(1).get();
  if (!old.empty && old.docs[0].id !== uid) throw new HttpsError("already-exists", "आप यह Quiz पहले दे चुके हैं।");
  await db.runTransaction(async tx => {
    const existing = await tx.get(attemptRef);
    if (existing.exists) throw new HttpsError("already-exists", "आप यह Quiz पहले शुरू कर चुके हैं।");
    tx.create(attemptRef, { uid, status: "started", startedAt: FieldValue.serverTimestamp(), expiresAt: Timestamp.fromMillis(Date.now() + data.duration * 60000) });
  });
  const qs = await quizRef.collection("publicQuestions").orderBy("index").get();
  return { attemptId: uid, title: data.title, duration: data.duration, questions: qs.docs.map(x => ({ id: x.id, ...x.data() })) };
});

exports.submitQuiz = onCall(async req => {
  const uid = signedIn(req);
  const quizId = String(req.data?.id || "");
  const attemptId = String(req.data?.attemptId || "");
  const answers = req.data?.answers && typeof req.data.answers === "object" && !Array.isArray(req.data.answers) ? req.data.answers : {};
  const quizRef = db.doc("quizzes/" + quizId);
  const attemptRef = quizRef.collection("attempts").doc(attemptId);
  const attemptSnap = await attemptRef.get();
  if (!attemptSnap.exists || attemptSnap.data().uid !== uid || attemptSnap.data().status !== "started") throw new HttpsError("permission-denied", "Quiz attempt मान्य नहीं है।");
  if (Date.now() > attemptSnap.data().expiresAt.toMillis() + 30000) throw new HttpsError("deadline-exceeded", "Quiz का समय समाप्त हो गया।");
  const answerSnap = await quizRef.collection("privateAnswers").get();
  const validIds = new Set(answerSnap.docs.map(d => d.id));
  if (Object.keys(answers).some(k => !validIds.has(k))) throw new HttpsError("invalid-argument", "Invalid answer key.");
  let score = 0;
  answerSnap.forEach(d => { if (Number.isInteger(answers[d.id]) && answers[d.id] === d.data().answer) score++; });
  const releaseAt = Timestamp.fromMillis(Date.now() + 48 * 60 * 60 * 1000);
  const user = await auth.getUser(uid);
  await db.runTransaction(async tx => {
    const current = await tx.get(attemptRef);
    if (!current.exists || current.data().status !== "started" || current.data().uid !== uid) throw new HttpsError("already-exists", "यह Quiz पहले submit हो चुका है।");
    tx.update(attemptRef, { status: "submitted", score, total: answerSnap.size, answers, releaseAt, submittedAt: FieldValue.serverTimestamp() });
    tx.set(quizRef.collection("leaderboard").doc(uid), {
      uid, email: (user.email || "").toLowerCase(), displayName: user.displayName || "",
      score, total: answerSnap.size, releaseAt, submittedAt: FieldValue.serverTimestamp()
    });
  });
  // Score is deliberately withheld from the submit response until the 48-hour release window ends.
  return { submitted: true, releaseAt: releaseAt.toDate().toISOString() };
});

exports.getLeaderboard = onCall(async req => {
  const uid = signedIn(req);
  const quizRef = db.doc("quizzes/" + String(req.data?.id || ""));
  const quiz = await quizRef.get();
  if (!quiz.exists) throw new HttpsError("not-found", "Quiz नहीं मिला।");
  const isAdmin = ["admin", "superadmin"].includes(await roleOf(uid));
  const snap = await quizRef.collection("leaderboard").orderBy("score", "desc").get();
  const now = Date.now();
  const rows = snap.docs.map(d => d.data()).filter(x => isAdmin || (x.releaseAt && now >= x.releaseAt.toMillis()));
  if (!isAdmin && rows.length === 0) {
    const future = snap.docs.map(d => d.data().releaseAt?.toMillis()).filter(t => t && t > now);
    return { released: false, releaseAt: future.length ? new Date(Math.min(...future)).toISOString() : null, rows: [] };
  }
  rows.sort((a, b) => b.score - a.score || (a.submittedAt?.toMillis() || 0) - (b.submittedAt?.toMillis() || 0));
  return { released: true, rows: rows.map((x, i) => ({ uid: x.uid, name: x.displayName || "Student", score: x.score, total: x.total, rank: i + 1 })) };
});

exports.getMyResults = onCall(async req => {
  const uid = signedIn(req);
  const quizzes = await db.collection("quizzes").get();
  const now = Date.now();
  const results = [];
  for (const q of quizzes.docs) {
    const snap = await q.ref.collection("leaderboard").doc(uid).get();
    if (!snap.exists) continue;
    const d = snap.data();
    const released = !!d.releaseAt && now >= d.releaseAt.toMillis();
    results.push({
      quizId: q.id, title: q.data().title, released,
      ...(released ? { score: d.score, total: d.total } : {}),
      releaseAt: d.releaseAt?.toDate().toISOString() || null
    });
  }
  return { results };
});

exports.addContent = onCall(async req => {
  await requireAdmin(req);
  const d = req.data || {};
  if (!String(d.title || "").trim() || !/^https?:\/\//i.test(String(d.url || ""))) throw new HttpsError("invalid-argument", "Title और valid https/http file link जरूरी है।");
  const ref = await db.collection("content").add({
    title: String(d.title).trim(), subject: String(d.subject || "General"),
    type: String(d.type || "note"), description: String(d.description || ""),
    url: String(d.url), published: d.published !== false,
    createdBy: req.auth.uid, createdAt: FieldValue.serverTimestamp()
  });
  return { id: ref.id };
});

exports.listStudents = onCall(async req => {
  await requireAdmin(req);
  const snap = await db.collection("roles").where("role", "==", "student").limit(500).get();
  return { students: snap.docs.map(d => ({ uid: d.id, email: d.data().email || "", displayName: d.data().displayName || "" })) };
});
