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
  window.MathJax={tex:{inlineMath:[["$","$"],["\\(","\\)"]],displayMath:[["$$","$$"],["\\[","\\]"]],processEscapes:true,packages:{"[+]":["ams"]}},options:{skipHtmlTags:["script","noscript","style","textarea","pre","code"]},startup:{typeset:false}};
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
 w.document.open();w.document.write('<!doctype html><html lang="hi"><head><meta charset="utf-8"><title>'+esc(title)+'</title><style>@page{size:A4;margin:18mm}body{font-family:Arial,"Noto Sans Devanagari",sans-serif;color:#172033;line-height:1.65;font-size:12pt}h1{font-size:22pt;color:#163a70;margin-bottom:4px}h2{font-size:16pt;color:#204d82;border-bottom:1px solid #dbe4ef;padding-bottom:4px;margin-top:22px}h3{font-size:13pt;color:#204d82;margin-top:16px}.meta{color:#53657d;border-bottom:2px solid #dbe4ef;padding-bottom:12px;margin-bottom:20px}.pdf-bullet{margin:4px 0 4px 16px}.pdf-gap{height:6px}.footer{margin-top:28px;padding-top:8px;border-top:1px solid #ddd;color:#667;font-size:9pt}@media print{button{display:none}}</style></head><body><h1>'+esc(title)+'</h1><div class="meta">'+esc(meta)+'</div>'+markdownHtml(content)+'<div class="footer">EduFuture • U.H.S. Rakasiya • AI-assisted study material — शिक्षक/विद्यार्थी उपयोग से पहले तथ्य जाँच लें।</div><script>window.MathJax={tex:{inlineMath:[["$","$"],["\\(","\\)"]],displayMath:[["$","$"],["\\[","\\]"]],processEscapes:true}};<\/script><script async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js"></script><script>window.onload=()=>setTimeout(async()=>{try{await MathJax.typesetPromise()}catch(e){}window.print()},1000)<\/script></body></html>');
 w.document.close();
}
window.aiChatPage=async function(){
 const snap=await getDoc(doc(db,"roles",auth.currentUser.uid)),profile=snap.exists()?snap.data():{};
 const classValue=String(profile.className||""),isStudent=profile.role==="student",storageKey="edufuture-ai-chat-"+auth.currentUser.uid;
 const classOptions=isStudent?'<option value="'+esc(classValue)+'">'+esc(classValue||"कक्षा चुनें")+'</option>':['6','7','8','9','10','11','12'].map(x=>'<option value="Class '+x+'" '+(classValue.toLowerCase().replace("class ","")===x?"selected":"")+' >कक्षा '+x+'</option>').join("");
 let chats=[];try{chats=JSON.parse(localStorage.getItem(storageKey)||"[]");if(!Array.isArray(chats))chats=[];}catch{}
 let activeId=chats[0]?.id||null;
 const save=()=>{try{localStorage.setItem(storageKey,JSON.stringify(chats.slice(0,60)));}catch{}const c=chats.find(x=>x.id===activeId);if(c)api("saveAiTutorChat",{id:c.id,title:c.title,messages:c.messages,history:c.history||[]}).catch(e=>console.warn("Cloud history save:",e.message));};
 const newId=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,7);
 $("view").innerHTML='<section class="ef-chat-page"><aside class="ef-chat-sidebar" id="efChatSidebar"><div class="ef-side-top"><div class="ef-brand-mini"><span>✦</span><div><b>EduFuture AI</b><small>पढ़ाई में आपका साथी</small></div></div><button id="newTutorChat" class="ef-new-chat">＋ नई बातचीत</button></div><div class="ef-history-title">पुरानी बातचीत</div><div id="tutorHistoryList" class="ef-history-list"></div><div class="ef-side-bottom"><span>कक्षा '+esc(classValue||"—")+'</span><span>सिर्फ पढ़ाई के सवाल</span></div></aside><section class="ef-chat-main"><header class="ef-chat-top"><button id="toggleChatHistory" class="ef-icon-btn" aria-label="History खोलें">☰</button><div><b>AI Study Tutor</b><small>आसान हिन्दी • चरण-दर-चरण समझाएँ</small></div><span class="ef-class-pill">कक्षा <select id="tutorClass" '+(isStudent?"disabled":"")+'>'+classOptions+'</select></span></header><div id="tutorChat" class="ef-chat-messages" aria-live="polite"></div><footer class="ef-chat-footer"><div class="ef-chat-compose"><textarea id="tutorQuestion" rows="1" maxlength="3000" placeholder="अपना सवाल यहाँ लिखें…"></textarea><button id="tutorSend" aria-label="सवाल भेजें" type="button">➤</button></div><div class="ef-chat-footnote"><span id="tutorStatus">गणित के सूत्र किताब जैसे दिखेंगे।</span><button id="clearTutorHistory" type="button">History साफ करें</button></div></footer></section></section>';
 const chat=$("tutorChat"),list=$("tutorHistoryList");
 function renderChat(forceBottom=true){
  const keepBottom=forceBottom||(chat.scrollHeight-chat.scrollTop-chat.clientHeight<110),previousTop=chat.scrollTop;
  const c=chats.find(x=>x.id===activeId);chat.innerHTML="";
  if(!c||!c.messages.length){chat.innerHTML='<div class="ef-welcome"><div class="ef-welcome-mark">✦</div><p class="ef-welcome-kicker">EDUFUTURE LEARNING</p><h1>आज क्या सीखें?</h1><p>कक्षा '+esc(classValue||"चुनें")+' के किसी भी विषय से सवाल पूछें। जवाब आसान हिन्दी में मिलेगा।</p><div class="ef-suggestions"><button data-prompt="इस सवाल को आसान हिन्दी में उदाहरण के साथ समझाइए।">आसान भाषा में समझाएँ</button><button data-prompt="इस गणित के सवाल को किताब वाले सूत्र और पूरे हल के साथ समझाइए।">गणित का पूरा हल</button><button data-prompt="इस विषय के 5 अभ्यास प्रश्न उत्तर सहित दीजिए।">अभ्यास प्रश्न</button></div></div>';}
  else c.messages.forEach(m=>{const el=document.createElement("article");el.className="ef-message "+(m.role==="user"?"ef-user-message":"ef-ai-message");const label=document.createElement("b");label.textContent=m.role==="user"?"आप":"✦ EduFuture";const body=document.createElement("div");body.className="ef-message-body";body.innerHTML=markdownHtml(m.text);el.append(label,body);chat.append(el);});
  chat.querySelectorAll("[data-prompt]").forEach(x=>x.onclick=()=>{$("tutorQuestion").value=x.dataset.prompt;$("tutorQuestion").focus()});
  ensureMathJax(chat);requestAnimationFrame(()=>{if(keepBottom)chat.scrollTop=chat.scrollHeight;else chat.scrollTop=previousTop;});
 }
 function renderHistory(){
  list.innerHTML=chats.length?chats.map(c=>'<div class="ef-history-row '+(c.id===activeId?"active":"")+'"><button class="ef-history-open" data-open-chat="'+esc(c.id)+'">'+esc(c.title||"नई बातचीत")+'</button><button class="ef-history-delete" data-delete-chat="'+esc(c.id)+'" aria-label="बातचीत हटाएँ">×</button></div>').join(""):'<p class="ef-history-empty">अभी कोई पुरानी बातचीत नहीं।</p>';
  list.querySelectorAll("[data-open-chat]").forEach(x=>x.onclick=()=>{activeId=x.dataset.openChat;renderHistory();renderChat();$("efChatSidebar").classList.remove("mobile-open")});
  list.querySelectorAll("[data-delete-chat]").forEach(x=>x.onclick=async()=>{if(!confirm("यह बातचीत सभी डिवाइसों की History से हटाएँ?"))return;const id=x.dataset.deleteChat;chats=chats.filter(c=>c.id!==id);if(activeId===id)activeId=chats[0]?.id||null;save();try{await api("deleteAiTutorChat",{id})}catch(e){console.warn("Cloud history delete:",e.message)}renderHistory();renderChat()});
 }
 if(isStudent&&!classValue){$("tutorStatus").textContent="पहले Student Profile में अपनी कक्षा भरें।";$("tutorSend").disabled=true;return;}
 try{const cloud=await api("listAiTutorChats");const local=new Map(chats.map(c=>[c.id,c]));(cloud.chats||[]).forEach(c=>{if(!local.has(c.id))local.set(c.id,{...c,updatedAt:Date.now()})});chats=Array.from(local.values()).slice(0,60);}catch(e){console.warn("Cloud history load:",e.message)}
 renderHistory();renderChat();
 $("newTutorChat").onclick=()=>{activeId=null;renderHistory();renderChat();$("efChatSidebar").classList.remove("mobile-open");$("tutorQuestion").focus()};
 $("toggleChatHistory").onclick=()=>$("efChatSidebar").classList.toggle("mobile-open");
 $("clearTutorHistory").onclick=()=>{if(!confirm("इस डिवाइस की पूरी AI Chat History हटाएँ?"))return;chats=[];activeId=null;save();renderHistory();renderChat();$("tutorStatus").textContent="History साफ हो गई।"};
 async function send(){
  const button=$("tutorSend"),question=$("tutorQuestion").value.trim(),className=$("tutorClass").value.trim();if(button.disabled||!question)return;
  if(!className){$("tutorStatus").textContent="कक्षा चुनें।";return;}
  let c=chats.find(x=>x.id===activeId);if(!c){c={id:newId(),title:question.slice(0,48),messages:[],history:[],updatedAt:Date.now()};chats.unshift(c);activeId=c.id;}
  c.messages.push({role:"user",text:question});$("tutorQuestion").value="";save();renderHistory();renderChat();button.disabled=true;$("tutorStatus").textContent="सरल हिन्दी में जवाब तैयार हो रहा है…";
  try{
   const result=await api("aiTutorChat",{className,subject:"सामान्य पढ़ाई",topic:"कक्षा "+className+" का पाठ्यक्रम",question,history:c.history||[]});
   const answer=String(result.answer||"");c.messages.push({role:"model",text:""});const target=c.messages[c.messages.length-1];
   for(let i=0;i<answer.length;i+=18){target.text=answer.slice(0,i+18);renderChat(false);if(i%72===0)save();await new Promise(resolve=>setTimeout(resolve,18));}
   c.history=[...(c.history||[]),{role:"user",text:question},{role:"model",text:answer}].slice(-8);save();renderChat(true);$("tutorStatus").textContent="जवाब तैयार है।";
  }catch(e){c.messages.push({role:"model",text:"अभी जवाब नहीं मिल पाया: "+e.message});save();renderChat(true);$("tutorStatus").textContent=e.message;}
  finally{button.disabled=false;$("tutorQuestion").focus();}
 }
 $("tutorSend").onclick=send;$("tutorQuestion").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();}});
};
window.aiNotesPage=async function(){
 const snap=await getDoc(doc(db,"roles",auth.currentUser.uid)),profile=snap.exists()?snap.data():{};
 if(!["admin","superadmin"].includes(profile.role)){page("Access Denied","<p>यह सुविधा केवल Admin के लिए है।</p>");return;}
 page("AI Notes PDF Studio",'<div class="ef-notes-studio"><header class="ef-notes-hero"><span>✦ EDUFUTURE NOTES STUDIO</span><h2>अपने निर्देश से Notes बनाइए</h2><p>कक्षा, विषय और अध्याय चुनें। AI आसान हिन्दी में पढ़ने योग्य Notes बनाएगा।</p></header><section class="ef-notes-form"><div class="builder-meta-grid"><div><label>कक्षा</label><input id="notesClass" placeholder="कक्षा 10"></div><div><label>विषय</label><input id="notesSubject" placeholder="गणित"></div><div><label>अध्याय / Topic</label><input id="notesTopic" placeholder="वास्तविक संख्याएँ"></div><div><label>भाषा</label><select id="notesLanguage"><option>Hindi</option><option>English</option><option>Bilingual</option></select></div><div><label>Notes का प्रकार</label><select id="notesLevel"><option>Detailed Notes</option><option>Short Revision</option><option>Exam Preparation</option></select></div></div><label for="notesCommand">आप क्या-क्या शामिल करवाना चाहते हैं?</label><textarea id="notesCommand" rows="5" maxlength="2500" placeholder="उदाहरण: किताब की भाषा में परिभाषाएँ, सभी सूत्र, हल किए उदाहरण, महत्वपूर्ण प्रश्न और उत्तर शामिल करें।"></textarea><div class="ef-notes-actions"><button id="generateNotes" class="success-action">✦ Notes तैयार करें</button><button id="notesClear" class="secondary">साफ करें</button></div><p id="notesStatus" class="hint" role="status"></p></section><section id="notesPreview" class="ef-notes-preview" hidden></section><section class="ef-recent-notes"><h3>आपके बनाए Notes</h3><p>यहाँ से PDF बनाएँ, विद्यार्थियों के लिए Publish करें या Delete करें।</p><div id="recentAiNotes">लोड हो रहा है…</div></section></div>');
 async function recent(){
  try{const result=await api("listAiNotes");$("recentAiNotes").innerHTML=(result.notes||[]).map(n=>'<article class="ef-note-row"><div><b>'+esc(n.topic)+'</b><small>'+esc(n.className)+' • '+esc(n.subject)+' • '+(n.published?'विद्यार्थियों के लिए प्रकाशित':'Draft')+'</small></div><div class="ef-note-actions"><button data-open-note="'+esc(n.id)+'">देखें / PDF</button><button data-publish-note="'+esc(n.id)+'" data-published="'+(n.published?"1":"0")+'">'+(n.published?"Unpublish":"Publish")+'</button><button class="ef-danger" data-delete-note="'+esc(n.id)+'">Delete</button></div></article>').join("")||"<p>अभी कोई Notes नहीं बने हैं।</p>";
   $("recentAiNotes").querySelectorAll("[data-open-note]").forEach(b=>b.onclick=()=>{const n=result.notes.find(x=>x.id===b.dataset.openNote);if(n)showNotes(n)});
   $("recentAiNotes").querySelectorAll("[data-publish-note]").forEach(b=>b.onclick=async()=>{b.disabled=true;try{await api("publishAiNote",{id:b.dataset.publishNote,published:b.dataset.published!=="1"});await recent();status("notesStatus",b.dataset.published==="1"?"Notes Unpublish कर दिए गए।":"Notes विद्यार्थियों के लिए Publish हो गए।")}catch(e){b.disabled=false;status("notesStatus",e.message,true)}});
   $("recentAiNotes").querySelectorAll("[data-delete-note]").forEach(b=>b.onclick=async()=>{if(!confirm("इस Notes को हमेशा के लिए Delete करें?"))return;b.disabled=true;try{await api("deleteAiNote",{id:b.dataset.deleteNote});await recent();$("notesPreview").hidden=true;status("notesStatus","Notes Delete हो गए।")}catch(e){b.disabled=false;status("notesStatus",e.message,true)}});
  }catch(e){$("recentAiNotes").textContent=e.message}
 }
 function showNotes(n){
  const box=$("notesPreview");box.hidden=false;box.innerHTML='<div class="ef-note-preview-head"><div><span>'+esc(n.className)+' • '+esc(n.subject)+'</span><h2>'+esc(n.topic)+'</h2></div><button id="downloadNotesPdf" class="success-action">PDF बनाएँ / Print करें</button></div><div class="ai-notes-content">'+markdownHtml(n.content)+'</div><div class="ef-preview-publish"><span>'+(n.published?"विद्यार्थियों के लिए Published":"अभी Draft है")+'</span><button id="previewPublish" class="secondary">'+(n.published?"Unpublish":"Publish")+'</button></div>';
  ensureMathJax(box);
  $("downloadNotesPdf").onclick=()=>{try{openPdf(n.topic+" - Study Notes",n.className+" • "+n.subject+" • "+n.topic,n.content)}catch(e){status("notesStatus",e.message,true)}};
  $("previewPublish").onclick=async()=>{try{await api("publishAiNote",{id:n.id,published:!n.published});n.published=!n.published;showNotes(n);await recent()}catch(e){status("notesStatus",e.message,true)}};
 }
 $("generateNotes").onclick=async()=>{
  const button=$("generateNotes"),data={className:$("notesClass").value.trim(),subject:$("notesSubject").value.trim(),topic:$("notesTopic").value.trim(),language:$("notesLanguage").value,level:$("notesLevel").value,command:$("notesCommand").value.trim()};
  if(button.disabled)return;
  if(!data.className||!data.subject||!data.topic||!data.command){status("notesStatus","कक्षा, विषय, अध्याय और निर्देश भरें।",true);return;}
  button.disabled=true;status("notesStatus","AI आसान हिन्दी में Notes तैयार कर रहा है…");
  try{const n=await api("generateAiNotes",data);showNotes(n);status("notesStatus","Notes बन गए। PDF बनाएँ या विद्यार्थियों के लिए Publish करें।");await recent()}
  catch(e){status("notesStatus",e.message,true)}
  finally{button.disabled=false}
 };
 $("notesClear").onclick=()=>{$("notesCommand").value="";$("notesPreview").hidden=true;status("notesStatus","")};
 await recent();
};
