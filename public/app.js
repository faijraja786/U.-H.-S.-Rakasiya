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
$("togglePassword").onclick=()=>{const field=$("password"),show=field.type==="password";field.type=show?"text":"password";$("togglePassword").textContent=show?"Hide":"Show";$("togglePassword").setAttribute("aria-label",show?"Hide password":"Show password");$("togglePassword").setAttribute("aria-pressed",String(show))};
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
    $("profileRole").textContent=role==="superadmin"?"Head Teacher":role==="admin"?"Teacher":role==="teacher"?"Teacher":"Student";
    $("roleBadge").textContent="✓ "+$("profileRole").textContent.toUpperCase();
    $("profileMenu").hidden=true;
    openApp();
    tab="home";
    render();
  }catch(e){await signOut(u).catch(()=>{});openLogin();msg("Role verification नहीं हो सकी: "+e.message)}
});

const studentTabs=[["home","Home"],["quiz","Available Quizzes"],["notes","Study Notes"],["pyq","Previous Year Questions"],["leaderboard","Leaderboard"],["results","My Results"],["doubts","Doubt Solving"],["tasks","Daily Targets"],["planner","Study Routine"],["cards","Flashcards"]];
function closeWorkspaceMenu(){
  $("app").classList.remove("menu-open");
  $("menuToggle").setAttribute("aria-expanded","false");
}
function render(){
  let tabs=studentTabs;
  if(role==="teacher")tabs=[["home","Home"],["teacher","Teacher Workspace"]];
  if(role==="admin")tabs=[["home","Home"],["teacher","Teacher Workspace"],["admin","Admin Dashboard"]];
  if(role==="superadmin")tabs=[["home","Home"],["overview","Overview"],["teacher","Teacher Workspace"],["admin","Admin Dashboard"],["super","Super Admin"]];
  const pages={overview:superOverviewPage,home:role==="superadmin"?superHomePage:homePage,quiz:quizPage,notes:notesPage,pyq:pyqPage,leaderboard:leaderboardPage,results:resultsPage,doubts:doubtsPage,teacher:teacherPage,tasks:tasksPage,planner:plannerPage,cards:cardsPage,admin:adminPage,createquiz:createQuizPage,objectivebuilder:()=>quizBuilderPage("objective"),subjectivebuilder:()=>quizBuilderPage("subjective"),notesupload:()=>contentUploadPage("note"),pyqupload:()=>contentUploadPage("pyq"),super:superPage};
  // Internal workflow pages are intentionally not sidebar items. Keep them routable.
  if(!tabs.some(x=>x[0]===tab)&&!pages[tab])tab=tabs[0][0];
  $("nav").innerHTML='<div class="nav-section-label">MENU</div>'+tabs.map(x=>'<button data-tab="'+x[0]+'" class="nav-link '+(tab===x[0]?"active":"")+'"><span class="nav-icon">'+({overview:"◈",home:"⌂",quiz:"▤",notes:"▧",leaderboard:"♛",results:"◷",doubts:"✉",tasks:"✓",planner:"▦",cards:"▣",teacher:"▤",admin:"⚙",super:"♜"}[x[0]]||"•")+'</span><span>'+x[1]+"</span></button>").join("");
  $("nav").querySelectorAll("[data-tab]").forEach(b=>b.onclick=()=>{tab=b.dataset.tab;render();closeWorkspaceMenu()});
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
async function superHomePage(){
  const [quizSnap,studentData,adminData,gradeData]=await Promise.all([getDocs(collection(db,"quizzes")),call("listStudents").catch(()=>({students:[]})),call("listAdmins").catch(()=>({admins:[]})),call("listSubjectiveSubmissions").catch(()=>({submissions:[]}))]);
  const published=quizSnap.docs.filter(d=>d.data().status==="published").length;
  panel("Head Teacher Control Center",'<div class="admin-welcome"><span class="eyebrow">EDUFUTURE • SUPER ADMIN</span><h2>पूरा EduFuture आपके नियंत्रण में</h2><p>यह Student Dashboard नहीं है। यहाँ से quizzes, teachers, written answers, content और accounts नियंत्रित करें।</p><div class="overview-actions"><button data-super-create>＋ Create Quiz</button><button data-super-teacher>Teacher Workspace</button><button data-super-manage>Super Admin Controls</button></div></div><div class="grid"><div class="stat"><strong>'+studentData.students.length+'</strong><span>Students</span></div><div class="stat"><strong>'+adminData.admins.length+'</strong><span>Admins / Super Admins</span></div><div class="stat"><strong>'+quizSnap.size+'</strong><span>Total Quizzes</span></div><div class="stat"><strong>'+published+'</strong><span>Published Quizzes</span></div><div class="stat"><strong>'+gradeData.submissions.reduce((n,x)=>n+x.questions.length,0)+'</strong><span>Answers Awaiting Review</span></div></div><div class="dashboard-shortcuts"><button data-super-notes>Upload Notes</button><button data-super-pyq>Upload PYQ</button><button data-super-results>Quiz Results & Ranks</button></div>');
  const go=(selector,target)=>$("view").querySelector(selector).onclick=()=>{tab=target;render()};
  go("[data-super-create]","createquiz");go("[data-super-teacher]","teacher");go("[data-super-manage]","super");go("[data-super-notes]","notesupload");go("[data-super-pyq]","pyqupload");go("[data-super-results]","admin");
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
    return '<article class="item quiz-window-card"><div class="question-meta"><span>'+esc(q.subject||"General")+'</span><span>'+(q.quizType==="subjective"?"SUBJECTIVE":q.quizType==="objective"?"OBJECTIVE":"MIXED TEST")+'</span><span>'+Number(q.questionCount||0)+' प्रश्न</span><span>'+Number(q.duration||0)+' मिनट</span></div><h3>'+esc(q.title)+'</h3>'+action+'</article>';
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
  panel("Objective & Subjective Rankings",'<div class="leaderboard-banner"><span class="eyebrow">EDUFUTURE • HALL OF FAME</span><h2>U.H.S. Rakasiya Ke Tufano 🌪️</h2><p>Objective और Subjective की अलग-अलग आधिकारिक रैंकिंग।</p></div>'+(s.empty?"<p>अभी कोई quiz नहीं है।</p>":s.docs.map(d=>'<article class="leaderboard-quiz"><div><h3>'+esc(d.data().title)+'</h3><p class="hint">'+(d.data().quizType==="subjective"?"Subjective Written Test":d.data().quizType==="objective"?"Objective MCQ Test":"Objective + Subjective Test")+'</p></div><div class="rank-actions"><button data-rank="'+d.id+'" data-rank-type="objective">Objective Rank</button><button class="secondary" data-rank="'+d.id+'" data-rank-type="subjective">Subjective Rank</button></div><div class="leaderboard-output" id="rank-'+d.id+'-objective"></div><div class="leaderboard-output" id="rank-'+d.id+'-subjective"></div></article>').join("")));
  $("view").querySelectorAll("[data-rank]").forEach(b=>b.onclick=async()=>{
    const id=b.dataset.rank,type=b.dataset.rankType,out=$("rank-"+id+"-"+type);
    $("view").querySelectorAll("#rank-"+id+"-objective,#rank-"+id+"-subjective").forEach(x=>{if(x!==out)x.innerHTML=""});
    out.innerHTML='<p class="hint">'+(type==="objective"?"Objective":"Subjective")+' Rank लोड हो रही है…</p>';
    try{
      const r=await call("getLeaderboard",{id,rankingType:type});
      if(!r.released){out.innerHTML='<div class="locked-note">🔒 '+(type==="subjective"?"Teacher अभी written answers जाँच रहे हैं। सभी जाँच पूरी होने और result खुलने के बाद Subjective Rank दिखाई देगी।":"Objective Rank निर्धारित समय पर खुलेगी।")+' '+(r.releaseAt?'समय: '+dateText(r.releaseAt):"")+'</div>';return}
      if(!r.rows.length){out.innerHTML='<p>अभी कोई result उपलब्ध नहीं है।</p>';return}
      const medals=["🥇","🥈","🥉"];
      out.innerHTML='<h4>'+(type==="objective"?"Objective Ranking":"Subjective Ranking")+'</h4><div class="podium">'+r.rows.slice(0,3).map((x,i)=>'<div class="podium-card podium-'+(i+1)+'"><span class="medal">'+medals[i]+'</span><strong>#'+x.rank+'</strong><b>'+esc(x.name)+'</b><small>'+x.score+'/'+x.total+' अंक</small></div>').join("")+'</div><div class="rank-table">'+r.rows.map(x=>'<div class="rank-row '+(x.uid===user.uid?'my-rank':'')+'"><b class="rank-number">#'+x.rank+'</b><span class="rank-name">'+esc(x.name)+(x.uid===user.uid?' <em>YOU</em>':'')+'</span><strong>'+x.score+'/'+x.total+'</strong><span class="rank-percent">'+Math.round(x.total?x.score/x.total*100:0)+'%</span></div>').join("")+'</div>';
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
async function contentLibraryPage(kind,title){
  const s=await getDocs(query(collection(db,"content"),where("published","==",true)));
  const docs=s.docs.filter(d=>(d.data().type||"note")===kind);
  panel(title,docs.length?docs.map(d=>{const x=d.data();return '<article class="item"><div class="question-meta"><span>'+esc(x.subject||"General")+'</span><span>'+(kind==="pyq"?"PREVIOUS YEAR QUESTION":"STUDY NOTES")+'</span></div><h3>'+esc(x.title)+'</h3><p>'+esc(x.description)+'</p><a href="'+esc(x.url)+'" target="_blank" rel="noopener">Open / Download</a></article>'}).join(""):'<div class="empty-state"><b>अभी कोई '+(kind==="pyq"?"PYQ":"Study Notes")+' उपलब्ध नहीं है।</b><p>नई सामग्री publish होने पर यहाँ दिखाई देगी।</p></div>');
}
async function notesPage(){return contentLibraryPage("note","Study Notes")}
async function pyqPage(){return contentLibraryPage("pyq","Previous Year Questions")}
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
  panel(role==="superadmin"?"Teacher Workspace":"Teacher Dashboard",'<div class="dashboard-hero"><span class="eyebrow">EDUFUTURE • TEACHER WORKSPACE</span><h2>Student Doubt & Answer Desk</h2><p>Student के भेजे हुए सवाल यहाँ आएँगे। सवाल पढ़कर जवाब भेजें और written test answers जाँचें।</p></div><div class="grid"><div class="stat"><strong>'+r.doubts.length+'</strong><span>Student Doubts</span></div><div class="stat"><strong>'+r.doubts.filter(x=>x.status==="open").length+'</strong><span>Pending Replies</span></div><div class="stat"><strong>'+graded.submissions.reduce((n,x)=>n+x.questions.length,0)+'</strong><span>Answers to Grade</span></div></div><h3>Student Roster</h3><div class="student-roster">'+(students.students.length?students.students.map(x=>'<div class="admin-row"><span>'+esc(x.displayName||"Student")+'</span><small>'+esc(x.email)+'</small></div>').join(""):'<p>अभी कोई student नहीं है।</p>')+'</div><h3>Student Doubts — यहाँ जवाब दें</h3>'+doubtHtml+'<h3>Subjective Answer Review</h3>'+gradeHtml);
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
  panel("Admin Dashboard",'<div class="admin-welcome"><span class="eyebrow">EDUFUTURE • CONTROL CENTER</span><h2>Learning Management</h2><p>Quiz बनाएं, Notes और PYQ अलग-अलग upload करें और learning activities manage करें।</p></div><div class="admin-action-grid"><button class="admin-action-card" data-admin-go="createquiz"><span>＋</span><b>Create Quiz</b><small>Objective या Subjective चुनें</small></button><button class="admin-action-card" data-admin-go="notesupload"><span>▤</span><b>Upload Notes</b><small>Notes अलग से publish करें</small></button><button class="admin-action-card" data-admin-go="pyqupload"><span>▧</span><b>Upload PYQ</b><small>Previous year papers अलग रखें</small></button><button class="admin-action-card" data-admin-go="teacher"><span>♙</span><b>Teacher Workspace</b><small>Written answers और doubts जाँचें</small></button></div><section class="item"><h3>Teacher Assignment</h3><label>Registered Teacher Email</label><input id="teacherEmail" type="email" placeholder="teacher@example.com"><label>Assigned Subjects (comma separated)</label><input id="teacherSubjects" placeholder="Maths, Science"><button id="assignTeacher">Assign Teacher</button></section><section class="item"><h3>Student Management</h3><button id="loadStudents" class="secondary">View Students</button><div id="studentList"></div></section><section class="item"><h3>Quiz Results</h3><div id="adminResults">Loading quizzes…</div></section>');
  $("view").querySelectorAll("[data-admin-go]").forEach(b=>b.onclick=()=>{tab=b.dataset.adminGo;render()});
  $("assignTeacher").onclick=async()=>{try{const subjects=$("teacherSubjects").value.split(",").map(x=>x.trim()).filter(Boolean);await call("assignTeacher",{email:$("teacherEmail").value.trim(),subjects});alertMsg("Teacher assign हो गया।");$("teacherEmail").value="";$("teacherSubjects").value=""}catch(e){alertMsg(e.message)}};
  $("loadStudents").onclick=async()=>{try{const r=await call("listStudents");$("studentList").innerHTML=r.students.length?r.students.map(x=>"<p>"+esc(x.displayName||x.email||x.uid)+"</p>").join(""):"<p>कोई student record नहीं मिला।</p>"}catch(e){$("studentList").textContent=e.message}};
  const snap=await getDocs(collection(db,"quizzes"));
  $("adminResults").innerHTML=snap.empty?"<p>अभी कोई Quiz नहीं है।</p>":snap.docs.map(d=>'<div class="admin-row"><span>'+esc(d.data().title)+'</span><button data-admin-result="'+d.id+'">View Results</button></div><div id="admin-result-'+d.id+'"></div>').join("");
  $("adminResults").querySelectorAll("[data-admin-result]").forEach(b=>b.onclick=async()=>{const out=$("admin-result-"+b.dataset.adminResult);out.textContent="Loading…";try{const r=await call("getLeaderboard",{id:b.dataset.adminResult});out.innerHTML=r.rows.length?"<ol>"+r.rows.map(x=>"<li>"+esc(x.name)+" — "+x.score+"/"+x.total+(x.pendingReview?" • Subjective pending":"")+"</li>").join("")+"</ol>":"<p>अभी कोई submitted result नहीं है।</p>"}catch(e){out.textContent=e.message}});
}
async function createQuizPage(){
  if(role!=="admin"&&role!=="superadmin")return;
  panel("Create Quiz",'<button class="text-button" data-admin-back>← Admin Dashboard</button><div class="quiz-choice-intro"><span class="eyebrow">CHOOSE QUIZ FORMAT</span><h2>किस प्रकार का Quiz बनाना है?</h2><p>दोनों प्रकार के लिए अलग-अलग builder और student experience होगा।</p></div><div class="quiz-choice-grid"><button class="quiz-choice-card objective-choice" data-quiz-kind="objective"><span class="choice-icon">✓</span><b>Objective Quiz</b><small>चार विकल्प, सही उत्तर चुनें और automatic checking</small><span class="choice-link">Create Objective Quiz →</span></button><button class="quiz-choice-card subjective-choice" data-quiz-kind="subjective"><span class="choice-icon">✎</span><b>Subjective Quiz</b><small>लिखित उत्तर, Teacher checking और marks</small><span class="choice-link">Create Subjective Quiz →</span></button></div>');
  $("view").querySelector("[data-admin-back]").onclick=()=>{tab="admin";render()};
  $("view").querySelectorAll("[data-quiz-kind]").forEach(b=>b.onclick=()=>{tab=b.dataset.quizKind==="objective"?"objectivebuilder":"subjectivebuilder";render()});
}
async function quizBuilderPage(mode){
  if(role!=="admin"&&role!=="superadmin")return;
  const isObjective=mode==="objective",kind=isObjective?"Objective":"Subjective";
  panel(kind+" Quiz Builder",'<button class="text-button" id="backQuizChoice">← Quiz Type चुनें</button><div class="builder-heading"><span class="eyebrow">EDUFUTURE • '+kind.toUpperCase()+' BUILDER</span><h2>'+kind+' Quiz बनाएं</h2><p>केवल Topic और Timer भरें। प्रश्न नीचे जोड़ें या CSV से import करें।</p></div><div class="builder-meta-grid"><div><label for="builderTopic">Topic / Chapter</label><input id="builderTopic" placeholder="जैसे: प्रकाश और परावर्तन"></div><div><label for="builderDuration">Time Limit (minutes)</label><input id="builderDuration" type="number" min="1" max="600" value="30"></div></div><section class="bulk-import-box"><b>Bulk Question Import</b><p class="hint">CSV से 2000 तक प्रश्न import करें। Objective columns: question, optionA, optionB, optionC, optionD, answer, marks.</p><input id="builderCsvFile" type="file" accept=".csv,text/csv"><textarea id="builderCsvText" rows="3" placeholder="या CSV content यहाँ paste करें…"></textarea><button id="builderImport" class="secondary">Import CSV</button> <span id="builderImportStatus" class="hint"></span></section><div class="question-toolbar"><div><b>Questions</b><span id="questionCount" class="question-count"></span></div><button id="builderAddQuestion">＋ Add Question</button></div><div id="builderQuestions"></div><div class="question-pagination"><button id="questionPrev" class="secondary">← Previous</button><span id="questionPageLabel">Page 1</span><button id="questionNext" class="secondary">Next →</button></div><div class="publish-row"><button id="publishQuiz" class="success-action">Publish '+kind+' Quiz</button></div>');
  $("backQuizChoice").onclick=()=>{tab="createquiz";render()};
  let questions=[blank()],page=0;const perPage=10;
  function blank(){return {text:"",type:mode,options:["","","",""],answer:null,marks:1,modelAnswer:"",topic:"",difficulty:"medium",explanation:""}}
  function draw(){
    const pages=Math.max(1,Math.ceil(questions.length/perPage));page=Math.min(page,pages-1);
    const start=page*perPage,items=questions.slice(start,start+perPage);
    $("questionCount").textContent=questions.length+" total";$("questionPageLabel").textContent="Page "+(page+1)+" of "+pages;
    $("questionPrev").disabled=page===0;$("questionNext").disabled=page>=pages-1;
    $("builderQuestions").innerHTML=items.map((q,k)=>{
      const i=start+k;
      const fields=isObjective?'<div class="mcq-option-grid">'+q.options.map((v,j)=>'<label class="mcq-option"><span class="option-letter">'+String.fromCharCode(65+j)+'</span><input data-opt="'+i+'" data-option="'+j+'" value="'+esc(v)+'" placeholder="Option '+String.fromCharCode(65+j)+'"><input class="correct-radio" type="radio" name="correct-'+i+'" data-correct="'+i+'" value="'+j+'" '+(q.answer===j?"checked":"")+' aria-label="Option '+String.fromCharCode(65+j)+' सही उत्तर चुनें"></label>').join("")+'</div><p class="hint">सही उत्तर के लिए दाईं ओर वाला गोल विकल्प चुनें।</p>':'<label>Model Answer (Teacher reference, वैकल्पिक)</label><textarea data-model="'+i+'" rows="3" placeholder="Expected answer">'+esc(q.modelAnswer||"")+'</textarea>';
      return '<article class="question builder-question"><div class="question-head"><h3>Question '+(i+1)+'</h3><button type="button" class="danger" data-remove="'+i+'">Remove</button></div><label>Question</label><textarea data-qtext="'+i+'" rows="3" placeholder="पूरा प्रश्न यहाँ लिखें">'+esc(q.text)+'</textarea>'+fields+'<div class="builder-marks"><label>Marks</label><input data-marks="'+i+'" type="number" min="1" max="100" value="'+Number(q.marks||1)+'"></div></article>';
    }).join("");
    $("builderQuestions").querySelectorAll("[data-qtext]").forEach(x=>x.oninput=()=>questions[Number(x.dataset.qtext)].text=x.value);
    $("builderQuestions").querySelectorAll("[data-opt]").forEach(x=>x.oninput=()=>questions[Number(x.dataset.opt)].options[Number(x.dataset.option)]=x.value);
    $("builderQuestions").querySelectorAll("[data-correct]").forEach(x=>x.onchange=()=>questions[Number(x.dataset.correct)].answer=Number(x.value));
    $("builderQuestions").querySelectorAll("[data-model]").forEach(x=>x.oninput=()=>questions[Number(x.dataset.model)].modelAnswer=x.value);
    $("builderQuestions").querySelectorAll("[data-marks]").forEach(x=>x.onchange=()=>questions[Number(x.dataset.marks)].marks=Number(x.value));
    $("builderQuestions").querySelectorAll("[data-remove]").forEach(x=>x.onclick=()=>{questions.splice(Number(x.dataset.remove),1);if(!questions.length)questions=[blank()];draw()});
  }
  $("builderAddQuestion").onclick=()=>{if(questions.length>=2000){alertMsg("एक Quiz में अधिकतम 2000 प्रश्न जोड़ सकते हैं।");return}questions.push(blank());page=Math.floor((questions.length-1)/perPage);draw()};
  $("questionPrev").onclick=()=>{page=Math.max(0,page-1);draw()};$("questionNext").onclick=()=>{page=Math.min(Math.ceil(questions.length/perPage)-1,page+1);draw()};
  function parseCsv(input){
    const rows=[];let row=[],field="",quoted=false;
    for(let i=0;i<input.length;i++){const c=input[i];if(c==='"'&&quoted&&input[i+1]==='"'){field+='"';i++}else if(c==='"')quoted=!quoted;else if(c===","&&!quoted){row.push(field);field=""}else if((c==="\n"||c==="\r")&&!quoted){if(c==="\r"&&input[i+1]==="\n")i++;row.push(field);if(row.some(v=>v.trim()))rows.push(row);row=[];field=""}else field+=c}
    row.push(field);if(row.some(v=>v.trim()))rows.push(row);if(rows.length<2)throw Error("CSV में header और कम-से-कम एक प्रश्न होना चाहिए।");
    const headers=rows.shift().map(v=>v.trim().toLowerCase());
    return rows.map(cols=>{const o={};headers.forEach((h,i)=>o[h]=(cols[i]||"").trim());const a=(o.answer||"").trim().toUpperCase();const answerIndex=/^[1-4]$/.test(a)?Number(a)-1:/^[A-D]$/.test(a)?"ABCD".indexOf(a):null;return {text:o.question||o.text||"",type:mode,options:isObjective?[o.optiona||"",o.optionb||"",o.optionc||"",o.optiond||""]:[],answer:isObjective?answerIndex:null,marks:Number(o.marks||1),modelAnswer:o.modelanswer||"",topic:o.topic||"",difficulty:o.difficulty||"medium",explanation:o.explanation||""}});
  }
  $("builderCsvFile").onchange=async ev=>{const file=ev.target.files[0];if(file)$("builderCsvText").value=await file.text()};
  $("builderImport").onclick=()=>{try{const imported=parseCsv($("builderCsvText").value);if(!imported.length||imported.length>2000||questions.length+imported.length>2000)throw Error("कुल प्रश्नों की सीमा 2000 है।");questions=questions.length===1&&!questions[0].text?imported:questions.concat(imported);page=Math.floor((questions.length-1)/perPage);draw();$("builderImportStatus").textContent=imported.length+" प्रश्न import हुए।"}catch(err){alertMsg(err.message)}};
  $("publishQuiz").onclick=async()=>{
    const button=$("publishQuiz");button.disabled=true;
    try{
      const topic=$("builderTopic").value.trim(),duration=Number($("builderDuration").value);
      if(!topic)throw Error("Topic लिखना जरूरी है।");if(!Number.isInteger(duration)||duration<1||duration>600)throw Error("Timer 1 से 600 मिनट के बीच रखें।");
      if(!questions.length||questions.length>2000)throw Error("1 से 2000 प्रश्न रखें।");
      const cleaned=questions.map((q,i)=>{
        if(!q.text.trim())throw Error("Question "+(i+1)+" का प्रश्न खाली है।");
        if(!Number.isFinite(Number(q.marks))||Number(q.marks)<1||Number(q.marks)>100)throw Error("Question "+(i+1)+" के marks जाँचें।");
        if(isObjective&&(q.options.length!==4||q.options.some(v=>!String(v).trim())))throw Error("Question "+(i+1)+" के चारों options भरें।");
        if(isObjective&&(!Number.isInteger(q.answer)||q.answer<0||q.answer>3))throw Error("Question "+(i+1)+" का सही उत्तर चुनें।");
        return {...q,type:mode,options:isObjective?q.options:[],answer:isObjective?q.answer:null,marks:Number(q.marks)};
      });
      const r=await call("saveQuiz",{title:topic+" - "+kind+" Quiz",subject:topic,topic,duration,questions:cleaned,quizType:mode,publish:true});
      alertMsg(kind+" Quiz publish हो गया। "+r.questionCount+" प्रश्न • कुल "+r.totalMarks+" अंक");tab="admin";render();
    }catch(err){alertMsg(err.message)}finally{button.disabled=false}
  };
  draw();
}
async function contentUploadPage(kind){
  if(role!=="admin"&&role!=="superadmin")return;
  const isPyq=kind==="pyq",prefix=isPyq?"pyq":"note",title=isPyq?"PYQ":"Notes";
  panel("Upload "+title,'<button class="text-button" id="backContent">← Admin Dashboard</button><div class="builder-heading"><span class="eyebrow">EDUFUTURE • CONTENT LIBRARY</span><h2>'+title+' Upload</h2><p>इस पेज पर केवल '+title+' upload और manage होंगे।</p></div><label>'+title+' Title</label><input id="'+prefix+'Title" placeholder="'+title+' title"><label>Subject</label><input id="'+prefix+'Subject" placeholder="जैसे Science"><label>Description</label><textarea id="'+prefix+'Description" rows="3"></textarea><label>PDF / DOC / DOCX / PPT / Image (अधिकतम 30 MB)</label><input id="'+prefix+'File" type="file" accept=".pdf,.doc,.docx,.ppt,.pptx,.png,.jpg,.jpeg,.webp"><label>या Hosted File URL</label><input id="'+prefix+'Url" type="url" placeholder="https://..."><p id="'+prefix+'Status" class="hint">फ़ाइल चुनें या Hosted URL डालें।</p><button id="'+prefix+'Save" class="success-action">Upload '+title+'</button><section class="item"><h3>Manage '+title+'</h3><div id="'+prefix+'List">Loading…</div></section>');
  $("backContent").onclick=()=>{tab="admin";render()};
  async function refresh(){
    try{const snap=await getDocs(collection(db,"content")),items=snap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.type===kind);
      $(prefix+"List").innerHTML=items.length?items.map(x=>'<div class="admin-row"><span>'+esc(x.title)+' • '+(x.published?"Published":"Hidden")+'</span><button data-toggle-content="'+x.id+'" data-next="'+(!x.published)+'">'+(x.published?"Hide":"Publish")+'</button></div>').join(""):'<p>अभी कोई '+title+' नहीं है।</p>';
      $(prefix+"List").querySelectorAll("[data-toggle-content]").forEach(b=>b.onclick=async()=>{try{await call("setContentPublished",{id:b.dataset.toggleContent,published:b.dataset.next==="true"});refresh()}catch(err){alertMsg(err.message)}});
    }catch(err){$(prefix+"List").textContent=err.message}
  }
  $(prefix+"Save").onclick=async()=>{
    const button=$(prefix+"Save"),file=$(prefix+"File").files[0];button.disabled=true;
    try{const name=$(prefix+"Title").value.trim(),subject=$(prefix+"Subject").value.trim();if(!name||!subject)throw Error("Title और Subject भरना जरूरी है।");let url=$(prefix+"Url").value.trim();
      if(file){if(file.size>30*1024*1024)throw Error("फ़ाइल 30 MB से छोटी होनी चाहिए।");if(!/\.(pdf|doc|docx|ppt|pptx|png|jpe?g|webp)$/i.test(file.name))throw Error("यह file type supported नहीं है।");$(prefix+"Status").textContent="फ़ाइल upload हो रही है…";const safe=file.name.replace(/[^a-zA-Z0-9._-]/g,"_"),target=storageRef(storage,"learning/"+user.uid+"/"+kind+"/"+Date.now()+"-"+safe),uploaded=await uploadBytes(target,file,{contentType:file.type||"application/octet-stream"});url=await getDownloadURL(uploaded.ref)}
      if(!url)throw Error("फ़ाइल चुनें या Hosted URL डालें।");await call("addContent",{title:name,subject,type:kind,description:$(prefix+"Description").value,url,published:true});alertMsg(title+" upload और publish हो गया।");$(prefix+"Title").value="";$(prefix+"Subject").value="";$(prefix+"Description").value="";$(prefix+"Url").value="";$(prefix+"File").value="";$(prefix+"Status").textContent="अगली फ़ाइल चुन सकते हैं।";refresh();
    }catch(err){$(prefix+"Status").textContent=err.message;alertMsg(err.message)}finally{button.disabled=false}
  };refresh();
}

async function superPage(){
  if(role!=="superadmin")return;
  panel("Super Admin Controls",'<div class="item"><h3>Create Admin</h3><p class="hint">Admin का account पहले से बना होना चाहिए।</p><input id="adminEmail" type="email" placeholder="Registered admin email"><button id="createAdmin">Create Admin</button></div><div class="item"><h3>Manage All Admins</h3><button id="refreshAdmins">Refresh List</button><div id="adminList"></div></div>');
  async function load(){try{const r=await call("listAdmins");$("adminList").innerHTML=r.admins.map(a=>'<div class="admin-row"><span>'+esc(a.displayName||a.email||a.uid)+' — '+esc(a.role)+'</span>'+(a.role==="admin"?'<button class="danger" data-remove="'+a.uid+'">Remove Admin</button>':"")+"</div>").join("")||"<p>कोई Admin नहीं है।</p>";$("adminList").querySelectorAll("[data-remove]").forEach(b=>b.onclick=async()=>{if(!confirm("क्या इस Admin की भूमिका Student करनी है?"))return;try{await call("removeAdmin",{uid:b.dataset.remove});alertMsg("Admin role हटा दी गई।");load()}catch(e){alertMsg(e.message)}})}catch(e){$("adminList").textContent=e.message}}
  $("createAdmin").onclick=async()=>{try{await call("addAdmin",{email:$("adminEmail").value.trim()});alertMsg("Admin बना दिया गया।");$("adminEmail").value="";load()}catch(e){alertMsg(e.message)}};
  $("refreshAdmins").onclick=load;load();
}
