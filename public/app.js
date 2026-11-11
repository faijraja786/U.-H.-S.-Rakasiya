import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, GoogleAuthProvider, signInWithPopup, sendPasswordResetEmail, signOut, updateProfile, setPersistence, browserLocalPersistence } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, collection, addDoc, getDocs, query, where, serverTimestamp, updateDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig), auth = getAuth(app), db = getFirestore(app), functions = getFunctions(app);
const $ = id => document.getElementById(id), call = (n,d={}) => httpsCallable(functions,n)(d).then(r=>r.data);
const esc = v => String(v ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
await setPersistence(auth,browserLocalPersistence);
let user=null, role="student", tab="home", activeQuiz=null, answers={}, timer=null, requestedLoginRole=null;

function msg(t,ok=false){$("authMessage").textContent=t;$("authMessage").className=ok?"success":"error"}
function alertMsg(t){window.alert(t)}
function panel(title,body){$("view").innerHTML='<section class="panel"><h2>'+esc(title)+'</h2>'+body+'</section>'}
function dateText(v){if(!v)return "—";const d=new Date(v);return Number.isNaN(d.getTime())?"—":d.toLocaleString("hi-IN")}
function openApp(){ $("auth").hidden=true;$("app").hidden=false }
function openLogin(){ $("auth").hidden=false;$("app").hidden=true }

$("signup").onclick=async()=>{try{requestedLoginRole="student";if($("loginRole").value!=="student")throw Error("नया account केवल Student बना सकता है। Admin account Super Admin बनाएगा।");const name=$("name").value.trim(),email=$("email").value.trim(),password=$("password").value;if(!name||!email||password.length<6)throw Error("नाम, ईमेल और कम-से-कम 6 अक्षर का password भरें।");const c=await createUserWithEmailAndPassword(auth,email,password);await updateProfile(c.user,{displayName:name})}catch(e){msg(e.message)}};
$("login").onclick=async()=>{try{requestedLoginRole=$("loginRole").value;await signInWithEmailAndPassword(auth,$("email").value.trim(),$("password").value)}catch(e){msg(e.message)}};
$("google").onclick=async()=>{try{requestedLoginRole=$("loginRole").value;await signInWithPopup(auth,new GoogleAuthProvider())}catch(e){msg(e.message)}};
$("reset").onclick=async()=>{try{const email=$("email").value.trim();if(!email)throw Error("पहले ईमेल लिखें।");await sendPasswordResetEmail(auth,email);msg("Password reset link ईमेल पर भेज दिया गया है।",true)}catch(e){msg(e.message)}};
$("logout").onclick=()=>signOut(auth);

onAuthStateChanged(auth,async u=>{
  user=u;if(!u){openLogin();return}
  const requestedRole=requestedLoginRole;
  try{
    await call("ensureStudentRole");
    const s=await getDoc(doc(db,"roles",u.uid));role=s.exists()?s.data().role:"student";
    // First Super Admin setup only works for the email configured on the server.
    if(role==="student" && requestedRole==="superadmin"){
      const boot=await call("bootstrapFirstAdmin");
      role=boot.role;
    }
    // Login type is checked against the server-side role; it never grants privileges.
    if(requestedRole && requestedRole!==role){
      requestedLoginRole=null;
      await signOut(u);
      openLogin();
      msg("इस account की role "+role.toUpperCase()+" है। कृपया सही Login Type चुनें।");
      return;
    }
    requestedLoginRole=null;
    $("loginRole").value=role;
    openApp();$("identity").textContent=(u.displayName||u.email)+" • "+role.toUpperCase();
    $("roleBadge").textContent=role==="superadmin"?"✓ SUPER ADMIN":role==="admin"?"✓ ADMIN":"✓ STUDENT";tab="home";render();
  }catch(e){await signOut(u).catch(()=>{});openLogin();msg("Role verification नहीं हो सकी: "+e.message)}
});

const studentTabs=[["home","Home"],["quiz","Available Quizzes"],["notes","Notes & PYQ"],["leaderboard","Leaderboard"],["results","My Results"],["tasks","Daily Targets"],["planner","Study Routine"],["cards","Flashcards"]];
function render(){
  const tabs=role==="superadmin"?studentTabs.concat([["admin","Admin Dashboard"],["super","Super Admin"]]):role==="admin"?studentTabs.concat([["admin","Admin Dashboard"]]):studentTabs;
  $("nav").innerHTML=tabs.map(x=>'<button data-tab="'+x[0]+'" class="'+(tab===x[0]?"active":"")+'">'+x[1]+"</button>").join("");
  $("nav").querySelectorAll("[data-tab]").forEach(b=>b.onclick=()=>{tab=b.dataset.tab;render()});
  const pages={home:homePage,quiz:quizPage,notes:notesPage,leaderboard:leaderboardPage,results:resultsPage,tasks:tasksPage,planner:plannerPage,cards:cardsPage,admin:adminPage,super:superPage};
  (pages[tab]||homePage)().catch(e=>panel("त्रुटि",'<p class="error">'+esc(e.message)+"</p>"));
}
async function homePage(){
  const s=await getDocs(query(collection(db,"quizzes"),where("status","==","published")));
  panel("स्वागत है, "+(user.displayName||"Student"),'<p>EduFuture — U.H.S. Rakasiya Smart Learning Portal</p><div class="grid"><div class="stat"><strong>'+s.size+'</strong><span>Available Quizzes</span></div><div class="stat"><strong>48 घंटे</strong><span>Result auto-release</span></div><div class="stat"><strong>'+role.toUpperCase()+'</strong><span>Verified role</span></div></div><p>Quiz हल करें, Notes पढ़ें और Daily Targets पूरे करें।');
}
async function quizPage(){
  const s=await getDocs(query(collection(db,"quizzes"),where("status","==","published")));
  panel("Available Quizzes",'<p class="hint">हर quiz का एक attempt मिलेगा। Result और rank submit करने के 48 घंटे बाद अपने-आप खुलेंगे।</p>'+(s.empty?"<p>अभी कोई quiz प्रकाशित नहीं है।</p>":s.docs.map(d=>'<article class="item"><h3>'+esc(d.data().title)+'</h3><p>'+esc(d.data().subject)+' • '+d.data().duration+' मिनट • '+d.data().questionCount+' प्रश्न</p><button data-start="'+d.id+'">Start Quiz</button></article>').join("")));
  $("view").querySelectorAll("[data-start]").forEach(b=>b.onclick=()=>startQuiz(b.dataset.start));
}
async function startQuiz(id){
  try{
    const d=await call("startQuiz",{id});activeQuiz={id:id,...d};answers={};const deadline=Date.now()+d.duration*60000;
    function draw(){
      const left=Math.max(0,Math.ceil((deadline-Date.now())/1000));
      $("view").innerHTML='<section class="panel"><h2>'+esc(activeQuiz.title)+'</h2><div class="timer" id="quizClock">'+Math.floor(left/60)+':'+String(left%60).padStart(2,"0")+'</div>'+
      activeQuiz.questions.map((q,i)=>'<article class="question"><h3>'+(i+1)+'. '+esc(q.text)+'</h3>'+q.options.map((o,j)=>'<label class="option"><input type="radio" name="q'+i+'" value="'+j+'" '+(answers[q.id]===j?"checked":"")+'> '+esc(o)+'</label>').join("")+'</article>').join("")+'<button id="submitQuiz">Submit Quiz</button></section>';
      $("view").querySelectorAll('input[type="radio"]').forEach(x=>x.onchange=()=>{const i=Number(x.name.slice(1));answers[activeQuiz.questions[i].id]=Number(x.value)});
      $("submitQuiz").onclick=submitQuiz;
    }
    draw();clearInterval(timer);timer=setInterval(()=>{const n=Math.max(0,Math.ceil((deadline-Date.now())/1000));if($("quizClock"))$("quizClock").textContent=Math.floor(n/60)+":"+String(n%60).padStart(2,"0");if(!n)submitQuiz()},1000);
  }catch(e){alertMsg(e.message)}
}
async function submitQuiz(){
  if(!activeQuiz)return;clearInterval(timer);const q=activeQuiz;activeQuiz=null;
  try{const r=await call("submitQuiz",{id:q.id,attemptId:q.attemptId,answers:answers});panel("Quiz Submitted",'<div class="success-box"><h3>आपका attempt सुरक्षित है।</h3><p>Result और rank 48 घंटे बाद अपने-आप खुलेंगे।</p><p>खुलने का समय: <b>'+dateText(r.releaseAt)+'</b></p></div>')}catch(e){alertMsg(e.message)}
}
async function leaderboardPage(){
  const s=await getDocs(query(collection(db,"quizzes"),where("status","==","published")));
  panel("U.H.S. RAKASIYA KE TUFANO",'<div class="leaderboard-banner"><span class="eyebrow">EDUFUTURE • HALL OF FAME</span><h2>U.H.S. Rakasiya Ke Tufano 🌪️</h2><p>मेहनत से पहचान, प्रदर्शन से सम्मान।</p></div>'+(s.empty?"<p>अभी कोई quiz नहीं है।</p>":s.docs.map(d=>'<article class="leaderboard-quiz"><div><h3>'+esc(d.data().title)+'</h3><p class="hint">48 घंटे बाद जारी होने वाली आधिकारिक रैंकिंग</p></div><button data-rank="'+d.id+'">रैंकिंग देखें</button><div class="leaderboard-output" id="rank-'+d.id+'"></div></article>').join("")));
  $("view").querySelectorAll("[data-rank]").forEach(b=>b.onclick=async()=>{
    const out=$("rank-"+b.dataset.rank);out.innerHTML='<p class="hint">रैंकिंग लोड हो रही है…</p>';
    try{
      const r=await call("getLeaderboard",{id:b.dataset.rank});
      if(!r.released){out.innerHTML='<div class="locked-note">🔒 Ranking अभी बंद है। '+(r.releaseAt?'खुलने का समय: '+dateText(r.releaseAt):'अभी कोई attempt submit नहीं हुआ।')+'</div>';return}
      if(!r.rows.length){out.innerHTML='<p>अभी कोई result उपलब्ध नहीं है।</p>';return}
      const medals=["🥇","🥈","🥉"];
      out.innerHTML='<div class="podium">'+r.rows.slice(0,3).map((x,i)=>'<div class="podium-card podium-'+(i+1)+'"><span class="medal">'+medals[i]+'</span><strong>#'+x.rank+'</strong><b>'+esc(x.name)+'</b><small>'+x.score+'/'+x.total+' अंक</small></div>').join("")+'</div><div class="rank-table">'+r.rows.map(x=>'<div class="rank-row '+(x.uid===user.uid?'my-rank':'')+'"><b class="rank-number">#'+x.rank+'</b><span class="rank-name">'+esc(x.name)+(x.uid===user.uid?' <em>YOU</em>':'')+'</span><strong>'+x.score+'/'+x.total+'</strong><span class="rank-percent">'+Math.round(x.total?x.score/x.total*100:0)+'%</span></div>').join("")+'</div><p class="leaderboard-motto">“हम तूफान हैं — रुकना हमारी फितरत नहीं!”</p>';
    }catch(e){out.textContent=e.message}
  });
}
async function resultsPage(){
  const r=await call("getMyResults");
  panel("My Results",r.results.length?r.results.map(x=>{
    if(!x.released)return '<article class="item"><h3>'+esc(x.title)+'</h3><p class="locked-note">🔒 Result 48 घंटे बाद खुलेगा — '+dateText(x.releaseAt)+'</p></article>';
    const correct=x.review.filter(q=>q.isCorrect).length, wrong=x.review.filter(q=>q.selectedAnswer!==null&&!q.isCorrect).length, skipped=x.review.filter(q=>q.selectedAnswer===null).length;
    const topicMap={};x.review.forEach(q=>{const t=q.topic||"General";if(!topicMap[t])topicMap[t]={total:0,correct:0};topicMap[t].total++;if(q.isCorrect)topicMap[t].correct++});
    const topicHtml=Object.entries(topicMap).map(([t,v])=>'<div class="topic-progress"><span>'+esc(t)+'</span><b>'+v.correct+'/'+v.total+'</b><div><i style="width:'+Math.round(v.correct/v.total*100)+'%"></i></div></div>').join("");
    return '<article class="result-card"><div class="result-head"><div><span class="eyebrow">EDUFUTURE PERFORMANCE REPORT</span><h3>'+esc(x.title)+'</h3></div><div class="score-ring"><strong>'+x.score+'/'+x.total+'</strong><small>Score</small></div></div><div class="result-stats"><div><b>'+correct+'</b><span>सही</span></div><div><b>'+wrong+'</b><span>गलत</span></div><div><b>'+skipped+'</b><span>छूटे</span></div><div><b>'+Math.round(x.total?correct/x.total*100:0)+'%</b><span>Accuracy</span></div></div><div class="topic-analysis"><h4>Topic-wise Performance</h4>'+topicHtml+'</div><details class="review-details"><summary>हर प्रश्न का Answer Analysis देखें</summary>'+x.review.map((q,i)=>'<section class="review-question '+(q.isCorrect?'review-correct':q.selectedAnswer===null?'review-skipped':'review-wrong')+'"><h4>Q'+(i+1)+'. '+esc(q.question)+'</h4><p class="hint">Topic: '+esc(q.topic)+' • Difficulty: '+esc(q.difficulty)+'</p><p><b>आपका उत्तर:</b> '+(q.selectedAnswer===null?'<span class="answer-skipped">उत्तर नहीं दिया</span>':esc(q.options[q.selectedAnswer]??"Invalid option"))+'</p><p><b>सही उत्तर:</b> '+(q.correctAnswer===null?'—':esc(q.options[q.correctAnswer]??"—"))+'</p><p><b>स्थिति:</b> '+(q.isCorrect?'<span class="answer-correct">सही ✓</span>':q.selectedAnswer===null?'<span class="answer-skipped">छूटा</span>':'<span class="answer-wrong">गलत ✕</span>')+'</p>'+(q.explanation?'<p><b>समझें:</b> '+esc(q.explanation)+'</p>':'')+'</section>').join("")+'</details></article>';
  }).join(""):"<p>अभी कोई quiz attempt नहीं है।</p>");
}
async function notesPage(){
  const s=await getDocs(query(collection(db,"content"),where("published","==",true)));
  panel("Notes & PYQ",s.empty?"<p>अभी Notes/PYQ उपलब्ध नहीं हैं।</p>":s.docs.map(d=>{const x=d.data();return '<article class="item"><h3>'+esc(x.title)+'</h3><p>'+esc(x.subject)+' • '+esc(x.type)+'</p><p>'+esc(x.description)+'</p><a href="'+esc(x.url)+'" target="_blank" rel="noopener">Open / Download</a></article>'}).join(""));
}
async function plannerPage(){
  const ref=doc(db,"users",user.uid,"private","planner"),s=await getDoc(ref),d=s.exists()?s.data():{};
  panel("Study Routine",'<label>मेरा Aim</label><textarea id="aim">'+esc(d.aim)+'</textarea><label>Study Routine</label><textarea id="routine">'+esc(d.routine)+'</textarea><label>आज का मुख्य लक्ष्य</label><textarea id="mainTarget">'+esc(d.target)+'</textarea><button id="saveRoutine">Save Routine</button>');
  $("saveRoutine").onclick=async()=>{await setDoc(ref,{aim:$("aim").value,routine:$("routine").value,target:$("mainTarget").value,updatedAt:serverTimestamp()});alertMsg("Study Routine save हो गई।")};
}
async function tasksPage(){
  const ref=collection(db,"users",user.uid,"tasks"),s=await getDocs(ref);
  panel("Daily Targets",'<div class="inline-form"><input id="newTask" placeholder="आज का target"><button id="addTask">Add</button></div>'+(s.empty?"<p>अभी कोई target नहीं है।</p>":s.docs.map(d=>'<label class="task-row"><input type="checkbox" data-task="'+d.id+'" '+(d.data().done?"checked":"")+'> <span class="'+(d.data().done?"done":"")+'">'+esc(d.data().text)+'</span></label>').join("")));
  $("addTask").onclick=async()=>{const t=$("newTask").value.trim();if(!t)return alertMsg("पहले target लिखें।");await addDoc(ref,{text:t,done:false,createdAt:serverTimestamp()});tasksPage()};
  $("view").querySelectorAll("[data-task]").forEach(x=>x.onchange=async()=>{await updateDoc(doc(ref,x.dataset.task),{done:x.checked});x.nextElementSibling.classList.toggle("done",x.checked)});
}
async function cardsPage(){
  const ref=collection(db,"users",user.uid,"flashcards"),s=await getDocs(ref);
  panel("Flashcards",'<label>Question</label><input id="front" placeholder="Question / Front"><label>Answer</label><textarea id="back" placeholder="Answer / Back"></textarea><button id="saveCard">Save Flashcard</button>'+(s.empty?"<p>अभी कोई flashcard नहीं है।</p>":s.docs.map(d=>'<article class="item"><b>'+esc(d.data().front)+'</b><details><summary>Answer देखें</summary><p>'+esc(d.data().back)+'</p></details></article>').join("")));
  $("saveCard").onclick=async()=>{const f=$("front").value.trim(),b=$("back").value.trim();if(!f||!b)return alertMsg("Question और Answer दोनों भरें।");await addDoc(ref,{front:f,back:b,createdAt:serverTimestamp()});cardsPage()};
}
async function adminPage(){
  if(role!=="admin"&&role!=="superadmin")return;
  panel("Admin Dashboard",'<div class="grid"><div class="item"><h3>Create Quiz</h3><label>Title</label><input id="quizTitle"><label>Subject</label><input id="quizSubject"><label>Duration (minutes)</label><input id="quizDuration" type="number" value="30"><div id="questionEditor"></div><button id="addQuestion">+ Add Question</button><button id="publishQuiz">Publish Quiz</button></div><div class="item"><h3>Notes / PYQ</h3><label>Title</label><input id="contentTitle"><label>Subject</label><input id="contentSubject"><label>Type</label><select id="contentType"><option value="note">Notes</option><option value="pyq">PYQ</option><option value="resource">Resource</option></select><label>Description</label><textarea id="contentDescription"></textarea><label>Hosted file URL</label><input id="contentUrl" type="url" placeholder="https://..."><button id="saveContent">Publish Content</button><p class="hint">यहाँ पहले से hosted PDF/file का link दें। Firebase Storage upload billing/setup पर निर्भर है।</p></div><div class="item"><h3>Student Management</h3><button id="loadStudents">View Students</button><div id="studentList"></div></div><div class="item"><h3>Student Results</h3><div id="adminResults">Loading quizzes…</div></div></div>');
  const quizSnap=await getDocs(collection(db,"quizzes"));
  $("adminResults").innerHTML=quizSnap.empty?"<p>अभी कोई Quiz नहीं है।</p>":quizSnap.docs.map(d=>'<div class="admin-row"><span>'+esc(d.data().title)+'</span><button data-admin-result="'+d.id+'">View Results</button></div><div id="admin-result-'+d.id+'"></div>').join("");
  $("adminResults").querySelectorAll("[data-admin-result]").forEach(b=>b.onclick=async()=>{const out=$("admin-result-"+b.dataset.adminResult);out.textContent="Loading…";try{const r=await call("getLeaderboard",{id:b.dataset.adminResult});out.innerHTML=r.rows.length?"<ol>"+r.rows.map(x=>"<li>"+esc(x.name)+" — "+x.score+"/"+x.total+"</li>").join("")+"</ol>":"<p>अभी कोई submitted result नहीं है।</p>"}catch(e){out.textContent=e.message}});
  let n=0;function addQ(){const i=n++;$("questionEditor").insertAdjacentHTML("beforeend",'<article class="question" data-q="'+i+'"><h4>Question '+(i+1)+'</h4><textarea class="qtext" placeholder="Question"></textarea><label>Topic / Chapter</label><input class="qtopic" placeholder="जैसे: Algebra, Motion, History"><label>Difficulty</label><select class="qdifficulty"><option value="easy">Easy</option><option value="medium" selected>Medium</option><option value="hard">Hard</option></select>'+[0,1,2,3].map(j=>'<input class="qopt" placeholder="Option '+(j+1)+'">').join("")+'<label>Correct option</label><select class="qans"><option value="0">A</option><option value="1">B</option><option value="2">C</option><option value="3">D</option></select><label>Answer Explanation</label><textarea class="qexplanation" placeholder="यह उत्तर सही क्यों है?"></textarea></article>')}
  addQ();$("addQuestion").onclick=addQ;
  $("publishQuiz").onclick=async()=>{try{const qs=[...$("questionEditor").querySelectorAll("[data-q]")].map(x=>({text:x.querySelector(".qtext").value.trim(),topic:x.querySelector(".qtopic").value.trim(),difficulty:x.querySelector(".qdifficulty").value,options:[...x.querySelectorAll(".qopt")].map(y=>y.value.trim()),answer:Number(x.querySelector(".qans").value),explanation:x.querySelector(".qexplanation").value.trim()}));const r=await call("saveQuiz",{title:$("quizTitle").value.trim(),subject:$("quizSubject").value.trim(),duration:Number($("quizDuration").value),questions:qs,publish:true});alertMsg("Quiz publish हो गया। ID: "+r.id);tab="quiz";render()}catch(e){alertMsg(e.message)}};
  $("saveContent").onclick=async()=>{try{await call("addContent",{title:$("contentTitle").value.trim(),subject:$("contentSubject").value.trim(),type:$("contentType").value,description:$("contentDescription").value,url:$("contentUrl").value.trim(),published:true});alertMsg("Content publish हो गया।");$("contentTitle").value="";$("contentUrl").value=""}catch(e){alertMsg(e.message)}};
  $("loadStudents").onclick=async()=>{try{const r=await call("listStudents");$("studentList").innerHTML=r.students.length?r.students.map(x=>"<p>"+esc(x.displayName||x.email||x.uid)+"</p>").join(""):"<p>कोई student record नहीं मिला।</p>"}catch(e){$("studentList").textContent=e.message}};
}
async function superPage(){
  if(role!=="superadmin")return;
  panel("Super Admin Controls",'<div class="item"><h3>Create Admin</h3><p class="hint">Admin का account पहले से बना होना चाहिए।</p><input id="adminEmail" type="email" placeholder="Registered admin email"><button id="createAdmin">Create Admin</button></div><div class="item"><h3>Manage All Admins</h3><button id="refreshAdmins">Refresh List</button><div id="adminList"></div></div>');
  async function load(){try{const r=await call("listAdmins");$("adminList").innerHTML=r.admins.map(a=>'<div class="admin-row"><span>'+esc(a.displayName||a.email||a.uid)+' — '+esc(a.role)+'</span>'+(a.role==="admin"?'<button class="danger" data-remove="'+a.uid+'">Remove Admin</button>':"")+"</div>").join("")||"<p>कोई Admin नहीं है।</p>";$("adminList").querySelectorAll("[data-remove]").forEach(b=>b.onclick=async()=>{if(!confirm("क्या इस Admin की भूमिका Student करनी है?"))return;try{await call("removeAdmin",{uid:b.dataset.remove});alertMsg("Admin role हटा दी गई।");load()}catch(e){alertMsg(e.message)}})}catch(e){$("adminList").textContent=e.message}}
  $("createAdmin").onclick=async()=>{try{await call("addAdmin",{email:$("adminEmail").value.trim()});alertMsg("Admin बना दिया गया।");$("adminEmail").value="";load()}catch(e){alertMsg(e.message)}};
  $("refreshAdmins").onclick=load;load();
}
