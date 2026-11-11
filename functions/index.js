const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const {
  getFirestore,
  FieldValue,
  Timestamp
} = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { defineString } = require("firebase-functions/params");

const BOOTSTRAP_ADMIN_EMAIL = defineString("BOOTSTRAP_ADMIN_EMAIL");

initializeApp();

const db = getFirestore();

// ADMIN CHECK
async function admin(req, superOnly = false) {
  if (!req.auth) {
    throw new HttpsError("unauthenticated", "Sign in");
  }

  const s = await db.doc("roles/" + req.auth.uid).get();
  const role = s.exists ? s.data().role : "student";

  if (
    !["admin", "superadmin"].includes(role) ||
    (superOnly && role !== "superadmin")
  ) {
    throw new HttpsError("permission-denied", "Admin only");
  }
}

// FIRST ADMIN
exports.bootstrapFirstAdmin = onCall(async req => {
  if (!req.auth) {
    throw new HttpsError("unauthenticated", "Sign in");
  }

  const email = (req.auth.token.email || "").toLowerCase();

  if (
    email !==
    (BOOTSTRAP_ADMIN_EMAIL.value() || "").toLowerCase()
  ) {
    throw new HttpsError("permission-denied", "Email not configured");
  }

  const s = await db.collection("roles")
    .where("role", "in", ["admin", "superadmin"])
    .limit(1)
    .get();

  if (!s.empty) {
    throw new HttpsError("already-exists", "Admin already bootstrapped");
  }

  await db.doc("roles/" + req.auth.uid).set({
    role: "superadmin",
    email
  });

  await getAuth().setCustomUserClaims(req.auth.uid, {
    role: "superadmin"
  });

  return { ok: true };
});

// ADD ADMIN
exports.addAdmin = onCall(async req => {
  await admin(req, true);

  const email = String(req.data.email || "")
    .toLowerCase()
    .trim();

  let u;

  try {
    u = await getAuth().getUserByEmail(email);
  } catch (e) {
    throw new HttpsError(
      "not-found",
      "Admin must sign in once first"
    );
  }

  await db.doc("roles/" + u.uid).set({
    role: "admin",
    email,
    addedBy: req.auth.uid
  });

  await getAuth().setCustomUserClaims(u.uid, {
    role: "admin"
  });

  return { ok: true };
});

// SAVE QUIZ
exports.saveQuiz = onCall(async req => {
  await admin(req);

  const d = req.data;
  const qs = d.questions || [];

  if (!d.title || !Array.isArray(qs) || !qs.length) {
    throw new HttpsError(
      "invalid-argument",
      "Title and questions required"
    );
  }

  if (qs.length > 249) {
    throw new HttpsError(
      "invalid-argument",
      "Maximum 249 questions allowed per quiz"
    );
  }

  for (const q of qs) {
    if (
      !q.text ||
      !Array.isArray(q.options) ||
      q.options.length < 2 ||
      !Number.isInteger(q.answer) ||
      q.answer < 0 ||
      q.answer >= q.options.length
    ) {
      throw new HttpsError(
        "invalid-argument",
        "Invalid question"
      );
    }
  }

  const r = db.collection("quizzes").doc();
  const b = db.batch();

  b.set(r, {
    title: d.title,
    subject: d.subject || "General",
    duration: Math.min(
      240,
      Math.max(1, +d.duration || 30)
    ),
    questionCount: qs.length,
    status: d.publish ? "published" : "draft",
    createdAt: FieldValue.serverTimestamp(),
    resultsReleased: false
  });

  qs.forEach((q, i) => {
    b.set(
      r.collection("publicQuestions").doc(String(i)),
      {
        text: q.text,
        options: q.options,
        index: i
      }
    );

    b.set(
      r.collection("privateAnswers").doc(String(i)),
      {
        answer: q.answer,
        explanation: q.explanation || ""
      }
    );
  });

  await b.commit();

  return { id: r.id };
});

// START QUIZ
exports.startQuiz = onCall(async req => {
  if (!req.auth) {
    throw new HttpsError("unauthenticated", "Sign in");
  }

  const r = db.doc("quizzes/" + req.data.id);
  const s = await r.get();

  if (!s.exists || s.data().status !== "published") {
    throw new HttpsError("not-found", "Quiz unavailable");
  }

  const prev = await r.collection("attempts")
    .where("uid", "==", req.auth.uid)
    .limit(1)
    .get();

  if (!prev.empty) {
    throw new HttpsError(
      "already-exists",
      "Already attempted"
    );
  }

  const qs = await r.collection("publicQuestions")
    .orderBy("index")
    .get();

  const a = r.collection("attempts").doc();

  const exp = Timestamp.fromMillis(
    Date.now() + s.data().duration * 60000
  );

  await a.set({
    uid: req.auth.uid,
    expiresAt: exp,
    status: "started"
  });

  return {
    attemptId: a.id,
    title: s.data().title,
    duration: s.data().duration,
    questions: qs.docs.map(x => ({
      id: x.id,
      ...x.data()
    }))
  };
});

// SUBMIT QUIZ
exports.submitQuiz = onCall(async req => {
  if (!req.auth) {
    throw new HttpsError("unauthenticated", "Sign in");
  }

  const r = db.doc("quizzes/" + req.data.id);
  const a = r.collection("attempts").doc(req.data.attemptId);

  const s = await a.get();

  if (
    !s.exists ||
    s.data().uid !== req.auth.uid ||
    s.data().status !== "started"
  ) {
    throw new HttpsError(
      "permission-denied",
      "Invalid attempt"
    );
  }

  if (
    Date.now() >
    s.data().expiresAt.toMillis() + 30000
  ) {
    throw new HttpsError(
      "deadline-exceeded",
      "Time expired"
    );
  }

  const keys = await r.collection("privateAnswers").get();

  const answers =
    req.data.answers &&
    typeof req.data.answers === "object"
      ? req.data.answers
      : {};

  let score = 0;

  keys.forEach(k => {
    if (
      Number(answers[k.id]) ===
      k.data().answer
    ) {
      score++;
    }
  });

  const release = Timestamp.fromMillis(
    Date.now() + 48 * 3600000
  );

  await a.update({
    status: "submitted",
    score,
    total: keys.size,
    answers,
    releaseAt: release,
    submittedAt: FieldValue.serverTimestamp()
  });

  await r.collection("leaderboard")
    .doc(req.auth.uid)
    .set({
      uid: req.auth.uid,
      score,
      total: keys.size,
      releaseAt: release
    });

  return {
    score,
    total: keys.size,
    releaseAt: release.toDate().toISOString()
  };
});

// GET LEADERBOARD
exports.getLeaderboard = onCall(async req => {
  if (!req.auth) {
    throw new HttpsError("unauthenticated", "Sign in");
  }

  const quizRef = db.doc("quizzes/" + req.data.id);
  const quiz = await quizRef.get();

  if (!quiz.exists) {
    throw new HttpsError("not-found", "Quiz not found");
  }

  const roleDoc = await db.doc("roles/" + req.auth.uid).get();

  const userRole = roleDoc.exists
    ? roleDoc.data().role
    : "student";

  const isAdmin = ["admin", "superadmin"].includes(userRole);

  const snapshot = await quizRef
    .collection("leaderboard")
    .orderBy("score", "desc")
    .get();

  const now = Date.now();

  const releasedRows = snapshot.docs
    .filter(doc => {
      const data = doc.data();

      return (
        isAdmin ||
        (
          data.releaseAt &&
          now >= data.releaseAt.toMillis()
        )
      ); const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const {
  getFirestore,
  FieldValue,
  Timestamp
} = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { defineString } = require("firebase-functions/params");

const BOOTSTRAP_ADMIN_EMAIL = defineString("BOOTSTRAP_ADMIN_EMAIL");

initializeApp();

const db = getFirestore();

// ADMIN CHECK
async function admin(req, superOnly = false) {
  if (!req.auth) {
    throw new HttpsError("unauthenticated", "Sign in");
  }

  const s = await db.doc("roles/" + req.auth.uid).get();
  const role = s.exists ? s.data().role : "student";

  if (
    !["admin", "superadmin"].includes(role) ||
    (superOnly && role !== "superadmin")
  ) {
    throw new HttpsError("permission-denied", "Admin only");
  }
}

// FIRST ADMIN
exports.bootstrapFirstAdmin = onCall(async req => {
  if (!req.auth) {
    throw new HttpsError("unauthenticated", "Sign in");
  }

  const email = (req.auth.token.email || "").toLowerCase();

  if (
    email !==
    (BOOTSTRAP_ADMIN_EMAIL.value() || "").toLowerCase()
  ) {
    throw new HttpsError("permission-denied", "Email not configured");
  }

  const s = await db.collection("roles")
    .where("role", "in", ["admin", "superadmin"])
    .limit(1)
    .get();

  if (!s.empty) {
    throw new HttpsError("already-exists", "Admin already bootstrapped");
  }

  await db.doc("roles/" + req.auth.uid).set({
    role: "superadmin",
    email
  });

  await getAuth().setCustomUserClaims(req.auth.uid, {
    role: "superadmin"
  });

  return { ok: true };
});

// ADD ADMIN
exports.addAdmin = onCall(async req => {
  await admin(req, true);

  const email = String(req.data.email || "")
    .toLowerCase()
    .trim();

  let u;

  try {
    u = await getAuth().getUserByEmail(email);
  } catch (e) {
    throw new HttpsError(
      "not-found",
      "Admin must sign in once first"
    );
  }

  await db.doc("roles/" + u.uid).set({
    role: "admin",
    email,
    addedBy: req.auth.uid
  });

  await getAuth().setCustomUserClaims(u.uid, {
    role: "admin"
  });

  return { ok: true };
});

// SAVE QUIZ
exports.saveQuiz = onCall(async req => {
  await admin(req);

  const d = req.data;
  const qs = d.questions || [];

  if (!d.title || !Array.isArray(qs) || !qs.length) {
    throw new HttpsError(
      "invalid-argument",
      "Title and questions required"
    );
  }

  if (qs.length > 249) {
    throw new HttpsError(
      "invalid-argument",
      "Maximum 249 questions allowed per quiz"
    );
  }

  for (const q of qs) {
    if (
      !q.text ||
      !Array.isArray(q.options) ||
      q.options.length < 2 ||
      !Number.isInteger(q.answer) ||
      q.answer < 0 ||
      q.answer >= q.options.length
    ) {
      throw new HttpsError(
        "invalid-argument",
        "Invalid question"
      );
    }
  }

  const r = db.collection("quizzes").doc();
  const b = db.batch();

  b.set(r, {
    title: d.title,
    subject: d.subject || "General",
    duration: Math.min(
      240,
      Math.max(1, +d.duration || 30)
    ),
    questionCount: qs.length,
    status: d.publish ? "published" : "draft",
    createdAt: FieldValue.serverTimestamp(),
    resultsReleased: false
  });

  qs.forEach((q, i) => {
    b.set(
      r.collection("publicQuestions").doc(String(i)),
      {
        text: q.text,
        options: q.options,
        index: i
      }
    );

    b.set(
      r.collection("privateAnswers").doc(String(i)),
      {
        answer: q.answer,
        explanation: q.explanation || ""
      }
    );
  });

  await b.commit();

  return { id: r.id };
});

// START QUIZ
exports.startQuiz = onCall(async req => {
  if (!req.auth) {
    throw new HttpsError("unauthenticated", "Sign in");
  }

  const r = db.doc("quizzes/" + req.data.id);
  const s = await r.get();

  if (!s.exists || s.data().status !== "published") {
    throw new HttpsError("not-found", "Quiz unavailable");
  }

  const prev = await r.collection("attempts")
    .where("uid", "==", req.auth.uid)
    .limit(1)
    .get();

  if (!prev.empty) {
    throw new HttpsError(
      "already-exists",
      "Already attempted"
    );
  }

  const qs = await r.collection("publicQuestions")
    .orderBy("index")
    .get();

  const a = r.collection("attempts").doc();

  const exp = Timestamp.fromMillis(
    Date.now() + s.data().duration * 60000
  );

  await a.set({
    uid: req.auth.uid,
    expiresAt: exp,
    status: "started"
  });

  return {
    attemptId: a.id,
    title: s.data().title,
    duration: s.data().duration,
    questions: qs.docs.map(x => ({
      id: x.id,
      ...x.data()
    }))
  };
});

// SUBMIT QUIZ
exports.submitQuiz = onCall(async req => {
  if (!req.auth) {
    throw new HttpsError("unauthenticated", "Sign in");
  }

  const r = db.doc("quizzes/" + req.data.id);
  const a = r.collection("attempts").doc(req.data.attemptId);

  const s = await a.get();

  if (
    !s.exists ||
    s.data().uid !== req.auth.uid ||
    s.data().status !== "started"
  ) {
    throw new HttpsError(
      "permission-denied",
      "Invalid attempt"
    );
  }

  if (
    Date.now() >
    s.data().expiresAt.toMillis() + 30000
  ) {
    throw new HttpsError(
      "deadline-exceeded",
      "Time expired"
    );
  }

  const keys = await r.collection("privateAnswers").get();

  const answers =
    req.data.answers &&
    typeof req.data.answers === "object"
      ? req.data.answers
      : {};

  let score = 0;

  keys.forEach(k => {
    if (
      Number(answers[k.id]) ===
      k.data().answer
    ) {
      score++;
    }
  });

  const release = Timestamp.fromMillis(
    Date.now() + 48 * 3600000
  );

  await a.update({
    status: "submitted",
    score,
    total: keys.size,
    answers,
    releaseAt: release,
    submittedAt: FieldValue.serverTimestamp()
  });

  await r.collection("leaderboard")
    .doc(req.auth.uid)
    .set({
      uid: req.auth.uid,
      score,
      total: keys.size,
      releaseAt: release
    });

  return {
    score,
    total: keys.size,
    releaseAt: release.toDate().toISOString()
  };
});

// GET LEADERBOARD
exports.getLeaderboard = onCall(async req => {
  if (!req.auth) {
    throw new HttpsError("unauthenticated", "Sign in");
  }

  const quizRef = db.doc("quizzes/" + req.data.id);
  const quiz = await quizRef.get();

  if (!quiz.exists) {
    throw new HttpsError("not-found", "Quiz not found");
  }

  const roleDoc = await db.doc("roles/" + req.auth.uid).get();

  const userRole = roleDoc.exists
    ? roleDoc.data().role
    : "student";

  const isAdmin = ["admin", "superadmin"].includes(userRole);

  const snapshot = await quizRef
    .collection("leaderboard")
    .orderBy("score", "desc")
    .get();

  const now = Date.now();

  const releasedRows = snapshot.docs
    .filter(doc => {
      const data = doc.data();

      return (
        isAdmin ||
        (
          data.releaseAt &&
          now >= data.releaseAt.toMillis()
        )
      );
    })
    .map(doc => doc.data());

  const pendingRows = snapshot.docs
    .map(doc => doc.data())
    .filter(data =>
      data.releaseAt &&
      now < data.releaseAt.toMillis()
    );

  if (releasedRows.length === 0 && !isAdmin) {
    const nextRelease = pendingRows.length
      ? Math.min(
          ...pendingRows.map(x =>
            x.releaseAt.toMillis()
          )
        )
      : null;

    return {
      released: false,
      releaseAt: nextRelease
        ? new Date(nextRelease).toISOString()
        : null,
      rows: []
    };
  }

  return {
    released: true,
    rows: releasedRows.map((data, index) => ({
      uid: data.uid,
      score: data.score,
      total: data.total,
      rank: index + 1
    }))
  };
});
    })
    .map(doc => doc.data());

  const pendingRows = snapshot.docs
    .map(doc => doc.data())
    .filter(data =>
      data.releaseAt &&
      now < data.releaseAt.toMillis()
    );

  if (releasedRows.length === 0 && !isAdmin) {
    const nextRelease = pendingRows.length
      ? Math.min(
          ...pendingRows.map(x =>
            x.releaseAt.toMillis()
          )
        )
      : null;

    return {
      released: false,
      releaseAt: nextRelease
        ? new Date(nextRelease).toISOString()
        : null,
      rows: []
    };
  }

  return {
    released: true,
    rows: releasedRows.map((data, index) => ({
      uid: data.uid,
      score: data.score,
      total: data.total,
      rank: index + 1
    }))
  };
});
