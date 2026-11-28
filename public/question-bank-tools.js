import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { API_BASE } from "./firebase-config.js";

const auth = getAuth();
const $ = id => document.getElementById(id);
const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
async function api(name, data = {}) {
  const user = auth.currentUser;
  if (!user) throw new Error("कृपया पहले Admin login करें।");
  const token = await user.getIdToken();
  const response = await fetch(API_BASE.replace(/\/+$/, "") + "/api/" + encodeURIComponent(name), {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
    body: JSON.stringify({ data })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message || "Request असफल रही।");
  return payload;
}
function notify(message) {
  const box = document.getElementById("bankPublishStatus") || document.getElementById("aiStatus");
  if (box) box.textContent = message;
  else alert(message);
}
let drafts = [];
let busy = false;

async function loadDrafts() {
  const area = $("aiSavedDrafts");
  if (!area) return;
  const result = await api("listQuestionDrafts");
  drafts = (result.drafts || []).filter(q => q.status === "draft");
  area.innerHTML = drafts.map(q =>
    '<article class="item" data-saved-draft="' + esc(q.id) + '">' +
    '<label class="question-meta"><input type="checkbox" data-draft-select="' + esc(q.id) + '"> Draft चुनें • ' +
    esc(q.className) + ' • ' + esc(q.subject) + ' • ' + esc(q.topic) + '</label>' +
    '<p><b>' + esc(q.text) + '</b></p>' +
    (q.type === "subjective" ? '<details><summary>Model Answer देखें</summary><p>' + esc(q.modelAnswer) + '</p></details>' :
      '<p>' + esc((q.options || []).join(" • ")) + '</p><p>सही उत्तर: ' + esc((q.options || [])[Number(q.answer)] || "") + '</p>') +
    '<p>' + esc(q.explanation || "") + '</p><p class="hint">Marks: ' + Number(q.marks || 5) + '</p>' +
    '<button type="button" class="secondary" data-delete-draft="' + esc(q.id) + '">Delete Draft</button></article>'
  ).join("") || '<div class="empty-state">अभी कोई Saved Draft नहीं है। Pending प्रश्न पर Save as Draft दबाएँ।</div>';
}

function decorate() {
  const pending = $("aiPending");
  if (pending) {
    pending.querySelectorAll("article.item").forEach(card => {
      const approve = card.querySelector("[data-ai-approve]");
      if (!approve || card.querySelector(".qtools-pending")) return;
      const id = approve.dataset.aiApprove;
      const marks = document.createElement("label");
      marks.textContent = "Marks";
      const input = document.createElement("input");
      input.type = "number"; input.min = "1"; input.max = "20";
      input.value = card.querySelector("[data-ai-model]") ? "5" : "1";
      input.dataset.qtoolsMarks = id;
      marks.appendChild(input);
      const controls = document.createElement("div");
      controls.className = "overview-actions qtools-pending";
      controls.innerHTML = '<button type="button" data-qtools-save-draft="' + esc(id) + '">Save as Draft</button><button type="button" class="secondary" data-qtools-delete-pending="' + esc(id) + '">Delete</button>';
      card.append(marks, controls);
    });
  }

  if ($("aiPending") && !$("aiSavedDrafts")) {
    const section = document.createElement("section");
    section.innerHTML = '<h3>Saved Drafts</h3><div id="aiSavedDrafts" class="stack"></div>';
    $("aiPending").after(section);
    loadDrafts().catch(e => notify(e.message));
  }

  const approved = $("aiApproved");
  if (approved) approved.querySelectorAll("[data-bank-card]").forEach(card => {
    if (card.querySelector("[data-qtools-bank-marks]")) return;
    const save = card.querySelector("[data-bank-save]");
    if (!save) return;
    const marks = document.createElement("label");
    marks.textContent = "Marks (Subjective में शिक्षक इसी के अनुसार जाँचेंगे)";
    const input = document.createElement("input");
    input.type = "number"; input.min = "1"; input.max = "20";
    input.value = card.querySelector("[data-bank-model]") ? "5" : "1";
    input.dataset.qtoolsBankMarks = "1";
    marks.appendChild(input);
    const del = document.createElement("button");
    del.type = "button"; del.className = "secondary";
    del.dataset.qtoolsDeleteBank = save.dataset.bankSave;
    del.textContent = "Delete Question";
    save.after(marks, del);
  });
}

async function saveDraft(id, card) {
  const options = card.querySelector("[data-ai-options]");
  const question = {
    text: card.querySelector("[data-ai-text]")?.value || "",
    explanation: card.querySelector("[data-ai-explanation]")?.value || "",
    marks: Number(card.querySelector("[data-qtools-marks]")?.value || 1)
  };
  if (options) {
    question.options = options.value.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    question.answer = Number(card.querySelector("[data-ai-answer]")?.value);
  } else {
    question.modelAnswer = card.querySelector("[data-ai-model]")?.value || "";
  }
  await api("reviewQuestionDraft", { id, decision: "saveDraft", question });
  notify("प्रश्न Draft में सुरक्षित हो गया।");
  await loadDrafts();
  card.remove();
}

async function publishSelected() {
  const approvedBoxes = [...document.querySelectorAll("#aiApproved [data-bank-select]:checked")];
  const draftBoxes = [...document.querySelectorAll("#aiSavedDrafts [data-draft-select]:checked")];
  if (!approvedBoxes.length && !draftBoxes.length) throw new Error("पहले Approved या Saved Draft प्रश्न चुनें।");
  const title = $("bankPublishTitle")?.value.trim();
  const className = $("bankPublishClass")?.value.trim();
  const subject = $("bankPublishSubject")?.value.trim();
  const topic = $("bankPublishTopic")?.value.trim();
  const duration = Number($("bankPublishDuration")?.value);
  if (!title || !className || !subject || !topic) throw new Error("Quiz Title, Class, Subject और Topic भरें।");
  if (!Number.isInteger(duration) || duration < 1 || duration > 600) throw new Error("Duration 1 से 600 मिनट रखें।");

  const questions = [];
  for (const box of approvedBoxes) {
    const card = box.closest("[data-bank-card]");
    const options = card.querySelector("[data-bank-options]");
    questions.push({
      text: card.querySelector("[data-bank-text]")?.value.trim() || "",
      type: options ? "objective" : "subjective",
      options: options ? options.value.split(/\r?\n/).map(x => x.trim()).filter(Boolean) : [],
      answer: options ? Number(card.querySelector("[data-bank-answer]")?.value) : null,
      modelAnswer: card.querySelector("[data-bank-model]")?.value || "",
      explanation: card.querySelector("[data-bank-explanation]")?.value || "",
      marks: Number(card.querySelector("[data-qtools-bank-marks]")?.value || (options ? 1 : 5)),
      topic
    });
  }
  for (const box of draftBoxes) {
    const q = drafts.find(x => x.id === box.dataset.draftSelect);
    if (!q) throw new Error("एक Draft उपलब्ध नहीं है। Refresh करके फिर चुनें।");
    questions.push({
      text: q.text, type: q.type, options: q.options || [], answer: q.answer,
      modelAnswer: q.modelAnswer || "", explanation: q.explanation || "",
      marks: Number(q.marks || (q.type === "subjective" ? 5 : 1)), topic
    });
  }
  if (questions.some(q => !q.text || (q.type === "subjective" && !q.modelAnswer) ||
      (q.type === "objective" && (q.options.length !== 4 || !Number.isInteger(q.answer) || q.answer < 0 || q.answer > 3)))) {
    throw new Error("चुने गए प्रश्नों में कोई जानकारी अधूरी है। पहले Edit करके Save करें।");
  }
  const result = await api("saveQuiz", {
    title, className, subject, topic, duration, questions,
    quizType: questions.every(q => q.type === "objective") ? "objective" :
      questions.every(q => q.type === "subjective") ? "subjective" : "mixed",
    publish: true
  });
  if (draftBoxes.length) await api("setQuestionDraftStatus", {
    ids: draftBoxes.map(x => x.dataset.draftSelect), status: "published"
  });
  notify("Quiz Publish हो गया • " + result.questionCount + " प्रश्न");
  await loadDrafts();
  document.querySelectorAll("#aiApproved [data-bank-select],#aiSavedDrafts [data-draft-select]").forEach(x => x.checked = false);
}

document.addEventListener("click", async event => {
  const saveDraftButton = event.target.closest("[data-qtools-save-draft]");
  const deletePending = event.target.closest("[data-qtools-delete-pending]");
  const deleteDraft = event.target.closest("[data-delete-draft]");
  const deleteBank = event.target.closest("[data-qtools-delete-bank]");
  const saveBank = event.target.closest("[data-bank-save]");
  const publish = event.target.closest("#bankPublish");

  if (saveDraftButton) {
    event.preventDefault(); event.stopImmediatePropagation();
    const card = saveDraftButton.closest("article");
    try { saveDraftButton.disabled = true; await saveDraft(saveDraftButton.dataset.qtoolsSaveDraft, card); }
    catch (e) { saveDraftButton.disabled = false; notify(e.message); }
  } else if (deletePending) {
    event.preventDefault(); event.stopImmediatePropagation();
    if (!confirm("यह Pending प्रश्न हमेशा के लिए Delete करना है?")) return;
    try { await api("deleteQuestionDraft", { id: deletePending.dataset.qtoolsDeletePending }); deletePending.closest("article").remove(); }
    catch (e) { notify(e.message); }
  } else if (deleteDraft) {
    event.preventDefault(); event.stopImmediatePropagation();
    if (!confirm("यह Saved Draft हमेशा के लिए Delete करना है?")) return;
    try { await api("deleteQuestionDraft", { id: deleteDraft.dataset.deleteDraft }); await loadDrafts(); }
    catch (e) { notify(e.message); }
  } else if (deleteBank) {
    event.preventDefault(); event.stopImmediatePropagation();
    if (!confirm("यह Approved प्रश्न हमेशा के लिए Delete करना है?")) return;
    try { await api("deleteQuestionBankQuestion", { id: deleteBank.dataset.qtoolsDeleteBank }); deleteBank.closest("[data-bank-card]").remove(); }
    catch (e) { notify(e.message); }
  } else if (saveBank) {
    event.preventDefault(); event.stopImmediatePropagation();
    const card = saveBank.closest("[data-bank-card]");
    const options = card.querySelector("[data-bank-options]");
    const question = {
      text: card.querySelector("[data-bank-text]")?.value || "",
      topic: card.querySelector("[data-bank-topic]")?.value || "",
      explanation: card.querySelector("[data-bank-explanation]")?.value || "",
      marks: Number(card.querySelector("[data-qtools-bank-marks]")?.value || 1)
    };
    if (options) {
      question.options = options.value.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
      question.answer = Number(card.querySelector("[data-bank-answer]")?.value);
    } else question.modelAnswer = card.querySelector("[data-bank-model]")?.value || "";
    try { saveBank.disabled = true; await api("updateQuestionBankQuestion", { id: saveBank.dataset.bankSave, question }); notify("Approved प्रश्न अपडेट हो गया।"); }
    catch (e) { notify(e.message); }
    finally { saveBank.disabled = false; }
  } else if (publish) {
    event.preventDefault(); event.stopImmediatePropagation();
    if (busy) return;
    try { busy = true; publish.disabled = true; notify("Quiz Publish हो रहा है…"); await publishSelected(); }
    catch (e) { notify(e.message); }
    finally { busy = false; publish.disabled = false; }
  }
}, true);

const observer = new MutationObserver(() => {
  if ($("aiPending") || $("aiApproved")) decorate();
});
observer.observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener("load", decorate);
