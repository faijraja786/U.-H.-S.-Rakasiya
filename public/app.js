import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, GoogleAuthProvider, signInWithPopup, sendPasswordResetEmail, signOut, updateProfile, setPersistence, browserLocalPersistence } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, collection, addDoc, getDocs, query, where, serverTimestamp, updateDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";
import { firebaseConfig, API_BASE } from "./firebase-config.js";

const app = initializeApp(firebaseConfig), auth = getAuth(app), db = getFirestore(app), storage = getStorage(app);
if ("serviceWorker" in navigator) window.addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").catch(()=>{}));
const $ = id => document.getElementById(id);
const call = async (name, data = {}) => {
  const current = auth.currentUser;
  if (!current) throw new Error("कृपया पहले login करें।");
  const token = await current.getIdToken();
  const response = await fetch(API_BASE.replace(/\/+$/, "") + "/api/" + encodeURIComponent(name), {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
    body: JSON.stringify({ data })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || "Server से संपर्क नहीं हो सका।");
  return result.data;
};
const esc = v => String(v ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
await setPersistence(auth,browserLocalPersistence);
let user=null, role="student", tab="home", activeQuiz=null, answers={}, timer=null;

function msg(t,ok=false){$("authMessage").textContent=t;$("authMessage").className=ok?"success":"error"}
function alertMsg(t){window.alert(t)}
function panel(title,body){$("view").innerHTML='<section class="panel"><h2>'+esc(title)+'</h2>'+body+'</section>'}
function dateText(v){if(!v)return "—";const d=new Date(v);return Number.isNaN(d.getTime())?"—":d.toLocaleString("hi-IN")}
function openApp(){ $("auth").hidden=true;$("app").hidden=false }
function openLogin(){ $("auth").hidden=false;$("app").hidden=true }

$("signup").onclick=async()=>{try{const name=$("name").value.trim(),email=$("email").value.trim(),password=$("password").value;if(!name||!email||password.length<6)throw Error("नाम, ईमेल और कम-से-कम 6 अक्षर का password भरें।");const c=await createUserWithEmailAndPassword(auth,email,password);await updateProfile(c.user,{displayName:name})}catch(e){msg(e.message)}};
$("login").onclick=async()=>{try{await signInWithEmailAndPassword(auth,$("email").value.trim(),$("password").value)}catch(e){msg(e.message)}};
$("google").onclick=async()=>{try{await signInWithPopup(auth,new GoogleAuthProvider())}catch(e){msg(e.message)}};
$("reset").onclick=async()=>{try{const email=$("email").value.trim();if(!email)throw Error("पहले ईमेल लिखें।");await sendPasswordResetEmail(auth,email);msg("Password reset link ईमेल पर भेज दिया गया है।",true)}catch(e){msg(e.message)}};
$("profileToggle").onclick=()=>{const menu=$("profileMenu"),open=menu.hidden;menu.hidden=!open;$("profileToggle").setAttribute("aria-expanded",String(open))};
document.addEventListener("click",e=>{if(!e.target.closest(".profile-wrap")){$("profileMenu").hidden=true;$("profileToggle").setAttribute("aria-expanded","false")}});
$("menuToggle").onclick=()=>{
  const mobile=window.matchMedia("(max-width: 800px)").matches;
  if(mobile){const open=!$("app").classList.contains("menu-open");$("app").classList.toggle("menu-open",open);$("menuToggle").setAttribute("aria-expanded",String(open))}
  else $("app").classList.toggle("sidebar-collapsed");
};
$("sidebarOverlay").onclick=closeWorkspaceMenu;
$("logout").onclick=()=>signOut(auth);

onAuthStateChanged(auth,async u=>{
  user=u;if(!u){openLogin();return}
  try{
    const roleInfo=await call("ensureStudentRole");
    role=roleInfo?.role||"student";
    // The first configured bootstrap email is promoted automatically; all other students remain students.
    if(role==="student"){
      try{const promoted=await call("bootstrapFirstAdmin");role=promoted?.role||"superadmin"}catch{}
    }
    // Refresh the authoritative role once after bootstrap; never infer access from the visible label.
    const roleSnap=await getDoc(doc(db,"roles",u.uid));
    if(roleSnap.exists()&&["student","teacher","admin","superadmin"].includes(roleSnap.data().role))role=roleSnap.data().role;
    if(!["student","teacher","admin","superadmin"].includes(role))role="student";
    const displayName=u.displayName||u.email||"User";
    $("identity").textContent=displayName;
    $("avatarInitial").textContent=(displayName.trim().charAt(0)||"U").toLocaleUpperCase("hi-IN");
    $("profileName").textContent=displayName;
    $("profileEmail").textContent=u.email||"";
    $("profileRole").textContent=role==="superadmin"?"Super Teacher":role==="admin"?"Teacher":role==="teacher"?"Teacher":"Student";
    $("roleBadge").textContent="✓ "+$("profileRole").textContent.toUpperCase();
    $("profileMenu").hidden=true;
    openApp();
    tab="home";
    render();
  }catch(e){await signOut(u).catch(()=>{});openLogin();msg("Role verification नहीं हो सकी: "+e.message)}
});

const studentTabs=[["home","Home"],["quiz","Available Quizzes"],["notes","Notes & PYQ"],["leaderboard","Leaderboard"],["results","My Results"],["doubts","Doubt Solving"],["tasks","Daily Targets"],["planner","Study Routine"],["cards","Flashcards"]];
function closeWorkspaceMenu(){
  $("app").classList.remove("menu-open");
  $("menuToggle").setAttribute("aria-expanded","false");
}
function render(){
  let tabs=studentTabs;
  if(role==="teacher")tabs=[["home","Home"],["teacher","Teacher Workspace"]];
  if(role==="admin")tabs=[["home","Home"],["teacher","Teacher Workspace"],["admin","Admin Dashboard"]];
  if(role==="superadmin")tabs=[["home","Home"],["overview","Overview"],["teacher","Teacher Workspace"],["admin","Admin Dashboard"],["super","Super Admin"]];
  if(!tabs.some(x=>x[0]===tab))tab=tabs[0][0];
  $("nav").innerHTML='<div class="nav-section-label">MENU</div>'+tabs.map(x=>'<button data-tab="'+x[0]+'" class="nav-link '+(tab===x[0]?"active":"")+'"><span class="nav-icon">'+({overview:"◈",home:"⌂",quiz:"▤",notes:"▧",leaderboard:"♛",results:"◷",doubts:"✉",tasks:"✓",planner:"▦",cards:"▣",teacher:"▤",admin:"⚙",super:"♜"}[x[0]]||"•")+'</span><span>'+x[1]+"</span></button>").join("");
  $("nav").querySelectorAll("[data-tab]").forEach(b=>b.onclick=()=>{tab=b.dataset.tab;render();closeWorkspaceMenu()});
  const pages={overview:superOverviewPage,home:homePage,quiz:quizPage,notes:notesPage,leaderboard:leaderboardPage,results:resultsPage,doubts:doubtsPage,teacher:teacherPage,tasks:tasksPage,planner:plannerPage,cards:cardsPage,admin:adminPage,super:superPage};
  (pages[tab]||homePage)().catch(e=>panel("त्रुटि",'<p class="error">'+esc(e.message)+"</p>"));
}
async function superOverviewPage(){
  const [quizSnap,admins,students]=await Promise.all([
    getDocs(collection(db,"quizzes")),
    call("listAdmins").catch(()=>({admins:[]})),
    call("listStudents").catch(()=>({students:[]}))
  ]);
  panel("Super Admin Overview",'<div class="admin-welcome"><span class="eyebrow">EDUFUTURE • SYSTEM CONTROL</span><h2>पूरा संस्थान, एक ही Control Center</h2><p>Users, teachers, quizzes और learning operations पर नज़र रखें।</p><div class="overview-actions"><button data-super-admin>Admin Management</button><button data-super-tools>Open Admin Dashboard</button></div></div><div class="grid"><div class="stat"><strong>'+Number(students.students?.length||0)+'</strong><span>Registered Students</span></div><div class="stat"><strong>'+Number(admins.admins?.length||0)+'</strong><span>Admins & Super Admins</span></div><div class="stat"><strong>'+quizSnap.size+'</strong><span>Total Quizzes</span></div></div><div class="super-welcome-note"><b>Super Admin Access</b><p>यह workspace केवल संस्थान के मुख्य नियंत्रण के लिए है। Student dashboard अलग account role में ही उपलब्ध होगा।</p></div>');
  $("view").querySelector("[data-super-admin]").onclick=()=>{tab="super";render()};
  $("view").querySelector("[data-super-tools]").onclick=()=>{tab="admin";render()};
}
async function homePage(){
  const [quizSnap,resultData]=await Promise.all([getDocs(query(collection(db,"quizzes"),where("status","==","published"))),call("getMyResults").catch(()=>({results:[]}))]);
  const myResults=resultData.results||[];
  const released=myResults.filter(x=>x.released).sort((a,b)=>new Date(b.releaseAt||0)-new Date(a.releaseAt||0)), tests=myResults.length;
  const marks=released.reduce((n,x)=>n+Number(x.score||0),0), total=released.reduce((n,x)=>n+Number(x.total||0),0);
  const accuracy=total?Math.round(marks/total*100):0;
  let rankText="—";
  if(released.length){try{const board=await call("getLeaderboard",{id:released[0].quizId});const mine=board.rows.find(x=>x.uid===user.uid);if(mine)rankText="#"+mine.rank}catch{}}
  panel("स्वागत है, "+(user.displayName||"EduFuture User"),'<div class="dashboard-hero"><span class="eyebrow">EDUFUTURE • YOUR WORKSPACE</span><h2>आज सीखें, कल आगे बढ़ें।</h2><p>अपनी पढ़ाई और स्कूल के सभी उपलब्ध काम एक ही जगह से शुरू करें।</p><button data-goquiz>नया टेस्ट शुरू करें</button></div><div class="grid"><div class="stat"><strong>'+quizSnap.size+'</strong><span>Available Quizzes</span></div><div class="stat"><strong>'+tests+'</strong><span>Tests Attempted</span></div><div class="stat"><strong>'+marks+'/'+total+'</strong><span>Marks Earned</span></div><div class="stat"><strong>'+accuracy+'%</strong><span>Accuracy</span></div><div class="stat"><strong>'+rankText+'</strong><span>Latest Quiz Rank</span></div></div><div class="dashboard-shortcuts"><button data-godoubts>Ask a Doubt</button><button data-goresults>Test History</button><button data-gonotes>Study Notes</button></div>');
  $("view").querySelector("[data-goquiz]").onclick=()=>{tab="quiz";render()};
  $("view").querySelector("[data-godoubts]").onclick=()=>{tab="doubts";render()};
  $("view").querySelector("[data-goresults]").onclick=()=>{tab="results";render()};
  $("view").querySelector("[data-gonotes]").onclick=()=>{tab="notes";render()};
}
async function quizPage(){
  const s=await getDocs(query(collection(db,"quizzes"),where("status","==","published")));
  const cards=await Promise.all(s.docs.map(async d=>{
    const q=d.data(), attemptSnap=await getDoc(doc(db,"quizzes",d.id,"attempts",user.uid));
    const attempt=attemptSnap.exists()?attemptSnap.data():null;
    const closeMs=q.closesAt?.toMillis?.() || (q.publishedAt?.toMillis?.()||0)+48*60*60*1000;
    const resultMs=q.resultsAt?.toMillis?.() || (q.publishedAt?.toMillis?.()||0)+72*60*60*1000;
    let action="";
    if(attempt?.status==="submitted"){
      action='<div class="quiz-status submitted"><b>✓ Attempt जमा हो चुका है</b><p>Result और Rank जारी होने में <strong data-countdown="'+resultMs+'"></strong></p><small>जारी होने का समय: '+dateText(new Date(resultMs).toISOString())+'</small></div>';
    }else if(attempt?.status==="started"){
      action='<div class="quiz-status in-progress"><b>आपका attempt जारी है</b><p>बचा हुआ समय: <strong data-countdown="'+attempt.expiresAt.toMillis()+'"></strong></p><button data-start="'+d.id+'">Continue Quiz</button></div>';
    }else if(Date.now()>=closeMs){
      action='<div class="quiz-status unavailable"><b>यह प्रश्नपत्र अब उपलब्ध नहीं है</b><p>Attempt करने की 48 घंटे की अवधि समाप्त हो गई।</p></div>';
    }else{
      action='<div class="quiz-status available"><b>अभी उपलब्ध • 48 घंटे तक</b><p>Attempt बंद होने में <strong data-countdown="'+closeMs+'"></strong></p><button data-start="'+d.id+'">Start Quiz</button></div>';
    }
    return '<article class="item quiz-window-card"><div class="question-meta"><span>'+esc(q.subject||"General")+'</span><span>'+Number(q.questionCount||0)+' प्रश्न</span><span>'+Number(q.duration||0)+' मिनट</span></div><h3>'+esc(q.title)+'</h3>'+action+'</article>';
  }));
  panel("Available Quizzes",'<div class="quiz-window-banner"><span class="eyebrow">EDUFUTURE • LIMITED ATTEMPT WINDOW</span><h2>हर प्रश्नपत्र के लिए 48 घंटे</h2><p>पहले 48 घंटे में attempt करें। Result और सभी की Rank प्रश्नपत्र upload होने के 72 घंटे बाद खुलेंगे।</p></div>'+(cards.length?cards.join(""):"<p>अभी कोई quiz प्रकाशित नहीं है।</p>"));
  const tick=()=>{$("view").querySelectorAll("[data-countdown]").forEach(el=>{const ms=Number(el.dataset.countdown)-Date.now();if(ms<=0){el.textContent="अब उपलब्ध है — पेज refresh करें";return}const h=Math.floor(ms/3600000),m=Math.floor(ms%3600000/60000),sec=Math.floor(ms%60000/1000);el.textContent=h+"घं "+m+"मि "+sec+"से"});};
  tick();clearInterval(window.quizCountdownTimer);window.quizCountdownTimer=setInterval(tick,1000);
  $("view").querySelectorAll("[data-start]").forEach(b=>b.onclick=()=>startQuiz(b.dataset.start));
}
async function startQuiz(id){
  try{
    const d=await call("startQuiz",{id});activeQuiz={id:id,...d};answers={};const deadline=new Date(d.expiresAt).getTime();
    function draw(){
      const left=Math.max(0,Math.ceil((deadline-Date.now())/1000));
      $("view").innerHTML='<section class="panel"><h2>'+esc(activeQuiz.title)+'</h2><div class="timer" id="quizClock">'+Math.floor(left/60)+':'+String(left%60).padStart(2,"0")+'</div>'+
      activeQuiz.questions.map((q,i)=>'<article class="question"><div class="question-meta"><span>'+esc(q.type==="subjective"?"SUBJECTIVE":"OBJECTIVE")+'</span><span>'+esc(q.difficulty||"medium")+'</span><span>'+Number(q.marks||1)+' अंक</span></div><h3>'+(i+1)+'. '+esc(q.text)+'</h3>'+(q.type==="subjective"?'<textarea class="subjective-answer" data-answer="'+esc(q.id)+'" placeholder="अपना उत्तर लिखें" maxlength="5000">'+esc(answers[q.id]||"")+'</textarea>':q.options.map((o,j)=>'<label class="option"><input type="radio" name="q'+i+'" value="'+j+'" '+(answers[q.id]===j?"checked":"")+' > '+esc(o)+'</label>').join(""))+'</article>').join("")+'<button id="submitQuiz">Submit Quiz</button></section>';
      $("view").querySelectorAll('input[type="radio"]').forEach(x=>x.onchange=()=>{const i=Number(x.name.slice(1));answers[activeQuiz.questions[i].id]=Number(x.value)});
      $("view").querySelectorAll(".subjective-answer").forEach(x=>x.oninput=()=>{answers[x.dataset.answer]=x.value});
      $("submitQuiz").onclick=submitQuiz;
    }
    draw();clearInterval(timer);timer=setInterval(()=>{const n=Math.max(0,Math.ceil((deadline-Date.now())/1000));if($("quizClock"))$("quizClock").textContent=Math.floor(n/60)+":"+String(n%60).padStart(2,"0");if(!n)submitQuiz()},1000);
  }catch(e){alertMsg(e.message)}
}
async function submitQuiz(){
  if(!activeQuiz||activeQuiz.submitting)return;
  clearInterval(timer);const q=activeQuiz;q.submitting=true;
  try{
    const r=await call("submitQuiz",{id:q.id,attemptId:q.attemptId,answers:answers});
    activeQuiz=null;
    panel("Quiz Submitted",'<div class="success-box"><h3>आपका attempt सुरक्षित है।</h3><p>Result और Rank प्रश्नपत्र upload होने के 72 घंटे बाद खुलेंगे।</p><p>खुलने का समय: <b>'+dateText(r.releaseAt)+'</b></p></div>');
  }catch(e){q.submitting=false;alertMsg(e.message)}
}
async function leaderboardPage(){
  const s=await getDocs(query(collection(db,"quizzes"),where("status","==","published")));
  panel("U.H.S. RAKASIYA KE TUFANO",'<div class="leaderboard-banner"><span class="eyebrow">EDUFUTURE • HALL OF FAME</span><h2>U.H.S. Rakasiya Ke Tufano 🌪️</h2><p>मेहनत से पहचान, प्रदर्शन से सम्मान।</p></div>'+(s.empty?"<p>अभी कोई quiz नहीं है।</p>":s.docs.map(d=>'<article class="leaderboard-quiz"><div><h3>'+esc(d.data().title)+'</h3><p class="hint">प्रश्नपत्र upload होने के 72 घंटे बाद जारी होने वाली आधिकारिक रैंकिंग</p></div><button data-rank="'+d.id+'">रैंकिंग देखें</button><div class="leaderboard-output" id="rank-'+d.id+'"></div></article>').join("")));
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
    if(!x.released)return '<article class="item"><h3>'+esc(x.title)+'</h3><p class="locked-note">🔒 Result और Rank 72 घंटे बाद खुलेंगे — '+dateText(x.releaseAt)+'</p></article>';
    const correct=x.review.filter(q=>q.type!=="subjective"&&q.isCorrect).length, wrong=x.review.filter(q=>q.type!=="subjective"&&q.selectedAnswer!==null&&!q.isCorrect).length, skipped=x.review.filter(q=>q.selectedAnswer===null||q.selectedAnswer==="").length, pending=x.review.filter(q=>q.type==="subjective"&&q.awardedMarks===null).length;
    const topicMap={};x.review.forEach(q=>{const t=q.topic||"General";if(!topicMap[t])topicMap[t]={total:0,correct:0};topicMap[t].total++;if(q.isCorrect)topicMap[t].correct++});
    const topicHtml=Object.entries(topicMap).map(([t,v])=>'<div class="topic-progress"><span>'+esc(t)+'</span><b>'+v.correct+'/'+v.total+'</b><div><i style="width:'+Math.round(v.correct/v.total*100)+'%"></i></div></div>').join("");
    return '<article class="result-card"><div class="result-head"><div><span class="eyebrow">EDUFUTURE PERFORMANCE REPORT</span><h3>'+esc(x.title)+'</h3></div><div class="score-ring"><strong>'+x.score+'/'+x.total+'</strong><small>Score</small></div></div><div class="result-stats"><div><b>'+correct+'</b><span>सही</span></div><div><b>'+wrong+'</b><span>गलत</span></div><div><b>'+skipped+'</b><span>छूटे</span></div><div><b>'+pending+'</b><span>जाँच बाकी</span></div><div><b>'+Math.round(x.total?correct/x.total*100:0)+'%</b><span>Objective Accuracy</span></div></div><div class="topic-analysis"><h4>Topic-wise Performance</h4>'+topicHtml+'</div><details class="review-details"><summary>हर प्रश्न का Answer Analysis देखें</summary>'+x.review.map((q,i)=>{const subjective=q.type==="subjective";const selected=subjective?(q.selectedAnswer||"उत्तर नहीं दिया"):(q.selectedAnswer===null?"उत्तर नहीं दिया":(q.options[q.selectedAnswer]??"Invalid option"));const status=subjective?(q.awardedMarks===null?"Teacher review pending":"जाँचा गया: "+q.awardedMarks+"/"+q.marks):(q.isCorrect?"सही ✓":q.selectedAnswer===null?"छूटा":"गलत ✕");return '<section class="review-question '+(q.isCorrect?'review-correct':q.selectedAnswer===null?'review-skipped':'review-wrong')+'"><h4>Q'+(i+1)+'. '+esc(q.question)+'</h4><p class="hint">Topic: '+esc(q.topic)+' • Difficulty: '+esc(q.difficulty)+' • '+esc(q.type||"objective")+'</p><p><b>आपका उत्तर:</b> '+esc(selected)+'</p>'+(subjective?'<p><b>Model Answer:</b> '+esc(q.modelAnswer||"Teacher review")+'</p>':'<p><b>सही उत्तर:</b> '+(q.correctAnswer===null?'—':esc(q.options[q.correctAnswer]??"—"))+'</p>')+'<p><b>स्थिति:</b> '+esc(status)+'</p>'+(q.explanation?'<p><b>समझें:</b> '+esc(q.explanation)+'</p>':'')+'</section>'}).join("")+'</details></article>';
  }).join(""):"<p>अभी कोई quiz attempt नहीं है।</p>");
}
async function notesPage(){
  const s=await getDocs(query(collection(db,"content"),where("published","==",true)));
  panel("Notes & PYQ",s.empty?"<p>अभी Notes/PYQ उपलब्ध नहीं हैं।</p>":s.docs.map(d=>{const x=d.data();return '<article class="item"><h3>'+esc(x.title)+'</h3><p>'+esc(x.subject)+' • '+esc(x.type)+'</p><p>'+esc(x.description)+'</p><a href="'+esc(x.url)+'" target="_blank" rel="noopener">Open / Download</a></article>'}).join(""));
}
async function doubtsPage(){
  const mine=await call("listDoubts");
  panel("Doubt Solving",'<div class="doubt-compose"><h3>अपना सवाल पूछें</h3><label>Subject</label><input id="doubtSubject" placeholder="जैसे Science, Maths"><label>Topic (वैकल्पिक)</label><input id="doubtTopic" placeholder="Chapter / Topic"><label>Question</label><textarea id="doubtQuestion" maxlength="5000" placeholder="अपना सवाल विस्तार से लिखें…"></textarea><button id="sendDoubt">Submit Doubt</button></div><h3>मेरे सवाल</h3>'+(mine.doubts.length?mine.doubts.map(x=>'<article class="item"><div class="question-meta"><span>'+esc(x.subject)+'</span><span>'+esc(x.status)+'</span></div><h4>'+esc(x.topic||"General")+'</h4><p>'+esc(x.question)+'</p>'+(x.reply?'<div class="teacher-reply"><b>Teacher Reply</b><p>'+esc(x.reply)+'</p></div>':'<p class="hint">Teacher के जवाब का इंतज़ार है।</p>')+'</article>').join(""):'<p>अभी कोई सवाल नहीं पूछा गया है।</p>'));
  $("sendDoubt").onclick=async()=>{try{await call("createDoubt",{subject:$("doubtSubject").value.trim(),topic:$("doubtTopic").value.trim(),question:$("doubtQuestion").value.trim()});alertMsg("आपका सवाल Teacher को भेज दिया गया।");doubtsPage()}catch(e){alertMsg(e.message)}};
}
async function teacherPage(){
  const [r,graded,students]=await Promise.all([call("listDoubts"),call("listSubjectiveSubmissions"),call("listTeacherStudents")]);
  const orderedDoubts=[...r.doubts].sort((a,b)=>(a.status==="open"?0:1)-(b.status==="open"?0:1));
  const doubtHtml=orderedDoubts.length?orderedDoubts.map(x=>'<article class="item teacher-doubt-card"><div class="question-meta"><span>'+esc(x.subject)+'</span><span class="doubt-status '+(x.status==="open"?"pending":"answered")+'">'+(x.status==="open"?"जवाब बाकी":"जवाब दिया गया")+'</span></div><h3>'+esc(x.studentName||"Student")+'</h3><p><b>विषय:</b> '+esc(x.subject)+' • <b>टॉपिक:</b> '+esc(x.topic||"General")+'</p><div class="student-question"><b>Student का सवाल</b><p>'+esc(x.question)+'</p></div>'+(x.reply?'<div class="teacher-reply"><b>आपका जवाब</b><p>'+esc(x.reply)+'</p></div>':'')+'<label>'+(x.reply?"जवाब अपडेट करें":"Student को जवाब दें")+'</label><textarea data-reply="'+esc(x.id)+'" placeholder="अपना जवाब लिखें">'+esc(x.reply||"")+'</textarea><button data-sendreply="'+esc(x.id)+'">'+(x.reply?"Update Reply":"Send Answer")+'</button></article>').join(""):'<div class="empty-state"><b>अभी कोई Student Doubt नहीं आया।</b><p>जैसे ही Student सवाल भेजेगा, वह यहाँ दिखाई देगा।</p></div>';
  const gradeHtml=graded.submissions.length?graded.submissions.map(x=>'<article class="item"><h3>'+esc(x.studentName)+' • '+esc(x.quizTitle)+'</h3>'+x.questions.map(q=>'<div class="review-question"><b>'+esc(q.question)+'</b><p><b>Student Answer:</b> '+esc(q.studentAnswer)+'</p><p class="hint">Maximum Marks: '+q.maxMarks+'</p>'+(q.modelAnswer?'<details><summary>Model answer देखें</summary><p>'+esc(q.modelAnswer)+'</p></details>':'')+'<label>Award Marks</label><input type="number" min="0" max="'+q.maxMarks+'" step="0.5" data-grade="'+esc(x.quizId)+'|'+esc(x.uid)+'|'+esc(q.questionId)+'|'+q.maxMarks+'"><button data-savegrade="'+esc(x.quizId)+'|'+esc(x.uid)+'|'+esc(q.questionId)+'|'+q.maxMarks+'">Save Grade</button></div>').join("")+'</article>').join(""):'<p>अभी कोई subjective answer जाँचने के लिए नहीं है।</p>';
  panel(role==="superadmin"?"Super Teacher Workspace":"Teacher Dashboard",'<div class="dashboard-hero"><span class="eyebrow">EDUFUTURE • TEACHER WORKSPACE</span><h2>Student Doubt & Answer Desk</h2><p>Student के भेजे हुए सवाल यहाँ आएँगे। सवाल पढ़कर जवाब भेजें और written test answers जाँचें।</p></div><div class="grid"><div class="stat"><strong>'+r.doubts.length+'</strong><span>Student Doubts</span></div><div class="stat"><strong>'+r.doubts.filter(x=>x.status==="open").length+'</strong><span>Pending Replies</span></div><div class="stat"><strong>'+graded.submissions.reduce((n,x)=>n+x.questions.length,0)+'</strong><span>Answers to Grade</span></div></div><h3>Student Roster</h3><div class="student-roster">'+(students.students.length?students.students.map(x=>'<div class="admin-row"><span>'+esc(x.displayName||"Student")+'</span><small>'+esc(x.email)+'</small></div>').join(""):'<p>अभी कोई student नहीं है।</p>')+'</div><h3>Student Doubts — यहाँ जवाब दें</h3>'+doubtHtml+'<h3>Subjective Answer Review</h3>'+gradeHtml);
  $("view").querySelectorAll("[data-sendreply]").forEach(b=>b.onclick=async()=>{try{const id=b.dataset.sendreply;await call("replyDoubt",{id,reply:$("view").querySelector('[data-reply="'+id+'"]').value.trim()});alertMsg("जवाब भेज दिया गया।");teacherPage()}catch(e){alertMsg(e.message)}});
  $("view").querySelectorAll("[data-savegrade]").forEach(b=>b.onclick=async()=>{try{const [quizId,uid,questionId,max]=b.dataset.savegrade.split("|");const marks=Number($("view").querySelector('[data-grade="'+b.dataset.savegrade+'"]').value);if(!Number.isFinite(marks)||marks<0||marks>Number(max))throw Error("Marks सही सीमा में भरें।");await call("gradeSubjective",{quizId,uid,questionId,marks});alertMsg("Marks save हो गए।");teacherPage()}catch(e){alertMsg(e.message)}});
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
  panel("Admin Control Center",'<div class="admin-welcome"><span class="eyebrow">EDUFUTURE • CONTROL CENTER</span><h2>Manage Learning. Inspire Progress.</h2><p>Quiz, teachers, students और learning content का प्रबंधन।</p></div><div class="grid"><section class="item"><h3>Quiz Builder</h3><label>Quiz Title</label><input id="quizTitle" placeholder="जैसे: Class 10 Science Test"><label>Class</label><input id="quizClass" placeholder="Class 10"><label>Subject</label><input id="quizSubject" placeholder="Science"><label>Topic (optional)</label><input id="quizTopic" placeholder="Electricity"><label>Timer (minutes)</label><input id="quizDuration" type="number" min="1" max="600" value="30"><h4>Bulk Question Import (up to 1000)</h4><p class="hint">CSV columns: question,type,optionA,optionB,optionC,optionD,answer,topic,difficulty,marks,explanation,modelAnswer</p><input id="csvFile" type="file" accept=".csv,text/csv"><textarea id="csvText" placeholder="CSV content यहाँ paste करें…"></textarea><button id="importCsv" class="secondary">Import CSV Questions</button><p id="importStatus" class="hint"></p><div id="questionEditor"></div><button id="addQuestion" class="secondary">+ Add Question</button><button id="publishQuiz">Publish Quiz</button></section><section class="item"><h3>Teacher Management</h3><label>Registered Teacher Email</label><input id="teacherEmail" type="email" placeholder="teacher@example.com"><label>Assigned Subjects (comma separated)</label><input id="teacherSubjects" placeholder="Maths, Science"><button id="assignTeacher">Assign Teacher</button><p class="hint">पहले Teacher को Student account बनाकर login करना होगा।</p></section><section class="item"><h3>Notes / PYQ</h3><label>Title</label><input id="contentTitle"><label>Subject</label><input id="contentSubject"><label>Type</label><select id="contentType"><option value="note">Notes</option><option value="pyq">PYQ</option><option value="resource">Resource</option></select><label>Description</label><textarea id="contentDescription"></textarea><label>PDF / DOC / PPT / Image File (अधिकतम 30 MB)</label><input id="contentFile" type="file" accept=".pdf,.doc,.docx,.ppt,.pptx,.png,.jpg,.jpeg,.webp"><label>या Hosted file URL</label><input id="contentUrl" type="url" placeholder="https://..."><p id="uploadStatus" class="hint">फ़ाइल चुनें या पहले से hosted URL डालें।</p><button id="saveContent">Upload & Publish Content</button></section><section class="item"><h3>Published Notes / PYQ Management</h3><button id="loadContent">Refresh Content List</button><div id="contentList"></div></section><section class="item"><h3>Student Management</h3><button id="loadStudents">View Students</button><div id="studentList"></div></section><section class="item"><h3>Student Results</h3><div id="adminResults">Loading quizzes…</div></section></div>');
  const quizSnap=await getDocs(collection(db,"quizzes"));
  $("adminResults").innerHTML=quizSnap.empty?"<p>अभी कोई Quiz नहीं है।</p>":quizSnap.docs.map(d=>'<div class="admin-row"><span>'+esc(d.data().title)+'</span><button data-admin-result="'+d.id+'">View Results</button></div><div id="admin-result-'+d.id+'"></div>').join("");
  $("adminResults").querySelectorAll("[data-admin-result]").forEach(b=>b.onclick=async()=>{const out=$("admin-result-"+b.dataset.adminResult);out.textContent="Loading…";try{const r=await call("getLeaderboard",{id:b.dataset.adminResult});out.innerHTML=r.rows.length?"<ol>"+r.rows.map(x=>"<li>"+esc(x.name)+" — "+x.score+"/"+x.total+(x.pendingReview?" • Subjective pending":"")+"</li>").join("")+"</ol>":"<p>अभी कोई submitted result नहीं है।</p>"}catch(e){out.textContent=e.message}});
  let n=0;
  function addQ(seed={}){
    const i=n++, type=seed.type==="subjective"?"subjective":"objective";
    $("questionEditor").insertAdjacentHTML("beforeend",'<article class="question" data-q="'+i+'"><div class="question-head"><h4>Question '+(i+1)+'</h4><button type="button" class="danger remove-question">Remove</button></div><textarea class="qtext" placeholder="Question">'+esc(seed.text||"")+'</textarea><label>Question Type</label><select class="qtype"><option value="objective" '+(type==="objective"?"selected":"")+'>Objective (MCQ)</option><option value="subjective" '+(type==="subjective"?"selected":"")+'>Subjective (Written)</option></select><label>Topic / Chapter</label><input class="qtopic" placeholder="Chapter / Topic" value="'+esc(seed.topic||"")+'"><label>Difficulty</label><select class="qdifficulty"><option value="easy" '+(seed.difficulty==="easy"?"selected":"")+'>Easy</option><option value="medium" '+(!seed.difficulty||seed.difficulty==="medium"?"selected":"")+'>Medium</option><option value="hard" '+(seed.difficulty==="hard"?"selected":"")+'>Hard</option></select><label>Marks</label><input class="qmarks" type="number" min="1" max="100" value="'+Number(seed.marks||1)+'"><div class="objective-fields" '+(type==="subjective"?"hidden":"")+'>'+[0,1,2,3].map((j)=>'<label>Option '+String.fromCharCode(65+j)+'</label><input class="qopt" value="'+esc((seed.options||[])[j]||"")+'" placeholder="Option '+String.fromCharCode(65+j)+'">').join("")+'<label>Correct Option</label><select class="qans">'+[0,1,2,3].map(j=>'<option value="'+j+'" '+(Number(seed.answer||0)===j?"selected":"")+'>'+String.fromCharCode(65+j)+'</option>').join("")+'</select></div><div class="subjective-fields" '+(type!=="subjective"?"hidden":"")+'><label>Model Answer (Teacher reference)</label><textarea class="qmodel" placeholder="Expected answer">'+esc(seed.modelAnswer||"")+'</textarea></div><label>Explanation / Feedback</label><textarea class="qexplanation" placeholder="Explanation">'+esc(seed.explanation||"")+'</textarea></article>');
    const card=$("questionEditor").lastElementChild;
    card.querySelector(".qtype").onchange=()=>{const sub=card.querySelector(".qtype").value==="subjective";card.querySelector(".objective-fields").hidden=sub;card.querySelector(".subjective-fields").hidden=!sub};
    card.querySelector(".remove-question").onclick=()=>card.remove();
  }
  addQ();$("addQuestion").onclick=()=>addQ();
  function parseCSV(input){
    const rows=[];let row=[],field="",quoted=false;
    for(let i=0;i<input.length;i++){const c=input[i];if(c==='"'&&quoted&&input[i+1]==='"'){field+='"';i++}else if(c==='"'){quoted=!quoted}else if(c===","&&!quoted){row.push(field);field=""}else if((c==="\n"||c==="\r")&&!quoted){if(c==="\r"&&input[i+1]==="\n")i++;row.push(field);if(row.some(v=>v.trim()))rows.push(row);row=[];field=""}else field+=c}
    row.push(field);if(row.some(v=>v.trim()))rows.push(row);
    if(rows.length<2)throw Error("CSV में header और कम-से-कम एक question होना चाहिए।");
    const headers=rows.shift().map(x=>x.trim().toLowerCase());
    return rows.map(cols=>{const o={};headers.forEach((h,i)=>o[h]=(cols[i]||"").trim());const answer=o.answer||"A";return {text:o.question||o.text||"",type:(o.type||"objective").toLowerCase().startsWith("sub")?"subjective":"objective",options:[o.optiona,o.optionb,o.optionc,o.optiond].filter(Boolean),answer:/^[1-4]$/.test(answer)?Number(answer)-1:"ABCD".indexOf(answer.toUpperCase()),topic:o.topic||"",difficulty:(o.difficulty||"medium").toLowerCase(),marks:Number(o.marks||1),explanation:o.explanation||"",modelAnswer:o.modelanswer||""}});
  }
  $("csvFile").onchange=async e=>{const file=e.target.files[0];if(file)$("csvText").value=await file.text()};
  $("importCsv").onclick=()=>{try{const qs=parseCSV($("csvText").value);if(!qs.length||qs.length>1000)throw Error("एक quiz में 1 से 1000 प्रश्न import करें।");$("questionEditor").innerHTML="";n=0;qs.forEach(q=>addQ(q));$("importStatus").textContent=qs.length+" questions import हुए। पुराने builder questions replace कर दिए गए हैं। अब Publish Quiz दबाएँ।"}catch(e){alertMsg(e.message)}};
  $("publishQuiz").onclick=async()=>{try{
    const cards=[...$("questionEditor").querySelectorAll("[data-q]")];
    if(!cards.length||cards.length>1000)throw Error("1 से 1000 प्रश्न रखें।");
    const qs=cards.map(x=>{const type=x.querySelector(".qtype").value;return {text:x.querySelector(".qtext").value.trim(),type,topic:x.querySelector(".qtopic").value.trim(),difficulty:x.querySelector(".qdifficulty").value,marks:Number(x.querySelector(".qmarks").value||1),options:type==="objective"?[...x.querySelectorAll(".qopt")].map(y=>y.value.trim()).filter(Boolean):[],answer:type==="objective"?Number(x.querySelector(".qans").value):null,modelAnswer:type==="subjective"?x.querySelector(".qmodel").value.trim():"",explanation:x.querySelector(".qexplanation").value.trim()}});
    const r=await call("saveQuiz",{title:$("quizTitle").value.trim(),className:$("quizClass").value.trim(),subject:$("quizSubject").value.trim(),topic:$("quizTopic").value.trim(),duration:Number($("quizDuration").value),questions:qs,publish:true});
    alertMsg("Quiz publish हो गया। "+r.questionCount+" प्रश्न • कुल "+r.totalMarks+" अंक");tab="quiz";render();
  }catch(e){alertMsg(e.message)}};
  $("assignTeacher").onclick=async()=>{try{const subjects=$("teacherSubjects").value.split(",").map(x=>x.trim()).filter(Boolean);await call("assignTeacher",{email:$("teacherEmail").value.trim(),subjects});alertMsg("Teacher assign हो गया।");$("teacherEmail").value="";$("teacherSubjects").value=""}catch(e){alertMsg(e.message)}};
  $("saveContent").onclick=async()=>{const button=$("saveContent"),file=$("contentFile").files[0];try{const title=$("contentTitle").value.trim(),subject=$("contentSubject").value.trim();if(!title||!subject)throw Error("Title और Subject भरना जरूरी है।");let url=$("contentUrl").value.trim();if(file){if(file.size>30*1024*1024)throw Error("फ़ाइल 30 MB से छोटी होनी चाहिए।");if(!/\.(pdf|doc|docx|ppt|pptx|png|jpe?g|webp)$/i.test(file.name))throw Error("केवल PDF, DOC, DOCX, PPT, PPTX और image फ़ाइलें upload करें।");button.disabled=true;$("uploadStatus").textContent="फ़ाइल upload हो रही है…";const safeName=file.name.replace(/[^a-zA-Z0-9._-]/g,"_");const target=storageRef(storage,"learning/"+user.uid+"/"+Date.now()+"-"+safeName);const uploaded=await uploadBytes(target,file,{contentType:file.type||"application/octet-stream"});url=await getDownloadURL(uploaded.ref);}if(!url)throw Error("फ़ाइल चुनें या Hosted URL डालें।");await call("addContent",{title,subject,type:$("contentType").value,description:$("contentDescription").value,url,published:true});alertMsg("Content upload और publish हो गया।");$("contentTitle").value="";$("contentUrl").value="";$("contentFile").value="";$("contentDescription").value="";$("uploadStatus").textContent="अगली फ़ाइल चुन सकते हैं।";}catch(e){alertMsg(e.message);$("uploadStatus").textContent=e.message}finally{button.disabled=false}};
  $("loadStudents").onclick=async()=>{try{const r=await call("listStudents");$("studentList").innerHTML=r.students.length?r.students.map(x=>"<p>"+esc(x.displayName||x.email||x.uid)+"</p>").join(""):"<p>कोई student record नहीं मिला।</p>"}catch(e){$("studentList").textContent=e.message}};
  async function loadContent(){try{const snap=await getDocs(collection(db,"content"));$("contentList").innerHTML=snap.empty?"<p>कोई content नहीं है।</p>":snap.docs.map(d=>{const x=d.data();return '<div class="admin-row"><span>'+esc(x.title)+' • '+(x.published?"Published":"Hidden")+'</span><button data-content-toggle="'+d.id+'" data-published="'+(!x.published)+'">'+(x.published?"Hide":"Publish")+"</button></div>"}).join("");$("contentList").querySelectorAll("[data-content-toggle]").forEach(b=>b.onclick=async()=>{try{await call("setContentPublished",{id:b.dataset.contentToggle,published:b.dataset.published==="true"});loadContent()}catch(e){alertMsg(e.message)}})}catch(e){$("contentList").textContent=e.message}}
  $("loadContent").onclick=loadContent;loadContent();
}
async function superPage(){
  if(role!=="superadmin")return;
  panel("Super Admin Controls",'<div class="item"><h3>Create Admin</h3><p class="hint">Admin का account पहले से बना होना चाहिए।</p><input id="adminEmail" type="email" placeholder="Registered admin email"><button id="createAdmin">Create Admin</button></div><div class="item"><h3>Manage All Admins</h3><button id="refreshAdmins">Refresh List</button><div id="adminList"></div></div>');
  async function load(){try{const r=await call("listAdmins");$("adminList").innerHTML=r.admins.map(a=>'<div class="admin-row"><span>'+esc(a.displayName||a.email||a.uid)+' — '+esc(a.role)+'</span>'+(a.role==="admin"?'<button class="danger" data-remove="'+a.uid+'">Remove Admin</button>':"")+"</div>").join("")||"<p>कोई Admin नहीं है।</p>";$("adminList").querySelectorAll("[data-remove]").forEach(b=>b.onclick=async()=>{if(!confirm("क्या इस Admin की भूमिका Student करनी है?"))return;try{await call("removeAdmin",{uid:b.dataset.remove});alertMsg("Admin role हटा दी गई।");load()}catch(e){alertMsg(e.message)}})}catch(e){$("adminList").textContent=e.message}}
  $("createAdmin").onclick=async()=>{try{await call("addAdmin",{email:$("adminEmail").value.trim()});alertMsg("Admin बना दिया गया।");$("adminEmail").value="";load()}catch(e){alertMsg(e.message)}};
  $("refreshAdmins").onclick=load;load();
}
