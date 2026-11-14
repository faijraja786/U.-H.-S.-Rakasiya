import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { API_BASE } from "./firebase-config.js";

const auth=getAuth(),db=getFirestore();
const $=id=>document.getElementById(id);
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
async function api(name,data={}){
 const user=auth.currentUser;if(!user)throw Error("कृपया पहले login करें।");
 const token=await user.getIdToken();
 const response=await fetch(API_BASE.replace(/\/+$/,"")+"/api/"+encodeURIComponent(name),{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+token},body:JSON.stringify({data})});
 const payload=await response.json().catch(()=>({}));
 if(!response.ok)throw Error(payload.error?.message||"Server से संपर्क नहीं हो सका।");
 return payload.data;
}
function ensureMathJax(target){
 if(!window.MathJax){
  window.MathJax={tex:{inlineMath:[["\\\\(","\\\\)"]],displayMath:[["\\\\[","\\\\]"]]},options:{skipHtmlTags:["script","noscript","style","textarea","pre","code"]}};
  const script=document.createElement("script");script.src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js";script.async=true;document.head.appendChild(script);
  script.addEventListener("load",()=>window.MathJax.typesetPromise?.([target]).catch(()=>{}),{once:true});
 }else if(window.MathJax.typesetPromise)window.MathJax.typesetPromise([target]).catch(()=>{});
}
window.renderEduMath=ensureMathJax;
function page(title,body){$("view").innerHTML='<section class="panel"><h2>'+esc(title)+'</h2>'+body+'</section>';}
function status(id,text,isError=false){const el=$(id);if(el){el.textContent=text;el.className=isError?"error":"hint";}}
function markdownHtml(source){
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
function openPdf(title,meta,content){
 const w=window.open("","_blank");if(!w){throw Error("PDF Print window खुल नहीं सकी। Browser में Pop-ups allow करें।");}
 w.document.open();w.document.write('<!doctype html><html lang="hi"><head><meta charset="utf-8"><title>'+esc(title)+'</title><style>@page{size:A4;margin:18mm}body{font-family:Arial,"Noto Sans Devanagari",sans-serif;color:#172033;line-height:1.65;font-size:12pt}h1{font-size:22pt;color:#163a70;margin-bottom:4px}h2{font-size:16pt;color:#204d82;border-bottom:1px solid #dbe4ef;padding-bottom:4px;margin-top:22px}h3{font-size:13pt;color:#204d82;margin-top:16px}.meta{color:#53657d;border-bottom:2px solid #dbe4ef;padding-bottom:12px;margin-bottom:20px}.pdf-bullet{margin:4px 0 4px 16px}.pdf-gap{height:6px}.footer{margin-top:28px;padding-top:8px;border-top:1px solid #ddd;color:#667;font-size:9pt}@media print{button{display:none}}</style></head><body><h1>'+esc(title)+'</h1><div class="meta">'+esc(meta)+'</div>'+markdownHtml(content)+'<div class="footer">EduFuture • U.H.S. Rakasiya • AI-assisted study material — शिक्षक/विद्यार्थी उपयोग से पहले तथ्य जाँच लें।</div><script>window.onload=()=>setTimeout(()=>window.print(),400)<\/script></body></html>');
 w.document.close();
}
window.aiChatPage=async function(){
 const snap=await getDoc(doc(db,"roles",auth.currentUser.uid)),profile=snap.exists()?snap.data():{};
 const classValue=String(profile.className||""),storageKey="edufuture-ai-chat-"+auth.currentUser.uid;
 let chats=[];try{chats=JSON.parse(localStorage.getItem(storageKey)||"[]");if(!Array.isArray(chats))chats=[];}catch{chats=[];}
 let activeId=chats[0]?.id||null;
 const save=()=>{try{localStorage.setItem(storageKey,JSON.stringify(chats.slice(0,40)));}catch{}};
 const newId=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,7);
 page("AI Study Chat",'<div class="ai-workspace"><aside class="ai-history"><div class="ai-history-head"><b>आपकी बातचीत</b><button id="newTutorChat" class="secondary" type="button">＋ नई Chat</button></div><div id="tutorHistoryList"></div></aside><section class="ai-chat-shell"><header class="ai-chat-header"><div class="ai-avatar">✦</div><div><b>EduFuture AI Tutor</b><small>कक्षा '+esc(classValue||"—")+' • Study Assistant</small></div><span class="ai-online">● Online</span></header><div class="ai-class-strip"><label for="tutorClass">कक्षा</label><select id="tutorClass"><option value="'+esc(classValue)+'">'+esc(classValue||"कक्षा चुनें")+'</option></select><span>केवल पढ़ाई से जुड़े सवाल</span></div><div id="tutorChat" class="tutor-chat" aria-live="polite"></div><div class="ai-composer"><textarea id="tutorQuestion" rows="1" maxlength="3000" placeholder="अपना सवाल पूछें…"></textarea><button id="tutorSend" type="button" aria-label="सवाल भेजें">➤</button></div><div class="ai-chat-foot"><span id="tutorStatus">उत्तर को किताब से भी मिलाएँ।</span><button id="clearTutorHistory" class="text-button" type="button">History साफ करें</button></div></section></div>');
 const chat=$("tutorChat"),list=$("tutorHistoryList");
 function renderChat(){
  const c=chats.find(x=>x.id===activeId);chat.innerHTML="";
  if(!c||!c.messages.length){chat.innerHTML='<div class="tutor-welcome"><div class="ai-welcome-icon">✦</div><h3>आज क्या सीखना चाहेंगे?</h3><p>अपनी कक्षा के किसी भी विषय से सवाल पूछें।</p><div class="ai-prompt-chips"><button data-prompt="इसे आसान भाषा में समझाओ।">आसान भाषा में समझाओ</button><button data-prompt="इस सवाल को चरण-दर-चरण हल करो।">Step-by-step हल</button></div></div>';}
  else c.messages.forEach(m=>{const el=document.createElement("article");el.className="tutor-message "+(m.role==="user"?"tutor-user":"tutor-ai");const label=document.createElement("b");label.textContent=m.role==="user"?"आप":"EduFuture AI";const body=document.createElement("div");body.className="tutor-message-body";body.innerHTML=esc(m.text).replace(/\r?\n/g,"<br>").replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>");el.append(label,body);chat.append(el);});
  chat.querySelectorAll("[data-prompt]").forEach(x=>x.onclick=()=>{$("tutorQuestion").value=x.dataset.prompt;$("tutorQuestion").focus()});
  ensureMathJax(chat);
  chat.scrollTop=chat.scrollHeight;
 }
 function renderHistory(){
  list.innerHTML=chats.length?chats.map(c=>'<div class="ai-history-row '+(c.id===activeId?"active":"")+'"><button class="ai-history-open" data-open-chat="'+esc(c.id)+'" type="button">'+esc(c.title||"नई बातचीत")+'</button><button class="ai-history-delete" data-delete-chat="'+esc(c.id)+'" type="button" aria-label="हटाएँ">×</button></div>').join(""):'<p class="ai-history-empty">अभी कोई पुरानी बातचीत नहीं है।</p>';
  list.querySelectorAll("[data-open-chat]").forEach(x=>x.onclick=()=>{activeId=x.dataset.openChat;renderHistory();renderChat()});
  list.querySelectorAll("[data-delete-chat]").forEach(x=>x.onclick=()=>{if(!confirm("यह बातचीत हटाएँ?"))return;chats=chats.filter(c=>c.id!==x.dataset.deleteChat);if(activeId===x.dataset.deleteChat)activeId=chats[0]?.id||null;save();renderHistory();renderChat()});
 }
 if(!classValue){$("tutorStatus").textContent="पहले Student Profile में कक्षा भरें।";$("tutorSend").disabled=true;return;}
 renderHistory();renderChat();
 $("newTutorChat").onclick=()=>{activeId=null;renderHistory();renderChat();$("tutorQuestion").focus()};
 $("clearTutorHistory").onclick=()=>{if(!confirm("इस डिवाइस की पूरी AI Chat History हटाएँ?"))return;chats=[];activeId=null;save();renderHistory();renderChat();$("tutorStatus").textContent="History साफ हो गई।"};
 async function send(){
  const button=$("tutorSend"),question=$("tutorQuestion").value.trim(),className=$("tutorClass").value.trim();if(button.disabled||!question)return;
  if(!className){$("tutorStatus").textContent="कक्षा चुनें।";return;}
  let c=chats.find(x=>x.id===activeId);if(!c){c={id:newId(),title:question.slice(0,48),messages:[],history:[],updatedAt:Date.now()};chats.unshift(c);activeId=c.id;}
  c.messages.push({role:"user",text:question});$("tutorQuestion").value="";save();renderHistory();renderChat();button.disabled=true;$("tutorStatus").textContent="AI जवाब तैयार कर रहा है…";
  try{const result=await api("aiTutorChat",{className,subject:"सामान्य पढ़ाई",topic:"कक्षा "+className+" का पाठ्यक्रम",question,history:c.history||[]});c.messages.push({role:"model",text:result.answer});c.history=[...(c.history||[]),{role:"user",text:question},{role:"model",text:result.answer}].slice(-8);save();renderChat();$("tutorStatus").textContent="जवाब तैयार है।";}
  catch(e){c.messages.push({role:"model",text:"अभी जवाब नहीं मिल पाया: "+e.message});save();renderChat();$("tutorStatus").textContent=e.message;}
  finally{button.disabled=false;$("tutorQuestion").focus();}
 }
 $("tutorSend").onclick=send;$("tutorQuestion").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();}});
};
window.aiNotesPage=async function(){
 const snap=await getDoc(doc(db,"roles",auth.currentUser.uid)),profile=snap.exists()?snap.data():{};
 if(!["admin","superadmin"].includes(profile.role)){page("Access Denied","<p>यह सुविधा केवल Admin के लिए है।</p>");return;}
 page("AI Notes PDF Studio",'<div class="dashboard-hero"><span class="eyebrow">EDUFUTURE • GEMINI CONTENT STUDIO</span><h2>Admin Command से Study Notes बनाएं</h2><p>अपना निर्देश लिखें। AI उसी कक्षा, विषय और अध्याय के अनुसार व्यवस्थित Notes तैयार करेगा।</p></div><section class="item"><div class="builder-meta-grid"><div><label>कक्षा</label><input id="notesClass" placeholder="Class 10"></div><div><label>विषय</label><input id="notesSubject" placeholder="Science"></div><div><label>अध्याय / Topic</label><input id="notesTopic" placeholder="प्रकाश और परावर्तन"></div><div><label>भाषा</label><select id="notesLanguage"><option>Hindi</option><option>English</option><option>Bilingual</option></select></div><div><label>Notes का प्रकार</label><select id="notesLevel"><option>Detailed Notes</option><option>Short Revision</option><option>Exam Preparation</option></select></div></div><label for="notesCommand">Admin Command / निर्देश</label><textarea id="notesCommand" rows="5" maxlength="2500" placeholder="उदाहरण: इस अध्याय के सभी मुख्य सिद्धांत, परिभाषाएँ, सूत्र, सरल उदाहरण और परीक्षा में पूछे जाने वाले महत्वपूर्ण बिंदु शामिल करो। अंत में 5 प्रश्न उत्तर सहित दो।"></textarea><div class="overview-actions"><button id="generateNotes" class="success-action">✦ Generate AI Notes</button><button id="notesClear" class="secondary">Clear</button></div><p id="notesStatus" class="hint" role="status"></p></section><section id="notesPreview" class="item" hidden></section><section class="item"><h3>Recent AI Notes</h3><div id="recentAiNotes">लोड हो रहा है…</div></section>');
 async function recent(){
  try{const result=await api("listAiNotes");$("recentAiNotes").innerHTML=(result.notes||[]).map(n=>'<article class="admin-row"><span><b>'+esc(n.topic)+'</b><small>'+esc(n.className)+' • '+esc(n.subject)+' • '+esc(n.createdAt||"")+'</small></span><div class="ai-note-actions"><button type="button" data-old-note="'+esc(n.id)+'">Open / PDF</button><button type="button" class="danger" data-delete-note="'+esc(n.id)+'">Delete</button></div></article>').join("")||"<p>अभी कोई AI Notes नहीं बने हैं।</p>";
   $("recentAiNotes").querySelectorAll("[data-old-note]").forEach(b=>b.onclick=()=>{const n=result.notes.find(x=>x.id===b.dataset.oldNote);if(n){showNotes(n);openPdf(n.topic+" - Study Notes",n.className+" • "+n.subject+" • "+n.topic,n.content)}});
   $("recentAiNotes").querySelectorAll("[data-delete-note]").forEach(b=>b.onclick=async()=>{if(!confirm("इस Notes PDF को हमेशा के लिए हटाएँ?"))return;b.disabled=true;try{await api("deleteAiNote",{id:b.dataset.deleteNote});await recent();$("notesPreview").hidden=true;status("notesStatus","Notes हटा दिए गए।")}catch(e){b.disabled=false;status("notesStatus",e.message,true)}});
  }catch(e){$("recentAiNotes").textContent=e.message}
 }
 function showNotes(n){
  const box=$("notesPreview");box.hidden=false;box.innerHTML='<div class="question-meta"><span>'+esc(n.className)+'</span><span>'+esc(n.subject)+'</span><span>'+esc(n.topic)+'</span></div><h2>'+esc(n.topic)+' — Study Notes</h2><div class="ai-notes-content">'+markdownHtml(n.content)+'</div><div class="overview-actions"><button id="downloadNotesPdf" class="success-action">Print / Save as PDF</button></div>';
  window.renderEduMath?.(box);
  $("downloadNotesPdf").onclick=()=>{try{openPdf(n.topic+" - Study Notes",n.className+" • "+n.subject+" • "+n.topic,n.content)}catch(e){status("notesStatus",e.message,true)}};
 }
 $("generateNotes").onclick=async()=>{
  const button=$("generateNotes"),data={className:$("notesClass").value.trim(),subject:$("notesSubject").value.trim(),topic:$("notesTopic").value.trim(),language:$("notesLanguage").value,level:$("notesLevel").value,command:$("notesCommand").value.trim()};
  if(button.disabled)return;
  if(!data.className||!data.subject||!data.topic||!data.command){status("notesStatus","कक्षा, विषय, अध्याय और Admin Command भरें।",true);return;}
  button.disabled=true;status("notesStatus","Gemini आपके निर्देश के अनुसार Notes तैयार कर रहा है… इसमें थोड़ा समय लग सकता है।");
  try{const n=await api("generateAiNotes",data);showNotes(n);status("notesStatus","Notes तैयार और सुरक्षित हो गए। अब Print / Save as PDF दबाएँ।");await recent()}
  catch(e){status("notesStatus",e.message,true)}
  finally{button.disabled=false}
 };
 $("notesClear").onclick=()=>{$("notesCommand").value="";$("notesPreview").hidden=true;status("notesStatus","")};
 await recent();
};
