import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, GoogleAuthProvider, signInWithPopup, sendPasswordResetEmail, signOut, updateProfile, setPersistence, browserLocalPersistence } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, collection, addDoc, getDocs, query, where, serverTimestamp, updateDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig, API_BASE } from "./firebase-config.js";

const app = initializeApp(firebaseConfig), auth = getAuth(app), db = getFirestore(app);
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
async function uploadContentFile(contentId, file) {
  const current = auth.currentUser;
  if (!current) throw new Error("कृपया पहले login करें।");
  const token = await current.getIdToken();
  const response = await fetch(API_BASE.replace(/\/+$/, "") + "/api/content-upload/" + encodeURIComponent(contentId), {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/octet-stream",
      "X-File-Name": encodeURIComponent(file.name),
      "X-File-Type": file.type || ""
    },
    body: file
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || "फ़ाइल upload नहीं हो सकी।");
  return result.data;
}
async function uploadNoticeFile(id,file){
  const current=auth.currentUser;if(!current)throw new Error("कृपया पहले login करें।");
  const token=await current.getIdToken();
  const response=await fetch(API_BASE.replace(/\/+$/,"")+"/api/notice-upload/"+encodeURIComponent(id),{
    method:"POST",headers:{"Authorization":"Bearer "+token,"Content-Type":"application/octet-stream","X-File-Name":encodeURIComponent(file.name),"X-File-Type":file.type||""},body:file
  });
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(result.error?.message||"Notice media upload नहीं हो सका।");
  return result.data;
}
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
    const profileSnap=await getDoc(doc(db,"roles",u.uid));
    const profile=profileSnap.exists()?profileSnap.data():{};
    const displayName=profile.displayName||u.displayName||u.email||"User";
    $("identity").textContent=displayName;
    $("avatarInitial").textContent=(displayName.trim().charAt(0)||"U").toLocaleUpperCase("hi-IN");
    $("profileName").textContent=displayName;
    $("profileEmail").textContent=u.email||"";
    if($("profileClass"))$("profileClass").textContent=profile.className?"कक्षा: "+profile.className:"";
    $("profileRole").textContent=role==="superadmin"?"Head Teacher":role==="admin"?"Teacher":role==="teacher"?"Teacher":"Student";
    $("roleBadge").textContent="✓ "+$("profileRole").textContent.toUpperCase();
    $("profileMenu").hidden=true;
    openApp();
    tab="home";
    if(role==="student"&&(!profile.displayName||!profile.className)){showStudentProfileSetup(u,profile);return;}
    render();
  }catch(e){await signOut(u).catch(()=>{});openLogin();msg("Role verification नहीं हो सकी: "+e.message)}
});

async function showStudentProfileSetup(current,profile={}){
  panel("अपना Student Profile पूरा करें",'<div class="profile-setup-card"><span class="eyebrow">EDUFUTURE • STUDENT PROFILE</span><h2>आपका नाम और कक्षा क्या है?</h2><p>यह जानकारी आपके Student Dashboard, Teacher Workspace और Admin Dashboard में सही पहचान दिखाने के लिए उपयोग होगी।</p><label for="studentFullName">पूरा नाम</label><input id="studentFullName" maxlength="80" value="'+esc(profile.displayName||current.displayName||"")+'" placeholder="अपना पूरा नाम"><label for="studentClassName">कक्षा</label><input id="studentClassName" maxlength="30" value="'+esc(profile.className||"")+'" placeholder="जैसे Class 10"><button id="saveStudentProfile" class="success-action">Save Profile & Continue</button><p id="profileSetupStatus" class="hint" role="status"></p></div>');
  $("saveStudentProfile").onclick=async()=>{
    const button=$("saveStudentProfile"),displayName=$("studentFullName").value.trim(),className=$("studentClassName").value.trim();
    if(displayName.length<2||!className){$("profileSetupStatus").textContent="पूरा नाम और कक्षा दोनों भरें।";return}
    button.disabled=true;$("profileSetupStatus").textContent="Profile save हो रहा है…";
    try{
      const saved=await call("saveStudentProfile",{displayName,className});
      await updateProfile(current,{displayName:saved.displayName});
      $("identity").textContent=saved.displayName;$("avatarInitial").textContent=saved.displayName.charAt(0).toLocaleUpperCase("hi-IN");$("profileName").textContent=saved.displayName;
      if($("profileClass"))$("profileClass").textContent="कक्षा: "+saved.className;
      render();
    }catch(e){$("profileSetupStatus").textContent=e.message;button.disabled=false}
  };
}
const studentTabs=[["home","Home"],["progress","My Progress"],["aichat","AI Study Chat"],["notices","Important Notice"],["quiz","Available Quizzes"],["notes","Study Notes"],["pyq","Previous Year Questions"],["leaderboard","Leaderboard"],["results","My Results"],["doubts","Doubt Solving"],["tasks","Daily Targets"],["planner","Study Routine"],["cards","Flashcards"]];
function closeWorkspaceMenu(){
  $("app").classList.remove("menu-open");
  $("menuToggle").setAttribute("aria-expanded","false");
}
function render(){
  let tabs=studentTabs;
  if(role==="teacher")tabs=[["home","Home"],["notices","Important Notice"],["teacher","Teacher Workspace"],["analytics","Teacher Analytics"]];
  if(role==="admin")tabs=[["home","Home"],["aichat","AI Study Chat"],["ainotes","AI Notes PDF"],["notices","Important Notice"],["teacher","Teacher Workspace"],["admin","Admin Dashboard"],["activity","Activity Log"]];
  if(role==="superadmin")tabs=[["home","Home"],["aichat","AI Study Chat"],["ainotes","AI Notes PDF"],["notices","Important Notice"],["overview","Overview"],["teacher","Teacher Workspace"],["admin","Admin Dashboard"],["activity","Activity Log"],["super","Super Admin"]];
  const pages={overview:superOverviewPage,progress:studentProgressPage,analytics:teacherAnalyticsPage,activity:adminActivityPage,home:role==="superadmin"?superHomePage:homePage,aichat:()=>window.aiChatPage(),ainotes:()=>window.aiNotesPage(),notices:importantNoticesPage,quiz:quizPage,notes:notesPage,pyq:pyqPage,leaderboard:leaderboardPage,results:resultsPage,doubts:doubtsPage,teacher:teacherPage,tasks:tasksPage,planner:plannerPage,cards:cardsPage,admin:adminPage,aiquestions:aiQuestionBankPage,createquiz:createQuizPage,objectivebuilder:()=>quizBuilderPage("objective"),subjectivebuilder:()=>quizBuilderPage("subjective"),notesupload:()=>contentUploadPage("note"),pyqupload:()=>contentUploadPage("pyq"),super:superPage};
  // Internal workflow pages are intentionally not sidebar items. Keep them routable.
  if(!tabs.some(x=>x[0]===tab)&&!pages[tab])tab=tabs[0][0];
  $("nav").innerHTML='<div class="nav-section-label">MENU</div>'+tabs.map(x=>'<button data-tab="'+x[0]+'" class="nav-link '+(tab===x[0]?"active":"")+'"><span class="nav-icon">'+({overview:"◈",home:"⌂",aichat:"✦",ainotes:"▤",notices:"📢",quiz:"▤",notes:"▧",leaderboard:"♛",results:"◷",doubts:"✉",tasks:"✓",planner:"▦",cards:"▣",teacher:"▤",admin:"⚙",super:"♜"}[x[0]]||"•")+'</span><span>'+x[1]+"</span></button>").join("");
  $("nav").querySelectorAll("[data-tab]").forEach(b=>b.onclick=()=>{tab=b.dataset.tab;render();closeWorkspaceMenu()});
  (pages[tab]||homePage)().catch(e=>panel("त्रुटि",'<p class="error">'+esc(e.message)+"</p>"));
}
async function superOverviewPage(){
  const [quizSnap,admins,students]=await Promise.all([
    getDocs(collection(db,"quizzes")),
    call("listAdmins").catch(()=>({admins:[]})),
    call("listStudents").catch(()=>({students:[]}))
  ]);
  const publishedQuizzes = quizSnap.docs.filter(d => d.data().status === "published").length;
  panel("Super Admin Overview",'<div class="admin-welcome"><span class="eyebrow">EDUFUTURE • SYSTEM CONTROL</span><h2>पूरा संस्थान, एक ही Control Center</h2><p>Users, teachers, quizzes और learning operations पर नज़र रखें।</p><div class="overview-actions"><button data-super-admin>Admin Management</button><button data-super-tools>Open Admin Dashboard</button></div></div><div class="grid"><div class="stat"><strong>'+Number(students.students?.length||0)+'</strong><span>Registered Students</span></div><div class="stat"><strong>'+Number(admins.admins?.length||0)+'</strong><span>Admins & Super Admins</span></div><div class="stat"><strong>'+publishedQuizzes+'</strong><span>Published Quizzes</span></div></div><div class="super-welcome-note"><b>Super Admin Access</b><p>यह workspace केवल संस्थान के मुख्य नियंत्रण के लिए है। Student dashboard अलग account role में ही उपलब्ध होगा।</p></div>');
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
async function studentProgressPage(){
  const [stats,results]=await Promise.all([call("getStudentProgress"),call("getMyResults")]);
  const topics=(stats.weakTopics||[]).map(x=>'<article class="item"><b>'+esc(x.topic)+'</b><p>'+x.accuracy+'% सही उत्तर • '+x.correct+'/'+x.total+'</p></article>').join("");
  const recent=(results.results||[]).slice(0,12).map(x=>'<article class="item"><b>'+esc(x.title||"Quiz")+'</b><p>'+(x.released?esc(x.score)+' / '+esc(x.total)+' अंक':"Result अभी जारी नहीं हुआ")+'</p></article>').join("");
  panel("मेरी पढ़ाई की Progress",'<div class="grid"><div class="stat"><strong>'+stats.attempts+'</strong><span>Quiz शुरू किए</span></div><div class="stat"><strong>'+stats.completed+'</strong><span>Quiz पूरे किए</span></div><div class="stat"><strong>'+stats.score+'/'+stats.total+'</strong><span>कुल अंक</span></div><div class="stat"><strong>'+stats.accuracy+'%</strong><span>सही उत्तर</span></div></div><section class="item"><h3>अधिक अभ्यास वाले विषय</h3>'+(topics||'<p>अभी पर्याप्त विषय-आधारित परिणाम उपलब्ध नहीं हैं।</p>')+'</section><section class="item"><h3>हाल के Quiz</h3>'+(recent||'<p>अभी कोई Quiz Attempt नहीं किया।</p>')+'</section>');
}
async function teacherAnalyticsPage(){
  const a=await call("getTeacherAnalytics");
  const rows=(a.subjects||[]).map(x=>'<tr><td>'+esc(x.subject)+'</td><td>'+x.attempts+'</td><td>'+x.accuracy+'%</td></tr>').join("");
  panel("Teacher Analytics",'<div class="grid"><div class="stat"><strong>'+a.studentCount+'</strong><span>विद्यार्थी</span></div><div class="stat"><strong>'+a.submissions+'</strong><span>Quiz Submissions</span></div><div class="stat"><strong>'+a.average+'%</strong><span>औसत प्रदर्शन</span></div></div><section class="item"><h3>विषय के अनुसार प्रदर्शन</h3><div class="table-wrap"><table><thead><tr><th>विषय</th><th>Attempts</th><th>Accuracy</th></tr></thead><tbody>'+(rows||'<tr><td colspan="3">अभी Analytics डेटा उपलब्ध नहीं है।</td></tr>')+'</tbody></table></div></section>');
}
async function adminActivityPage(){
  const r=await call("listAdminActivity");
  const rows=(r.items||[]).map(x=>'<article class="item"><b>'+esc(x.action)+' • '+esc(x.entityType)+'</b><p>'+esc(x.details?.topic||x.details?.title||x.entityId||"")+'</p><small>'+esc(x.actorUid)+' • '+dateText(x.createdAt)+'</small></article>').join("");
  panel("Admin Activity Log",rows||'<div class="empty-state">अभी कोई Admin activity दर्ज नहीं है।</div>');
}
async function homePage(){
  const [quizSnap,resultData]=await Promise.all([getDocs(query(collection(db,"quizzes"),where("status","==","published"))),call("getMyResults").catch(()=>({results:[]}))]);
  const activeQuizCount=quizSnap.docs.filter(d=>{
    const q=d.data(),published=q.publishedAt?.toMillis?.()||0;
    const release=q.resultsAt?.toMillis?.()||published+72*60*60*1000;
    return !release||Date.now()<release;
  }).length;
  const myResults=resultData.results||[];
  const released=myResults.filter(x=>x.released).sort((a,b)=>new Date(b.releaseAt||0)-new Date(a.releaseAt||0)), tests=myResults.length;
  const marks=released.reduce((n,x)=>n+Number(x.score||0),0), total=released.reduce((n,x)=>n+Number(x.total||0),0);
  const accuracy=total?Math.round(marks/total*100):0;
  let rankText="—";
  if(released.length){try{const board=await call("getLeaderboard",{id:released[0].quizId});const mine=board.rows.find(x=>x.uid===user.uid);if(mine)rankText="#"+mine.rank}catch{}}
  const noticePreview=await call("listNotices").catch(()=>({notices:[]}));
  const noticeHtml=noticePreview.notices?.length?'<section class="item"><div class="question-head"><h3>📢 Important Notice</h3><button data-open-notices>सभी देखें</button></div>'+noticePreview.notices.slice(0,2).map(n=>'<article><b>'+esc(n.title||"School Notice")+'</b><p>'+esc(n.body||"")+'</p><small>'+dateText(n.createdAt)+'</small></article>').join("")+'</section>':'<section class="item"><h3>📢 Important Notice</h3><p>अभी कोई नया Notice नहीं है।</p></section>';
  panel("स्वागत है, "+(user.displayName||"EduFuture User"),'<div class="dashboard-hero"><span class="eyebrow">EDUFUTURE • YOUR WORKSPACE</span><h2>आज सीखें, कल आगे बढ़ें।</h2><p>अपनी पढ़ाई और स्कूल के सभी उपलब्ध काम एक ही जगह से शुरू करें।</p><button data-goquiz>नया टेस्ट शुरू करें</button></div><div class="grid"><div class="stat"><strong>'+quizSnap.size+'</strong><span>Available Quizzes</span></div><div class="stat"><strong>'+tests+'</strong><span>Tests Attempted</span></div><div class="stat"><strong>'+marks+'/'+total+'</strong><span>Marks Earned</span></div><div class="stat"><strong>'+accuracy+'%</strong><span>Accuracy</span></div><div class="stat"><strong>'+rankText+'</strong><span>Latest Quiz Rank</span></div></div><div class="dashboard-shortcuts"><button data-godoubts>Ask a Doubt</button><button data-goresults>Test History</button><button data-gonotes>Study Notes</button></div>');
  $("view").querySelector("[data-goquiz]").onclick=()=>{tab="quiz";render()};
  $("view").querySelector("[data-godoubts]").onclick=()=>{tab="doubts";render()};
  $("view").querySelector("[data-goresults]").onclick=()=>{tab="results";render()};
  $("view").querySelector("[data-gonotes]").onclick=()=>{tab="notes";render()};
  $("view").insertAdjacentHTML("beforeend",noticeHtml);
  $("view").querySelector("[data-open-notices]")?.addEventListener("click",()=>{tab="notices";render()});
}
async function quizPage(){
  const [s,profileSnap]=await Promise.all([
    getDocs(query(collection(db,"quizzes"),where("status","==","published"))),
    getDoc(doc(db,"roles",user.uid))
  ]);
  const studentClass=String(profileSnap.exists()?profileSnap.data().className||"": "").toLowerCase().replace(/^(class|कक्षा)\s*/i,"").replace(/[^\p{L}\p{N}]/gu,"");
  const activeDocs=s.docs.filter(d=>{
    const q=d.data(), published=q.publishedAt?.toMillis?.()||0;
    const release=q.resultsAt?.toMillis?.()||published+72*60*60*1000;
    const quizClass=String(q.className||"").trim();
    const generalClass=!quizClass||["all","general","सभी"].includes(quizClass.toLowerCase());
    const normalizedQuizClass=quizClass.toLowerCase().replace(/^(class|कक्षा)\s*/i,"").replace(/[^\p{L}\p{N}]/gu,"");
    const matchesClass=generalClass||(studentClass&&studentClass===normalizedQuizClass);
    return matchesClass&&(!release||Date.now()<release);
  });
  const cards=await Promise.all(activeDocs.map(async d=>{
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
  panel("Available Quizzes",'<div class="quiz-window-banner"><span class="eyebrow">EDUFUTURE • LIMITED ATTEMPT WINDOW</span><h2>हर प्रश्नपत्र के लिए 48 घंटे</h2><p>पहले 48 घंटे में attempt करें। Result और सभी की Rank प्रश्नपत्र upload होने के 72 घंटे बाद खुलेंगे।</p></div>'+(cards.length?cards.join(""):"<p>अभी कोई उपलब्ध Quiz नहीं है। 72 घंटे पूरे होने वाले प्रश्नपत्र Archive हो चुके हैं। पुराने परिणाम My Results में सुरक्षित हैं।</p>"));
  const tick=()=>{$("view").querySelectorAll("[data-countdown]").forEach(el=>{const ms=Number(el.dataset.countdown)-Date.now();if(ms<=0){el.textContent="अब उपलब्ध है — पेज refresh करें";return}const h=Math.floor(ms/3600000),m=Math.floor(ms%3600000/60000),sec=Math.floor(ms%60000/1000);el.textContent=h+"घं "+m+"मि "+sec+"से"});};
  tick();clearInterval(window.quizCountdownTimer);window.quizCountdownTimer=setInterval(tick,1000);
  $("view").querySelectorAll("[data-start]").forEach(b=>b.onclick=()=>startQuiz(b.dataset.start));
}
async function startQuiz(id){
  try{
    const d=await call("startQuiz",{id});
    activeQuiz={id:id,...d};answers={};
    const deadline=new Date(d.expiresAt).getTime();
    let currentQuestion=0;
    function draw(){
      const questions=activeQuiz.questions||[];
      if(!questions.length)throw new Error("इस Quiz में कोई प्रश्न उपलब्ध नहीं है।");
      const q=questions[currentQuestion];
      const left=Math.max(0,Math.ceil((deadline-Date.now())/1000));
      const progress=Math.round(((currentQuestion+1)/questions.length)*100);
      const answer=answers[q.id];
      const questionBody=q.type==="subjective"
        ? '<label class="question-label" for="currentSubjectiveAnswer">अपना उत्तर लिखें</label><textarea id="currentSubjectiveAnswer" class="subjective-answer" maxlength="5000" rows="7" placeholder="यहाँ अपना उत्तर लिखें">'+esc(answer||"")+'</textarea>'
        : '<div class="quiz-options">'+q.options.map((o,j)=>'<label class="option"><input type="radio" name="currentQuestionOption" value="'+j+'" '+(answer===j?"checked":"")+'> <span>'+esc(o)+'</span></label>').join("")+'</div>';
      $("view").innerHTML='<section class="panel quiz-attempt-panel"><div class="quiz-attempt-top"><div><span class="eyebrow">EDUFUTURE • ONLINE EXAM</span><h2>'+esc(activeQuiz.title)+'</h2></div><div class="timer" id="quizClock">'+Math.floor(left/60)+':'+String(left%60).padStart(2,"0")+'</div></div><div class="quiz-progress-meta"><b>प्रश्न '+(currentQuestion+1)+' / '+questions.length+'</b><span>'+progress+'% पूरा</span></div><div class="quiz-progress-track"><i style="width:'+progress+'%"></i></div><article class="question quiz-single-question"><div class="question-meta"><span>'+(q.type==="subjective"?"SUBJECTIVE":"OBJECTIVE")+'</span><span>'+esc(q.difficulty||"medium").toUpperCase()+'</span><span>'+Number(q.marks||1)+' अंक</span></div><h3>'+esc(q.text)+'</h3>'+questionBody+'</article><div class="quiz-step-actions"><button id="previousQuestion" class="secondary" '+(currentQuestion===0?"disabled":"")+'>← पिछला प्रश्न</button>'+(currentQuestion<questions.length-1?'<button id="nextQuestion" class="primary">अगला प्रश्न →</button>':'<button id="submitQuiz" class="success-action">Submit Quiz</button>')+'</div><div class="quiz-question-jump"><span>प्रश्न सूची</span><div>'+questions.map((item,i)=>'<button type="button" data-question-index="'+i+'" class="'+(i===currentQuestion?"active ":"")+(Object.prototype.hasOwnProperty.call(answers,item.id)?"answered":"")+'" aria-label="प्रश्न '+(i+1)+'">'+(i+1)+'</button>').join("")+'</div></div><p class="hint">आप प्रश्नों के बीच आगे-पीछे जा सकते हैं। उत्तर अपने-आप सुरक्षित रहेंगे।</p></section>';
      window.renderEduMath?.($("view"));
      $("view").querySelectorAll('input[name="currentQuestionOption"]').forEach(x=>x.onchange=()=>{answers[q.id]=Number(x.value);drawKeepFocus();});
      const area=$("currentSubjectiveAnswer");
      if(area)area.oninput=()=>{answers[q.id]=area.value;};
      $("previousQuestion").onclick=()=>{if(currentQuestion>0){currentQuestion--;draw()}};
      $("nextQuestion")?.addEventListener("click",()=>{if(currentQuestion<questions.length-1){currentQuestion++;draw()}});
      $("submitQuiz")?.addEventListener("click",()=>{const unanswered=questions.filter(item=>!Object.prototype.hasOwnProperty.call(answers,item.id)||answers[item.id]==="").length;if(unanswered&&!confirm(unanswered+" प्रश्नों के उत्तर बाकी हैं। क्या फिर भी Quiz Submit करना है?"))return;submitQuiz()});
      $("view").querySelectorAll("[data-question-index]").forEach(b=>b.onclick=()=>{currentQuestion=Number(b.dataset.questionIndex);draw()});
    }
    function drawKeepFocus(){
      // Update progress badges without rebuilding the selected answer control.
      $("view").querySelectorAll("[data-question-index]").forEach((b,i)=>{b.classList.toggle("answered",Object.prototype.hasOwnProperty.call(answers,activeQuiz.questions[i].id));});
    }
    draw();clearInterval(timer);
    timer=setInterval(()=>{const n=Math.max(0,Math.ceil((deadline-Date.now())/1000));if($("quizClock"))$("quizClock").textContent=Math.floor(n/60)+":"+String(n%60).padStart(2,"0");if(!n)submitQuiz()},1000);
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
  panel("Objective & Subjective Rankings",'<div class="leaderboard-banner"><span class="eyebrow">EDUFUTURE • HALL OF FAME</span><h2>आपकी मेहनत, आपकी पहचान</h2><p>हर Quiz में अपनी रैंक और कुल प्रतिभागियों की संख्या देखें।</p></div>'+(s.empty?"<p>अभी कोई quiz नहीं है।</p>":s.docs.map(d=>'<article class="leaderboard-quiz"><div><h3>'+esc(d.data().title)+'</h3><p class="hint">'+(d.data().quizType==="subjective"?"Subjective Written Test":d.data().quizType==="objective"?"Objective MCQ Test":"Objective + Subjective Test")+'</p></div><div class="rank-actions"><button data-rank="'+d.id+'" data-rank-type="objective">Objective Rank</button><button class="secondary" data-rank="'+d.id+'" data-rank-type="subjective">Subjective Rank</button></div><div class="leaderboard-output" id="rank-'+d.id+'-objective"></div><div class="leaderboard-output" id="rank-'+d.id+'-subjective"></div></article>').join("")));
  $("view").querySelectorAll("[data-rank]").forEach(b=>b.onclick=async()=>{
    const id=b.dataset.rank,type=b.dataset.rankType,out=$("rank-"+id+"-"+type);
    $("view").querySelectorAll("#rank-"+id+"-objective,#rank-"+id+"-subjective").forEach(x=>{if(x!==out)x.innerHTML=""});
    out.innerHTML='<p class="hint">'+(type==="objective"?"Objective":"Subjective")+' Rank लोड हो रही है…</p>';
    try{
      const r=await call("getLeaderboard",{id,rankingType:type});
      if(!r.released){out.innerHTML='<div class="locked-note">🔒 '+(type==="subjective"?"Teacher अभी written answers जाँच रहे हैं। सभी जाँच पूरी होने और result खुलने के बाद Subjective Rank दिखाई देगी।":"Objective Rank निर्धारित समय पर खुलेगी।")+' '+(r.releaseAt?'समय: '+dateText(r.releaseAt):"")+'</div>';return}
      if(!r.rows.length){out.innerHTML='<p>अभी कोई result उपलब्ध नहीं है।</p>';return}
      const medals=["🥇","🥈","🥉"];
      const mine=r.rows.find(x=>x.uid===user.uid);
      const rankSummary='<div class="rank-summary"><b>कुल प्रतिभागी: '+r.rows.length+'</b>'+(mine?'<span>आपकी रैंक: #'+mine.rank+' / '+r.rows.length+'</span>':'<span>आपने अभी यह Quiz Attempt नहीं किया है।</span>')+'</div>';
      out.innerHTML=rankSummary+'<h4>'+(type==="objective"?"Objective Ranking":"Subjective Ranking")+'</h4><div class="podium">'+r.rows.slice(0,3).map((x,i)=>'<div class="podium-card podium-'+(i+1)+'"><span class="medal">'+medals[i]+'</span><strong>#'+x.rank+'</strong><b>'+esc(x.name)+'</b><small>'+x.score+'/'+x.total+' अंक</small></div>').join("")+'</div><div class="rank-table">'+r.rows.map(x=>'<div class="rank-row '+(x.uid===user.uid?'my-rank':'')+'"><b class="rank-number">#'+x.rank+'</b><span class="rank-name">'+esc(x.name)+(x.uid===user.uid?' <em>YOU</em>':'')+'</span><strong>'+x.score+'/'+x.total+'</strong><span class="rank-percent">'+Math.round(x.total?x.score/x.total*100:0)+'%</span></div>').join("")+'</div>';
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
function formatAiNotesContent(source){
  return String(source||"").split(/\r?\n/).map(line=>{
    const safe=esc(line).replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>").replace(/\*(.+?)\*/g,"<em>$1</em>");
    if(/^###\s/.test(line))return "<h3>"+safe.replace(/^###\s/,"")+"</h3>";
    if(/^##\s/.test(line))return "<h2>"+safe.replace(/^##\s/,"")+"</h2>";
    if(/^#\s/.test(line))return "<h1>"+safe.replace(/^#\s/,"")+"</h1>";
    if(/^\s*[-*]\s/.test(line))return "<p class=\"pdf-bullet\">• "+safe.replace(/^\s*[-*]\s/,"")+"</p>";
    if(/^\d+[.)]\s/.test(line))return "<p class=\"pdf-bullet\">"+safe+"</p>";
    return line.trim()?"<p>"+safe+"</p>":"<div class=\"pdf-gap\"></div>";
  }).join("");
}
async function contentLibraryPage(kind,title){
  const s=await getDocs(query(collection(db,"content"),where("published","==",true)));
  const docs=s.docs.filter(d=>(d.data().type||"note")===kind);
  let aiNotes=[];
  if(kind==="note"){try{const r=await call("listPublishedAiNotes");aiNotes=r.notes||[]}catch(e){console.warn("AI published notes:",e.message)}}
  const uploaded=docs.map(d=>{const x=d.data();return '<article class="ef-library-card"><div class="question-meta"><span>'+esc(x.subject||"General")+'</span><span>STUDY NOTES</span></div><h3>'+esc(x.title)+'</h3><p>'+esc(x.description)+'</p>'+(x.storagePath?'<button class="secondary" data-secure-download="'+esc(d.id)+'">Open / Download</button>':'<a href="'+esc(x.url||"")+'" target="_blank" rel="noopener">Open / Download</a>')+'</article>'}).join("");
  const generated=aiNotes.map(n=>'<article class="ef-library-card ef-ai-published-card"><div class="question-meta"><span>'+esc(n.className)+'</span><span>AI STUDY NOTES</span></div><h3>'+esc(n.topic)+'</h3><p>'+esc(n.subject)+' • EduFuture AI</p><button class="secondary" data-ai-open="'+esc(n.id)+'">Notes पढ़ें</button></article>').join("");
  panel(title,'<div class="ef-library-intro"><h2>पढ़ने और दोहराने के लिए सामग्री</h2><p>अपने अध्याय के Notes यहाँ पढ़ें।</p></div>'+(uploaded||generated?'<div class="ef-library-grid">'+uploaded+generated+'</div>':'<div class="empty-state">अभी कोई सामग्री उपलब्ध नहीं है।</div>')+'<section id="studentAiNotePreview" class="ef-student-note-preview" hidden></section>');
  $("view").querySelectorAll("[data-secure-download]").forEach(b=>b.onclick=async()=>{try{b.disabled=true;const result=await call("getContentDownload",{id:b.dataset.secureDownload});window.location.assign(result.url)}catch(e){alertMsg("फ़ाइल नहीं खुल सकी: "+e.message)}finally{b.disabled=false}});
  $("view").querySelectorAll("[data-ai-open]").forEach(b=>b.onclick=()=>{const n=aiNotes.find(x=>x.id===b.dataset.aiOpen);if(!n)return;const box=$("studentAiNotePreview");box.hidden=false;box.innerHTML='<div class="ef-note-preview-head"><div><span>'+esc(n.className)+' • '+esc(n.subject)+'</span><h2>'+esc(n.topic)+'</h2></div><button id="studentNotePdf" class="success-action">PDF / Print</button></div><div class="ai-notes-content">'+formatAiNotesContent(n.content)+'</div>';window.renderEduMath?.(box);$("studentNotePdf").onclick=()=>{const w=window.open("","_blank");if(!w)return alertMsg("Pop-up allow करें।");w.document.write('<html lang="hi"><meta charset="utf-8"><title>'+esc(n.topic)+'</title><script>window.MathJax={tex:{inlineMath:[["$","$"],["\\\\(","\\\\)"]],displayMath:[["$","$"],["\\\\[","\\\\]"]],processEscapes:true}};<\\/script><script async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js"></script><style>body{font-family:Arial,sans-serif;line-height:1.8;padding:28px;max-width:850px;margin:auto;color:#263449}h1,h2,h3{color:#1e3a8a}p{margin:7px 0}ul,ol{padding-left:26px}@page{size:A4;margin:18mm}</style><h1>'+esc(n.topic)+'</h1><p>'+esc(n.className)+' • '+esc(n.subject)+'</p>'+formatAiNotesContent(n.content)+'<script>onload=()=>setTimeout(async()=>{try{await MathJax.typesetPromise()}catch(e){}print()},1000)<\\/script></html>');w.document.close()};box.scrollIntoView({behavior:"smooth",block:"start"})});
}
async function notesPage(){return contentLibraryPage("note","Study Notes")}
async function pyqPage(){return contentLibraryPage("pyq","Previous Year Questions")}
async function doubtsPage(){
  const mine=await call("listDoubts");
  panel("Doubt Solving",'<div class="doubt-compose"><h3>अपना सवाल पूछें</h3><label>Subject</label><input id="doubtSubject" placeholder="जैसे Science, Maths"><label>Topic (वैकल्पिक)</label><input id="doubtTopic" placeholder="Chapter / Topic"><label>Question</label><textarea id="doubtQuestion" maxlength="5000" placeholder="अपना सवाल विस्तार से लिखें…"></textarea><button id="sendDoubt">Submit Doubt</button></div><h3>मेरे सवाल</h3>'+(mine.doubts.length?mine.doubts.map(x=>'<article class="item"><div class="question-meta"><span>'+esc(x.subject)+'</span><span>'+esc(x.status)+'</span></div><h4>'+esc(x.topic||"General")+'</h4><p>'+esc(x.question)+'</p>'+(x.reply?'<div class="teacher-reply"><b>Teacher Reply</b><p>'+esc(x.reply)+'</p></div>':'<p class="hint">Teacher के जवाब का इंतज़ार है।</p>')+'</article>').join(""):'<p>अभी कोई सवाल नहीं पूछा गया है।</p>'));
  $("sendDoubt").onclick=async()=>{
    const button=$("sendDoubt"),subject=$("doubtSubject").value.trim(),topic=$("doubtTopic").value.trim(),question=$("doubtQuestion").value.trim();
    if(button.disabled)return;
    button.disabled=true;
    try{
      const requestId=window.crypto?.randomUUID?window.crypto.randomUUID():("doubt_"+Date.now()+"_"+Math.random().toString(36).slice(2));
      await call("createDoubt",{requestId,subject,topic,question});
      alertMsg("आपका सवाल Teacher को भेज दिया गया।");doubtsPage();
    }catch(e){alertMsg(e.message);button.disabled=false}
  };
}
async function teacherPage(cursor=null, quizId=null, attemptCursor=null){
  const [r,graded,students]=await Promise.all([
    call("listDoubts"),
    call("listSubjectiveSubmissions",quizId?{quizId,attemptCursor}:{cursor,limit:20,attemptLimit:25}),
    call("listTeacherStudents")
  ]);
  const uniqueDoubts=[...new Map((r.doubts||[]).map(x=>[x.id,x])).values()];
  const uniqueStudents=[...new Map((students.students||[]).map(x=>[x.uid,x])).values()];
  const orderedDoubts=[...uniqueDoubts].sort((a,b)=>(a.status==="open"?0:1)-(b.status==="open"?0:1));
  const doubtHtml=orderedDoubts.length?orderedDoubts.map(x=>'<article class="item teacher-doubt-card"><div class="question-meta"><span>'+esc(x.subject)+'</span><span class="doubt-status '+(x.status==="open"?"pending":"answered")+'">'+(x.status==="open"?"जवाब बाकी":"जवाब दिया गया")+'</span></div><div class="doubt-student-head"><h3>'+esc(x.studentName||"Student")+'</h3><span>'+esc(x.studentClass||"कक्षा उपलब्ध नहीं")+'</span></div><p><b>विषय:</b> '+esc(x.subject)+' • <b>टॉपिक:</b> '+esc(x.topic||"General")+'</p><div class="student-question"><b>Student का सवाल</b><p>'+esc(x.question)+'</p></div>'+(x.reply?'<div class="teacher-reply"><b>आपका जवाब</b><p>'+esc(x.reply)+'</p></div>':'')+'<label>'+(x.reply?"जवाब अपडेट करें":"Student को जवाब दें")+'</label><textarea data-reply="'+esc(x.id)+'" placeholder="अपना जवाब लिखें">'+esc(x.reply||"")+'</textarea><button data-sendreply="'+esc(x.id)+'">'+(x.reply?"Update Reply":"Send Answer")+'</button></article>').join(""):'<div class="empty-state"><b>अभी कोई Student Doubt नहीं आया।</b><p>जैसे ही Student सवाल भेजेगा, वह यहाँ दिखाई देगा।</p></div>';
  const gradeHtml=graded.submissions.length?graded.submissions.map(x=>'<article class="item"><div class="question-meta"><span>'+esc(x.subject||"General")+'</span><span>'+esc(x.topic||"")+'</span></div><h3>'+esc(x.studentName)+' • '+esc(x.quizTitle)+'</h3>'+x.questions.map(q=>{const key=esc(x.quizId)+'|'+esc(x.uid)+'|'+esc(q.questionId)+'|'+q.maxMarks;return '<div class="review-question"><b>'+esc(q.question)+'</b><p><b>Student Answer:</b> '+esc(q.studentAnswer)+'</p><p class="hint">Maximum Marks: '+q.maxMarks+(q.graded?' • पहले दिए गए अंक: '+q.awardedMarks:' • अभी जाँचा नहीं गया')+'</p>'+(q.modelAnswer?'<details><summary>Model answer देखें</summary><p>'+esc(q.modelAnswer)+'</p></details>':'')+'<label>'+(q.graded?"Update Award Marks":"Award Marks")+'</label><input type="number" min="0" max="'+q.maxMarks+'" step="0.5" value="'+(q.graded?q.awardedMarks:"")+'" data-grade="'+key+'"><label>Teacher Feedback (वैकल्पिक)</label><textarea rows="2" data-feedback="'+key+'" placeholder="Student के लिए feedback">'+esc(q.feedback||"")+'</textarea><button data-savegrade="'+key+'">'+(q.graded?"Update Grade":"Save Grade")+'</button></div>'}).join("")+(x.hasMoreAttempts&&x.quizId?'<button class="secondary" data-more-attempts="'+esc(x.quizId)+'" data-attempt-cursor="'+esc(x.attemptCursor||"")+'">इस Quiz के अगले attempts देखें →</button>':"")+'</article>').join(""):'<p>इस पेज पर अभी कोई subjective answer नहीं है।</p>';
  panel(role==="superadmin"?"Teacher Workspace":"Teacher Dashboard",'<div class="dashboard-hero"><span class="eyebrow">EDUFUTURE • TEACHER WORKSPACE</span><h2>Student Doubt & Answer Desk</h2><p>Subject के अनुसार लिखित उत्तर जाँचें। पहले जाँचे गए उत्तरों के marks और feedback भी अपडेट कर सकते हैं।</p></div><div class="grid"><div class="stat"><strong>'+uniqueDoubts.length+'</strong><span>Student Doubts</span></div><div class="stat"><strong>'+uniqueDoubts.filter(x=>x.status==="open").length+'</strong><span>Pending Replies</span></div><div class="stat"><strong>'+graded.submissions.reduce((n,x)=>n+x.questions.length,0)+'</strong><span>Answers on This Page</span></div></div><h3>Student Roster</h3><div class="student-roster">'+(uniqueStudents.length?uniqueStudents.map(x=>'<div class="admin-row"><span>'+esc(x.displayName||"Student")+' <b>'+esc(x.className||"कक्षा नहीं भरी")+'</b></span><small>'+esc(x.email)+'</small></div>').join(""):'<p>अभी कोई student नहीं है।</p>')+'</div><h3>Student Doubts — यहाँ जवाब दें</h3>'+doubtHtml+'<h3>Subjective Answer Review</h3>'+gradeHtml+(graded.hasMoreQuizzes&&graded.quizCursor?'<button id="nextTeacherQuizPage" class="secondary">अगले Quizzes देखें →</button>':"")+(quizId&&graded.hasMoreAttempts&&graded.attemptCursor?'<button id="nextTeacherAttemptPage" class="secondary">अगले Student Attempts देखें →</button>':""));
  $("view").querySelectorAll("[data-sendreply]").forEach(b=>b.onclick=async()=>{try{const id=b.dataset.sendreply;await call("replyDoubt",{id,reply:$("view").querySelector('[data-reply="'+id+'"]').value.trim()});alertMsg("जवाब भेज दिया गया।");teacherPage()}catch(e){alertMsg(e.message)}});
  $("view").querySelectorAll("[data-savegrade]").forEach(b=>b.onclick=async()=>{try{const [qid,uid,qid2,max]=b.dataset.savegrade.split("|");const marks=Number($("view").querySelector('[data-grade="'+b.dataset.savegrade+'"]').value),feedback=$("view").querySelector('[data-feedback="'+b.dataset.savegrade+'"]').value;if(!Number.isFinite(marks)||marks<0||marks>Number(max))throw Error("Marks सही सीमा में भरें।");const result=await call("gradeSubjective",{quizId:qid,uid,questionId:qid2,marks,feedback});alertMsg(result.updated?"पहले के marks और feedback अपडेट हो गए।":"Marks save हो गए।");teacherPage()}catch(e){alertMsg(e.message)}});
  const next=$("nextTeacherQuizPage");if(next)next.onclick=()=>teacherPage(graded.quizCursor);
  const more=$("nextTeacherAttemptPage");if(more)more.onclick=()=>teacherPage(null,quizId,graded.attemptCursor);
  $("view").querySelectorAll("[data-more-attempts]").forEach(b=>b.onclick=()=>teacherPage(null,b.dataset.moreAttempts,b.dataset.attemptCursor));
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
  panel("Admin Dashboard",'<div class="admin-welcome"><span class="eyebrow">EDUFUTURE • CONTROL CENTER</span><h2>Learning Management</h2><p>Quiz बनाएं, Notes और PYQ अलग-अलग upload करें और learning activities manage करें।</p></div><div class="admin-action-grid"><button class="admin-action-card" data-admin-go="createquiz"><span>＋</span><b>Create Quiz</b><small>Objective या Subjective चुनें</small></button><button class="admin-action-card" data-admin-go="notesupload"><span>▤</span><b>Upload Notes</b><small>Notes अलग से publish करें</small></button><button class="admin-action-card" data-admin-go="pyqupload"><span>▧</span><b>Upload PYQ</b><small>Previous year papers अलग रखें</small></button><button class="admin-action-card" data-admin-go="teacher"><span>♙</span><b>Teacher Workspace</b><small>Written answers और doubts जाँचें</small></button><button class="admin-action-card" data-admin-go="aiquestions"><span>✦</span><b>AI Question Generator</b><small>Gemini से प्रश्न बनाएं और approve करें</small></button></div><section class="item"><h3>Teacher Assignment</h3><label>Registered Teacher Email</label><input id="teacherEmail" type="email" placeholder="teacher@example.com"><label>Assigned Subjects (comma separated)</label><input id="teacherSubjects" placeholder="Maths, Science"><label>Assigned Classes (comma separated)</label><input id="teacherClasses" placeholder="Class 9, Class 10"><button id="assignTeacher">Assign Teacher</button></section><section class="item"><h3>Student Management</h3><button id="loadStudents" class="secondary">View Students</button><div id="studentList"></div></section><section class="item"><h3>Quiz Results</h3><div id="adminResults">Loading quizzes…</div></section>');
  $("view").querySelectorAll("[data-admin-go]").forEach(b=>b.onclick=()=>{tab=b.dataset.adminGo;render()});
  $("assignTeacher").onclick=async()=>{try{const subjects=$("teacherSubjects").value.split(",").map(x=>x.trim()).filter(Boolean),classes=$("teacherClasses").value.split(",").map(x=>x.trim()).filter(Boolean);await call("assignTeacher",{email:$("teacherEmail").value.trim(),subjects,classes});alertMsg("Teacher को चुने गए subjects और classes assign हो गए।");$("teacherEmail").value="";$("teacherSubjects").value="";$("teacherClasses").value=""}catch(e){alertMsg(e.message)}};
  $("loadStudents").onclick=async()=>{try{const r=await call("listStudents");$("studentList").innerHTML=r.students.length?r.students.map(x=>"<p>"+esc(x.displayName||x.email||x.uid)+" • "+esc(x.className||"कक्षा नहीं भरी")+"</p>").join(""):"<p>कोई student record नहीं मिला।</p>"}catch(e){$("studentList").textContent=e.message}};
  $("loadStudents").click();
  const snap=await getDocs(collection(db,"quizzes"));
  $("adminResults").innerHTML=snap.empty?"<p>अभी कोई Quiz नहीं है।</p>":snap.docs.map(d=>'<div class="admin-row"><span>'+esc(d.data().title)+'</span><button data-admin-result="'+d.id+'">View Results</button></div><div id="admin-result-'+d.id+'"></div>').join("");
  $("adminResults").querySelectorAll("[data-admin-result]").forEach(b=>b.onclick=async()=>{const out=$("admin-result-"+b.dataset.adminResult);out.textContent="Loading…";try{const r=await call("getLeaderboard",{id:b.dataset.adminResult});out.innerHTML=r.rows.length?"<ol>"+r.rows.map(x=>"<li>"+esc(x.name)+" — "+x.score+"/"+x.total+(x.pendingReview?" • Subjective pending":"")+"</li>").join("")+"</ol>":"<p>अभी कोई submitted result नहीं है।</p>"}catch(e){out.textContent=e.message}});
}

async function aiQuestionBankPage(){
  if(role!=="admin"&&role!=="superadmin")return;
  panel("AI Question Generator",'<button class="text-button" id="aiBack">← Admin Dashboard</button><div class="dashboard-hero"><span class="eyebrow">EDUFUTURE • GEMINI AI</span><h2>AI से प्रश्न बनाएं</h2><p>AI के बनाए प्रश्न पहले Pending में आएँगे। जाँच और Approve करने के बाद ही वे Question Bank में जुड़ेंगे।</p></div><section class="item"><div class="builder-meta-grid"><div><label>Class</label><input id="aiClass" placeholder="जैसे Class 10"></div><div><label>Subject</label><input id="aiSubject" placeholder="जैसे Science"></div><div><label>Chapter / Topic</label><input id="aiTopic" placeholder="जैसे प्रकाश और परावर्तन"></div><div><label>Question Type</label><select id="aiType"><option value="objective">MCQ</option><option value="subjective">Subjective</option></select></div><div><label>Difficulty</label><select id="aiDifficulty"><option value="easy">Easy</option><option value="medium" selected>Medium</option><option value="hard">Hard</option></select></div><div><label>Number of Questions (10–100)</label><input id="aiCount" type="number" min="10" max="100" step="10" value="10"></div></div><button id="aiGenerate" class="success-action">✦ Generate Questions</button><span id="aiStatus" class="hint"></span></section><h3>Pending Review</h3><div id="aiPending">Loading pending questions…</div><h3>Approved Question Bank</h3><section class="item"><h4>Publish Selected Questions</h4><p class="hint">Approved प्रश्न चुनें और Quiz की जानकारी व Publish Topic भरें।</p><label>Quiz Title</label><input id="bankPublishTitle" placeholder="विज्ञान अभ्यास टेस्ट"><label>Class</label><input id="bankPublishClass" placeholder="Class 10 या All"><label>Subject</label><input id="bankPublishSubject" placeholder="Science"><label>Publish Topic / Chapter</label><input id="bankPublishTopic" placeholder="प्रकाश और परावर्तन"><label>Duration (minutes)</label><input id="bankPublishDuration" type="number" min="1" max="600" value="30"><button id="bankPublish" class="success-action">Publish Selected as Quiz</button><span id="bankPublishStatus" class="hint"></span></section><div id="aiApproved">Loading approved questions…</div>');
  $("aiBack").onclick=()=>{tab="admin";render()};
  async function loadLists(){
    const [pendingResult,approvedResult]=await Promise.allSettled([call("listQuestionDrafts"),call("listQuestionBank")]);
    const pending=pendingResult.status==="fulfilled"?pendingResult.value:null;
    const approved=approvedResult.status==="fulfilled"?approvedResult.value:null;
    const pendingHtml=pendingResult.status==="fulfilled"
      ? ((pending.drafts||[]).filter(x=>x.status==="pending").map(q=>{
          const id=esc(q.id),mcq=q.type==="objective";
          return '<article class="item"><div class="question-meta"><span>'+esc(q.className)+'</span><span>'+esc(q.subject)+'</span><span>'+esc(q.difficulty)+'</span></div><p class="hint">'+esc(q.topic)+' • '+(mcq?"MCQ":"Subjective")+'</p><label>Question (review/edit)</label><textarea rows="3" data-ai-text="'+id+'">'+esc(q.text)+'</textarea>'+
            (mcq?'<label>Options (one per line)</label><textarea rows="4" data-ai-options="'+id+'">'+esc((q.options||[]).join("\n"))+'</textarea><label>Correct Option</label><select data-ai-answer="'+id+'">'+(q.options||[]).map((v,k)=>'<option value="'+k+'" '+(Number(q.answer)===k?"selected":"")+'>'+String.fromCharCode(65+k)+' — '+esc(v)+'</option>').join("")+'</select>':'<label>Model Answer (review/edit)</label><textarea rows="3" data-ai-model="'+id+'">'+esc(q.modelAnswer||"")+'</textarea>')+
            '<label>Explanation (optional)</label><textarea rows="2" data-ai-explanation="'+id+'">'+esc(q.explanation||"")+'</textarea><div class="overview-actions"><button data-ai-approve="'+id+'">Approve to Question Bank</button><button class="secondary" data-ai-reject="'+id+'">Reject</button></div></article>';
        }).join("")||'<div class="empty-state">अभी कोई Pending AI प्रश्न नहीं है।</div>')
      : '<div class="error">Pending Draft लोड नहीं हुए: '+esc(pendingResult.reason?.message||"अज्ञात त्रुटि")+'</div>';
    const approvedHtml=approvedResult.status==="fulfilled"
      ? ((approved.questions||[]).map(q=>'<article class="item ai-approved-card" data-bank-card="'+esc(q.id)+'"><label class="question-meta"><input type="checkbox" data-bank-select="'+esc(q.id)+'"> चुनें • '+esc(q.className)+' • '+esc(q.subject)+' • '+esc(q.difficulty)+'</label><label>Topic</label><input data-bank-topic value="'+esc(q.topic||"")+'"><label>Question (Edit)</label><textarea rows="3" data-bank-text>'+esc(q.text)+'</textarea>'+(q.type==="objective"?'<label>Options (one per line)</label><textarea rows="4" data-bank-options>'+esc((q.options||[]).join("\n"))+'</textarea><label>Correct Option</label><select data-bank-answer>'+(q.options||[]).map((v,k)=>'<option value="'+k+'" '+(Number(q.answer)===k?"selected":"")+'>'+String.fromCharCode(65+k)+' — '+esc(v)+'</option>').join("")+'</select>':'<label>Model Answer</label><textarea rows="3" data-bank-model>'+esc(q.modelAnswer||"")+'</textarea>')+'<label>Explanation</label><textarea rows="2" data-bank-explanation>'+esc(q.explanation||"")+'</textarea><div class="overview-actions"><button data-bank-save="'+esc(q.id)+'">Save Edit</button></div></article>').join("")||'<div class="empty-state">अभी Question Bank में कोई approved प्रश्न नहीं है।</div>')
      : '<div class="error">Question Bank लोड नहीं हुआ: '+esc(approvedResult.reason?.message||"अज्ञात त्रुटि")+'</div>';
    $("aiPending").innerHTML=pendingHtml;
    $("aiApproved").innerHTML=approvedHtml;
    $("aiApproved").querySelectorAll("[data-bank-save]").forEach(b=>b.onclick=async()=>{
      const card=b.closest("[data-bank-card]");
      try{const of=card.querySelector("[data-bank-options]"),question={text:card.querySelector("[data-bank-text]").value,topic:card.querySelector("[data-bank-topic]").value,explanation:card.querySelector("[data-bank-explanation]").value};
        if(of){question.options=of.value.split("\\n").map(x=>x.trim()).filter(Boolean);question.answer=Number(card.querySelector("[data-bank-answer]").value)}else question.modelAnswer=card.querySelector("[data-bank-model]").value;
        b.disabled=true;await call("updateQuestionBankQuestion",{id:b.dataset.bankSave,question});alertMsg("Approved प्रश्न अपडेट हो गया।");await loadLists();
      }catch(e){b.disabled=false;alertMsg(e.message)}
    });
    $("bankPublish").onclick=async()=>{
      const selected=[...$("aiApproved").querySelectorAll("[data-bank-select]:checked")],status=$("bankPublishStatus"),button=$("bankPublish");
      if(!selected.length){alertMsg("पहले प्रश्न चुनें।");return}
      const title=$("bankPublishTitle").value.trim(),className=$("bankPublishClass").value.trim(),subject=$("bankPublishSubject").value.trim(),topic=$("bankPublishTopic").value.trim(),duration=Number($("bankPublishDuration").value);
      if(!title||!className||!subject||!topic){alertMsg("Quiz Title, Class, Subject और Topic भरें।");return}
      if(!Number.isInteger(duration)||duration<1||duration>600){alertMsg("Duration 1 से 600 मिनट रखें।");return}
      const questions=selected.map(box=>{const card=box.closest("[data-bank-card]"),of=card.querySelector("[data-bank-options]");
        return {text:card.querySelector("[data-bank-text]").value.trim(),type:of?"objective":"subjective",options:of?of.value.split("\\n").map(x=>x.trim()).filter(Boolean):[],answer:of?Number(card.querySelector("[data-bank-answer]").value):null,modelAnswer:card.querySelector("[data-bank-model]")?.value||"",explanation:card.querySelector("[data-bank-explanation]").value,topic,marks:1};});
      button.disabled=true;status.textContent="Quiz publish हो रहा है…";
      try{const r=await call("saveQuiz",{title,className,subject,topic,duration,questions,quizType:questions.every(q=>q.type==="objective")?"objective":questions.every(q=>q.type==="subjective")?"subjective":"mixed",publish:true});status.textContent="Quiz publish हो गया • "+r.questionCount+" प्रश्न";alertMsg("Quiz विद्यार्थियों के लिए publish हो गया।")}
      catch(e){status.textContent=e.message;alertMsg(e.message)}finally{button.disabled=false}
    };
    $("view").querySelectorAll("[data-ai-approve]").forEach(b=>b.onclick=async()=>{
      const id=b.dataset.aiApprove;
      try{
        const question={text:$("view").querySelector('[data-ai-text="'+id+'"]').value,explanation:$("view").querySelector('[data-ai-explanation="'+id+'"]').value};
        const card=b.closest(".item");
        const optionsField=card.querySelector("[data-ai-options]");
        if(optionsField){question.options=optionsField.value.split("\n").map(x=>x.trim()).filter(Boolean);question.answer=Number(card.querySelector("[data-ai-answer]").value)}
        else question.modelAnswer=card.querySelector("[data-ai-model]").value;
        b.disabled=true;
        await call("reviewQuestionDraft",{id,decision:"approve",question});
        alertMsg("प्रश्न जाँचकर Question Bank में जोड़ दिया गया।");
        await loadLists();
      }catch(e){b.disabled=false;alertMsg(e.message)}
    });
    $("view").querySelectorAll("[data-ai-reject]").forEach(b=>b.onclick=async()=>{
      if(!window.confirm("क्या इस AI प्रश्न को Reject करना है?"))return;
      try{await call("reviewQuestionDraft",{id:b.dataset.aiReject,decision:"reject"});await loadLists()}catch(e){alertMsg(e.message)}
    });
  }
  $("aiGenerate").onclick=async()=>{
    const button=$("aiGenerate"),status=$("aiStatus");
    const count=Number($("aiCount").value);
    if(!Number.isInteger(count)||count<10||count>100){alertMsg("10 से 100 प्रश्न चुनें।");return}
    button.disabled=true;
    const startedAt=Date.now();
    status.textContent="Gemini AI प्रश्न तैयार कर रहा है… 0 सेकंड";
    const progressTimer=setInterval(()=>{
      status.textContent="Gemini AI प्रश्न तैयार कर रहा है… "+Math.floor((Date.now()-startedAt)/1000)+" सेकंड";
    },1000);
    try{
      const result=await call("generateQuestionDraft",{className:$("aiClass").value.trim(),subject:$("aiSubject").value.trim(),topic:$("aiTopic").value.trim(),type:$("aiType").value,difficulty:$("aiDifficulty").value,count});
      status.textContent=(result.drafts?.length||0)+" प्रश्न Pending Review में आ गए।";
      await loadLists();
    }catch(e){status.textContent=e.message||"प्रश्न नहीं बन सके। कृपया फिर कोशिश करें।"}
    finally{clearInterval(progressTimer);button.disabled=false}
  };
  await loadLists()
}
async function createQuizPage(){
  if(role!=="admin"&&role!=="superadmin")return;
  let step=1,quizType="",questions=[];
  const meta={className:"",subject:"",topic:"",duration:30};
  const blank=()=>({text:"",type:"",options:["","","",""],answer:null,marks:1,modelAnswer:"",difficulty:"medium",explanation:""});
  const shell=(content)=>panel("Create Quiz",'<div class="quiz-wizard"><div class="wizard-progress"><span class="'+(step>=1?"done":"")+'">1. विषय</span><i></i><span class="'+(step>=2?"done":"")+'">2. प्रकार</span><i></i><span class="'+(step>=3?"done":"")+'">3. प्रश्न</span></div>'+content+'</div>');
  function draw(){
    if(step===1){
      shell('<div class="wizard-heading"><span class="eyebrow">STEP 1 OF 3</span><h2>Quiz की जानकारी भरें</h2><p>कक्षा, विषय और अध्याय चुनें।</p></div><section class="item wizard-form"><label>कक्षा</label><input id="quizClass" value="'+esc(meta.className)+'" placeholder="जैसे Class 10"><label>विषय</label><input id="quizSubject" value="'+esc(meta.subject)+'" placeholder="जैसे Science"><label>Topic / Chapter</label><input id="quizTopic" value="'+esc(meta.topic)+'" placeholder="जैसे प्रकाश और परावर्तन"><label>समय सीमा (मिनट)</label><input id="quizDuration" type="number" min="1" max="600" value="'+Number(meta.duration)+'"><button id="quizStep1Next" class="success-action">आगे बढ़ें →</button></section>');
      $("quizStep1Next").onclick=()=>{
        meta.className=$("quizClass").value.trim();meta.subject=$("quizSubject").value.trim();meta.topic=$("quizTopic").value.trim();meta.duration=Number($("quizDuration").value);
        if(!meta.className||!meta.subject||!meta.topic) return alertMsg("कक्षा, विषय और Topic भरना जरूरी है।");
        if(!Number.isInteger(meta.duration)||meta.duration<1||meta.duration>600)return alertMsg("समय 1 से 600 मिनट के बीच रखें।");
        step=2;draw();
      };
    }else if(step===2){
      shell('<div class="wizard-heading"><span class="eyebrow">STEP 2 OF 3</span><h2>प्रश्नों का प्रकार चुनें</h2><p>इस Quiz में किस प्रकार के प्रश्न होंगे?</p></div><div class="quiz-choice-grid"><button class="quiz-choice-card objective-choice" data-kind="objective"><span class="choice-icon">✓</span><b>Objective</b><small>चार विकल्प और सही उत्तर चुनें</small><span class="choice-link">Objective चुनें</span></button><button class="quiz-choice-card subjective-choice" data-kind="subjective"><span class="choice-icon">✎</span><b>Subjective</b><small>लिखित उत्तर और Teacher checking</small><span class="choice-link">Subjective चुनें</span></button></div><div class="wizard-actions"><button id="quizStep2Back" class="secondary">← पीछे</button><span class="hint">'+esc(meta.className)+' • '+esc(meta.subject)+' • '+esc(meta.topic)+'</span></div>');
      $("quizStep2Back").onclick=()=>{step=1;draw()};
      $("view").querySelectorAll("[data-kind]").forEach(b=>b.onclick=()=>{quizType=b.dataset.kind;questions=[blank()];step=3;draw()});
    }else{
      const objective=quizType==="objective";
      const questionCards=questions.map((q,i)=>{
        const answerFields=objective?'<div class="mcq-option-grid">'+q.options.map((v,j)=>'<label class="mcq-option"><span class="option-letter">'+String.fromCharCode(65+j)+'</span><input data-option="'+i+'" data-option-index="'+j+'" value="'+esc(v)+'" placeholder="विकल्प '+String.fromCharCode(65+j)+'"><input class="correct-radio" type="radio" name="correct-'+i+'" data-answer="'+i+'" value="'+j+'" '+(q.answer===j?"checked":"")+' aria-label="सही उत्तर चुनें"></label>').join("")+'</div><p class="hint">सही विकल्प के सामने गोल बटन चुनें।</p>':'<label>Model Answer (वैकल्पिक)</label><textarea rows="3" data-model="'+i+'" placeholder="Teacher के लिए reference answer">'+esc(q.modelAnswer)+'</textarea>';
        return '<article class="question builder-question"><div class="question-head"><h3>प्रश्न '+(i+1)+'</h3>'+(questions.length>1?'<button type="button" class="danger" data-remove="'+i+'">हटाएँ</button>':'')+'</div><label>प्रश्न लिखें</label><textarea rows="3" data-question="'+i+'" placeholder="पूरा प्रश्न यहाँ लिखें">'+esc(q.text)+'</textarea>'+answerFields+'<div class="builder-marks"><label>अंक</label><input type="number" min="1" max="100" data-marks="'+i+'" value="'+Number(q.marks||1)+'"></div></article>';
      }).join("");
      shell('<div class="wizard-heading"><span class="eyebrow">STEP 3 OF 3</span><h2>'+ (objective?"Objective":"Subjective") +' प्रश्न जोड़ें</h2><p>'+esc(meta.className)+' • '+esc(meta.subject)+' • '+esc(meta.topic)+' • '+Number(meta.duration)+' मिनट</p></div><div class="question-stack">'+questionCards+'</div><div class="question-add-area"><button id="addQuestion" class="secondary">＋ Add Question</button><p class="hint">हर प्रश्न भरने के बाद नीचे Add Question दबाएँ। सभी प्रश्न जुड़ने के बाद Publish करें।</p></div><div class="wizard-actions"><button id="quizStep3Back" class="secondary">← पीछे</button><button id="publishQuiz" class="success-action">Publish Quiz</button></div><p class="hint" id="publishStatus" role="status"></p>');
      $("quizStep3Back").onclick=()=>{step=2;draw()};
      $("view").querySelectorAll("[data-question]").forEach(x=>x.oninput=()=>questions[Number(x.dataset.question)].text=x.value);
      $("view").querySelectorAll("[data-option]").forEach(x=>x.oninput=()=>questions[Number(x.dataset.option)].options[Number(x.dataset.optionIndex)]=x.value);
      $("view").querySelectorAll("[data-answer]").forEach(x=>x.onchange=()=>questions[Number(x.dataset.answer)].answer=Number(x.value));
      $("view").querySelectorAll("[data-model]").forEach(x=>x.oninput=()=>questions[Number(x.dataset.model)].modelAnswer=x.value);
      $("view").querySelectorAll("[data-marks]").forEach(x=>x.onchange=()=>questions[Number(x.dataset.marks)].marks=Number(x.value));
      $("view").querySelectorAll("[data-remove]").forEach(x=>x.onclick=()=>{questions.splice(Number(x.dataset.remove),1);if(!questions.length)questions=[blank()];draw()});
      $("addQuestion").onclick=()=>{if(questions.length>=2000)return alertMsg("एक Quiz में अधिकतम 2000 प्रश्न जोड़ सकते हैं।");questions.push(blank());draw();$("view").querySelector(".question-stack .builder-question:last-child")?.scrollIntoView({behavior:"smooth",block:"start"})};
      $("publishQuiz").onclick=async()=>{
        const button=$("publishQuiz"),status=$("publishStatus");
        try{
          const cleaned=questions.map((q,i)=>{
            if(!q.text.trim())throw new Error("प्रश्न "+(i+1)+" खाली है।");
            if(!Number.isInteger(Number(q.marks))||Number(q.marks)<1||Number(q.marks)>100)throw new Error("प्रश्न "+(i+1)+" के अंक जाँचें।");
            if(objective&&(q.options.length!==4||q.options.some(v=>!String(v).trim())))throw new Error("प्रश्न "+(i+1)+" के चारों विकल्प भरें।");
            if(objective&&(!Number.isInteger(q.answer)||q.answer<0||q.answer>3))throw new Error("प्रश्न "+(i+1)+" का सही उत्तर चुनें।");
            return {...q,type:quizType,options:objective?q.options:[],answer:objective?q.answer:null,marks:Number(q.marks)};
          });
          if(!cleaned.length)throw new Error("कम-से-कम एक प्रश्न जोड़ें।");
          if(!window.confirm("क्या आप "+cleaned.length+" प्रश्नों वाला यह Quiz Publish करना चाहते हैं?"))return;
          if(!window.confirm("अंतिम पुष्टि: Publish होने के बाद विद्यार्थी इसे देख और निर्धारित समय में Attempt कर सकेंगे। क्या आप निश्चित हैं?"))return;
          button.disabled=true;status.textContent="Quiz सुरक्षित रूप से publish हो रहा है…";
          const result=await call("saveQuiz",{title:meta.topic+" - "+(objective?"Objective":"Subjective")+" Quiz",className:meta.className,subject:meta.subject,topic:meta.topic,duration:meta.duration,questions:cleaned,quizType,publish:true});
          alertMsg("Quiz Publish हो गया। "+result.questionCount+" प्रश्न • कुल "+result.totalMarks+" अंक");
          tab="admin";render();
        }catch(e){status.textContent=e.message;button.disabled=false}
      };
    }
  }
  draw();
}
async function quizBuilderPage(mode){
  if(role!=="admin"&&role!=="superadmin")return;
  const isObjective=mode==="objective",kind=isObjective?"Objective":"Subjective";
  panel(kind+" Quiz Builder",'<button class="text-button" id="backQuizChoice">← Quiz Type चुनें</button><div class="builder-heading"><span class="eyebrow">EDUFUTURE • '+kind.toUpperCase()+' BUILDER</span><h2>'+kind+' Quiz बनाएं</h2><p>Subject, Topic और Timer भरें। प्रश्न नीचे जोड़ें या CSV से import करें।</p></div><div class="builder-meta-grid"><div><label for="builderSubject">Subject</label><input id="builderSubject" placeholder="जैसे: Science"></div><div><label for="builderTopic">Topic / Chapter</label><input id="builderTopic" placeholder="जैसे: प्रकाश और परावर्तन"></div><div><label for="builderDuration">Time Limit (minutes)</label><input id="builderDuration" type="number" min="1" max="600" value="30"></div></div><details class="bulk-import-box"><summary><b>वैकल्पिक: CSV से Bulk Import</b></summary><p class="hint">यह advanced विकल्प है। CSV को Excel या Google Sheets में तैयार करके यहाँ import करें। Objective columns: question, optionA, optionB, optionC, optionD, answer, marks.</p><input id="builderCsvFile" type="file" accept=".csv,text/csv"><textarea id="builderCsvText" rows="3" placeholder="या CSV content यहाँ paste करें…"></textarea><button id="builderImport" class="secondary">Import CSV</button> <span id="builderImportStatus" class="hint"></span></details><div class="question-toolbar"><div><b>Questions</b><span id="questionCount" class="question-count"></span></div><button id="builderAddQuestion">＋ Add Question</button></div><div id="builderQuestions"></div><div class="question-pagination"><button id="questionPrev" class="secondary">← Previous</button><span id="questionPageLabel">Page 1</span><button id="questionNext" class="secondary">Next →</button></div><div class="publish-row"><button id="publishQuiz" class="success-action">Publish '+kind+' Quiz</button></div>');
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
      const subject=$("builderSubject").value.trim(),topic=$("builderTopic").value.trim(),duration=Number($("builderDuration").value);
      if(!subject)throw Error("Subject लिखना जरूरी है।");if(!topic)throw Error("Topic लिखना जरूरी है।");if(!Number.isInteger(duration)||duration<1||duration>600)throw Error("Timer 1 से 600 मिनट के बीच रखें।");
      if(!questions.length||questions.length>2000)throw Error("1 से 2000 प्रश्न रखें।");
      const cleaned=questions.map((q,i)=>{
        if(!q.text.trim())throw Error("Question "+(i+1)+" का प्रश्न खाली है।");
        if(!Number.isFinite(Number(q.marks))||Number(q.marks)<1||Number(q.marks)>100)throw Error("Question "+(i+1)+" के marks जाँचें।");
        if(isObjective&&(q.options.length!==4||q.options.some(v=>!String(v).trim())))throw Error("Question "+(i+1)+" के चारों options भरें।");
        if(isObjective&&(!Number.isInteger(q.answer)||q.answer<0||q.answer>3))throw Error("Question "+(i+1)+" का सही उत्तर चुनें।");
        return {...q,type:mode,options:isObjective?q.options:[],answer:isObjective?q.answer:null,marks:Number(q.marks)};
      });
      const r=await call("saveQuiz",{title:topic+" - "+kind+" Quiz",subject,topic,duration,questions:cleaned,quizType:mode,publish:true});
      alertMsg(kind+" Quiz publish हो गया। "+r.questionCount+" प्रश्न • कुल "+r.totalMarks+" अंक");tab="admin";render();
    }catch(err){alertMsg(err.message)}finally{button.disabled=false}
  };
  draw();
}

async function importantNoticesPage(){
  const canPost=["teacher","admin","superadmin"].includes(role);
  panel("Important Notice",'<div class="builder-heading"><span class="eyebrow">EDUFUTURE • SCHOOL UPDATES</span><h2>Important Notice</h2><p>परीक्षा, Admit Card और जरूरी निर्देश। पुराने Notice 30 दिन बाद सूची से छिप जाते हैं। Delete करने पर Storage media भी हटेगा।</p></div>'+
    (canPost?'<section class="item"><h3>नया Notice बनाएँ</h3><label>शीर्षक (वैकल्पिक)</label><input id="noticeTitle" maxlength="140" placeholder="जैसे: वार्षिक परीक्षा सूचना"><label>जानकारी / निर्देश</label><textarea id="noticeBody" rows="4" maxlength="5000" placeholder="Notice की जानकारी लिखें…"></textarea><label>Photo या Video (अधिकतम 50 MB)</label><input id="noticeMedia" type="file" accept="image/*,video/mp4,video/webm,video/quicktime"><p class="hint">मोबाइल पर Gallery या उपलब्ध media picker खुलेगा। Text, photo, video या combination भेजें।</p><button id="publishNotice" class="success-action">Publish Notice</button><span id="noticeStatus" class="hint"></span></section>':'')+'<div id="noticeList">Notices लोड हो रहे हैं…</div>');
  async function refresh(){
    const out=$("noticeList");
    try{
      const items=(await call("listNotices")).notices||[];
      out.innerHTML=items.length?items.map(n=>'<article class="item notice-card"><div class="question-meta"><span>IMPORTANT NOTICE</span><span>'+dateText(n.createdAt)+'</span></div>'+(n.title?'<h3>'+esc(n.title)+'</h3>':'')+(n.body?'<p style="white-space:pre-wrap">'+esc(n.body)+'</p>':'')+(n.mediaUrl?(n.mediaType==="video"?'<video controls playsinline preload="metadata" style="max-width:100%;border-radius:12px"><source src="'+esc(n.mediaUrl)+'"></video>':'<img loading="lazy" src="'+esc(n.mediaUrl)+'" alt="Notice photo" style="max-width:100%;height:auto;border-radius:12px">'):'')+(n.canDelete?'<button class="danger" data-delete-notice="'+esc(n.id)+'">Delete Notice</button>':'')+'</article>').join(""):'<div class="empty-state"><b>अभी कोई Important Notice नहीं है।</b></div>';
      out.querySelectorAll("[data-delete-notice]").forEach(b=>b.onclick=async()=>{if(!confirm("क्या Notice और उसकी photo/video स्थायी रूप से हटानी है?"))return;try{b.disabled=true;await call("deleteNotice",{id:b.dataset.deleteNotice});await refresh()}catch(e){b.disabled=false;alertMsg(e.message)}});
    }catch(e){out.textContent=e.message}
  }
  if(canPost)$("publishNotice").onclick=async()=>{
    const b=$("publishNotice"),file=$("noticeMedia").files[0],id=doc(collection(db,"notices")).id;b.disabled=true;$("noticeStatus").textContent="Publish हो रहा है…";
    try{
      const title=$("noticeTitle").value.trim(),body=$("noticeBody").value.trim();
      if(!title&&!body&&!file)throw Error("Text, photo या video जोड़ें।");
      if(file&&file.size>50*1024*1024)throw Error("Media 50 MB से छोटी होनी चाहिए।");
      let mediaPath="",mediaType="";
      if(file){const up=await uploadNoticeFile(id,file);mediaPath=up.storagePath;mediaType=up.mediaType}
      await call("createNotice",{id,title,body,mediaPath,mediaType});
      $("noticeTitle").value="";$("noticeBody").value="";$("noticeMedia").value="";$("noticeStatus").textContent="Notice publish हो गया।";await refresh();
    }catch(e){$("noticeStatus").textContent=e.message;alertMsg(e.message)}finally{b.disabled=false}
  };
  await refresh();
}

async function contentUploadPage(kind){
  if(role!=="admin"&&role!=="superadmin")return;
  const isPyq=kind==="pyq",prefix=isPyq?"pyq":"note",title=isPyq?"PYQ":"Notes";
  panel("Upload "+title,'<button class="text-button" id="backContent">← Admin Dashboard</button><div class="builder-heading"><span class="eyebrow">EDUFUTURE • CONTENT LIBRARY</span><h2>'+title+' Upload</h2><p>एक बार में कई PDF / documents चुनें। हर फ़ाइल अलग item बनेगी।</p></div><label>'+title+' Title (एकाधिक फ़ाइलों के लिए आधार नाम)</label><input id="'+prefix+'Title" placeholder="'+title+' title"><label>Subject</label><input id="'+prefix+'Subject" placeholder="जैसे Science"><label>Description</label><textarea id="'+prefix+'Description" rows="3"></textarea><label>एक या अधिक PDF / DOC / PPT / Image (प्रति फ़ाइल अधिकतम 30 MB)</label><input id="'+prefix+'File" type="file" multiple accept=".pdf,.doc,.docx,.ppt,.pptx,.png,.jpg,.jpeg,.webp"><label>या एक Hosted File URL</label><input id="'+prefix+'Url" type="url" placeholder="https://..."><p id="'+prefix+'Status" class="hint">एकाधिक फ़ाइलें चुन सकते हैं।</p><button id="'+prefix+'Save" class="success-action">Upload '+title+'</button><section class="item"><h3>Manage '+title+'</h3><div id="'+prefix+'List">Loading…</div></section>');
  $("backContent").onclick=()=>{tab="admin";render()};
  async function refresh(){
    try{
      const snap=await getDocs(collection(db,"content")),items=snap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.type===kind);
      $(prefix+"List").innerHTML=items.length?items.map(x=>'<div class="admin-row"><span>'+esc(x.title)+' • '+(x.published?"Published":"Hidden")+'</span><div><button data-toggle-content="'+esc(x.id)+'" data-next="'+(!x.published)+'">'+(x.published?"Hide":"Publish")+'</button> <button class="danger" data-delete-content="'+esc(x.id)+'">Delete</button></div></div>').join(""):'<p>अभी कोई '+title+' नहीं है।</p>';
      $(prefix+"List").querySelectorAll("[data-toggle-content]").forEach(b=>b.onclick=async()=>{try{await call("setContentPublished",{id:b.dataset.toggleContent,published:b.dataset.next==="true"});await refresh()}catch(e){alertMsg(e.message)}});
      $(prefix+"List").querySelectorAll("[data-delete-content]").forEach(b=>b.onclick=async()=>{if(!confirm("यह सामग्री और Supabase Storage की असली फ़ाइल स्थायी रूप से हटेगी। जारी रखें?"))return;try{b.disabled=true;await call("deleteContent",{id:b.dataset.deleteContent});await refresh()}catch(e){b.disabled=false;alertMsg(e.message)}});
    }catch(e){$(prefix+"List").textContent=e.message}
  }
  $(prefix+"Save").onclick=async()=>{
    const b=$(prefix+"Save"),files=Array.from($(prefix+"File").files||[]),url=$(prefix+"Url").value.trim();b.disabled=true;
    try{
      const base=$(prefix+"Title").value.trim(),subject=$(prefix+"Subject").value.trim();
      if(!base||!subject)throw Error("Title और Subject भरना जरूरी है।");
      if(files.length&&url)throw Error("एक साथ files और Hosted URL न दें।");
      if(!files.length&&!url)throw Error("कम-से-कम एक फ़ाइल या Hosted URL चुनें।");
      if(files.length>20)throw Error("एक बार में अधिकतम 20 फ़ाइलें upload करें।");
      const allowed=/\.(pdf|doc|docx|ppt|pptx|png|jpe?g|webp)$/i;
      for(const f of files){if(f.size>30*1024*1024)throw Error(f.name+" 30 MB से बड़ी है।");if(!allowed.test(f.name))throw Error(f.name+" का file type supported नहीं है।")}
      if(!files.length){const id=doc(collection(db,"content")).id;await call("addContent",{id,title:base,subject,type:kind,description:$(prefix+"Description").value,url,published:true})}
      else{
        for(let i=0;i<files.length;i++){
          const file=files[i],id=doc(collection(db,"content")).id;
          $(prefix+"Status").textContent="Upload "+(i+1)+"/"+files.length+": "+file.name;
          const uploaded=await uploadContentFile(id,file),fileTitle=files.length===1?base:base+" - "+file.name.replace(/\.[^.]+$/,"");
          await call("addContent",{id,storagePath:uploaded.storagePath,title:fileTitle,subject,type:kind,description:$(prefix+"Description").value,url:"",published:true});
        }
      }
      alertMsg(files.length?files.length+" "+title+" files upload हो गईं।":title+" link publish हो गया।");
      $(prefix+"Title").value="";$(prefix+"Subject").value="";$(prefix+"Description").value="";$(prefix+"Url").value="";$(prefix+"File").value="";$(prefix+"Status").textContent="Upload पूरा हुआ।";await refresh();
    }catch(e){$(prefix+"Status").textContent=e.message;alertMsg(e.message)}finally{b.disabled=false}
  };
  refresh();
}
async function superPage(){
  if(role!=="superadmin")return;
  panel("Super Admin Controls",'<div class="item"><h3>Create Admin</h3><p class="hint">Admin का account पहले से बना होना चाहिए।</p><input id="adminEmail" type="email" placeholder="Registered admin email"><button id="createAdmin">Create Admin</button></div><div class="item"><h3>Manage All Admins</h3><button id="refreshAdmins">Refresh List</button><div id="adminList"></div></div>');
  async function load(){try{const r=await call("listAdmins");$("adminList").innerHTML=r.admins.map(a=>'<div class="admin-row"><span>'+esc(a.displayName||a.email||a.uid)+' — '+esc(a.role)+'</span>'+(a.role==="admin"?'<button class="danger" data-remove="'+a.uid+'">Remove Admin</button>':"")+"</div>").join("")||"<p>कोई Admin नहीं है।</p>";$("adminList").querySelectorAll("[data-remove]").forEach(b=>b.onclick=async()=>{if(!confirm("क्या इस Admin की भूमिका Student करनी है?"))return;try{await call("removeAdmin",{uid:b.dataset.remove});alertMsg("Admin role हटा दी गई।");load()}catch(e){alertMsg(e.message)}})}catch(e){$("adminList").textContent=e.message}}
  $("createAdmin").onclick=async()=>{try{await call("addAdmin",{email:$("adminEmail").value.trim()});alertMsg("Admin बना दिया गया।");$("adminEmail").value="";load()}catch(e){alertMsg(e.message)}};
  $("refreshAdmins").onclick=load;load();
}
