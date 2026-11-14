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
 const role=profile.role||"student",isStudent=role==="student";
 const classValue=String(profile.className||"");
 let history=[];
 page("AI Study Chat",'<div class="dashboard-hero"><span class="eyebrow">EDUFUTURE • AI LEARNING ASSISTANT</span><h2>पढ़ाई से जुड़ा हर सवाल पूछें</h2><p>AI Tutor आपकी कक्षा, विषय और अध्याय के अनुसार सरल भाषा में समझाएगा।</p></div><div class="item"><div class="builder-meta-grid"><div><label>कक्षा</label><input id="tutorClass" value="'+esc(classValue)+'" '+(isStudent?'readonly':'')+' placeholder="Class 10"></div><div><label>विषय</label><input id="tutorSubject" placeholder="जैसे गणित"></div><div><label>अध्याय / Topic</label><input id="tutorTopic" placeholder="जैसे द्विघात समीकरण"></div></div><div id="tutorChat" class="tutor-chat" aria-live="polite"><div class="tutor-welcome"><b>नमस्ते! मैं EduFuture AI Tutor हूँ।</b><p>विषय और अध्याय चुनकर उसी पाठ से जुड़ा प्रश्न पूछें।</p></div></div><label for="tutorQuestion">आपका सवाल</label><textarea id="tutorQuestion" rows="3" maxlength="3000" placeholder="उदाहरण: इस अध्याय का यह सूत्र कैसे काम करता है?"></textarea><div class="overview-actions"><button id="tutorSend" class="success-action">✦ सवाल पूछें</button><button id="tutorClear" class="secondary">नई बातचीत</button></div><p id="tutorStatus" class="hint" role="status"></p><p class="hint">AI कभी-कभी गलती कर सकता है। परीक्षा की तैयारी में अपनी किताब और शिक्षक से भी मिलान करें।</p></div>');
 const chat=$("tutorChat");
 const addMessage=(who,text)=>{const el=document.createElement("article");el.className="tutor-message "+(who==="user"?"tutor-user":"tutor-ai");const label=document.createElement("b");label.textContent=who==="user"?"आप":"EduFuture AI Tutor";const body=document.createElement("div");body.textContent=text;el.append(label,body);chat.append(el);chat.scrollTop=chat.scrollHeight};
 if(isStudent&&!classValue){$("tutorStatus").textContent="पहले अपना Student Profile पूरा करें।";$("tutorSend").disabled=true;return;}
 $("tutorClear").onclick=()=>{history=[];chat.innerHTML='<div class="tutor-welcome"><b>नई बातचीत शुरू करें।</b></div>';status("tutorStatus","")};
 async function send(){
  const button=$("tutorSend"),question=$("tutorQuestion").value.trim(),subject=$("tutorSubject").value.trim(),topic=$("tutorTopic").value.trim(),className=$("tutorClass").value.trim();
  if(button.disabled)return;
  if(!className||!subject||!topic||!question){status("tutorStatus","कक्षा, विषय, अध्याय और सवाल भरें।",true);return;}
  button.disabled=true;status("tutorStatus","AI Tutor आपके सवाल को समझ रहा है…");
  addMessage("user",question);$("tutorQuestion").value="";
  try{
   const result=await api("aiTutorChat",{className,subject,topic,question,history});
   history.push({role:"user",text:question},{role:"model",text:result.answer});history=history.slice(-8);
   addMessage("ai",result.answer);status("tutorStatus","जवाब तैयार है।");
  }catch(e){addMessage("ai","अभी जवाब नहीं मिल पाया: "+e.message);status("tutorStatus",e.message,true)}
  finally{button.disabled=false;$("tutorQuestion").focus();}
 }
 $("tutorSend").onclick=send;
 $("tutorQuestion").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();}});
};
window.aiNotesPage=async function(){
 const snap=await getDoc(doc(db,"roles",auth.currentUser.uid)),profile=snap.exists()?snap.data():{};
 if(!["admin","superadmin"].includes(profile.role)){page("Access Denied","<p>यह सुविधा केवल Admin के लिए है।</p>");return;}
 page("AI Notes PDF Studio",'<div class="dashboard-hero"><span class="eyebrow">EDUFUTURE • GEMINI CONTENT STUDIO</span><h2>Admin Command से Study Notes बनाएं</h2><p>अपना निर्देश लिखें। AI उसी कक्षा, विषय और अध्याय के अनुसार व्यवस्थित Notes तैयार करेगा।</p></div><section class="item"><div class="builder-meta-grid"><div><label>कक्षा</label><input id="notesClass" placeholder="Class 10"></div><div><label>विषय</label><input id="notesSubject" placeholder="Science"></div><div><label>अध्याय / Topic</label><input id="notesTopic" placeholder="प्रकाश और परावर्तन"></div><div><label>भाषा</label><select id="notesLanguage"><option>Hindi</option><option>English</option><option>Bilingual</option></select></div><div><label>Notes का प्रकार</label><select id="notesLevel"><option>Detailed Notes</option><option>Short Revision</option><option>Exam Preparation</option></select></div></div><label for="notesCommand">Admin Command / निर्देश</label><textarea id="notesCommand" rows="5" maxlength="2500" placeholder="उदाहरण: इस अध्याय के सभी मुख्य सिद्धांत, परिभाषाएँ, सूत्र, सरल उदाहरण और परीक्षा में पूछे जाने वाले महत्वपूर्ण बिंदु शामिल करो। अंत में 5 प्रश्न उत्तर सहित दो।"></textarea><div class="overview-actions"><button id="generateNotes" class="success-action">✦ Generate AI Notes</button><button id="notesClear" class="secondary">Clear</button></div><p id="notesStatus" class="hint" role="status"></p></section><section id="notesPreview" class="item" hidden></section><section class="item"><h3>Recent AI Notes</h3><div id="recentAiNotes">लोड हो रहा है…</div></section>');
 async function recent(){
  try{const result=await api("listAiNotes");$("recentAiNotes").innerHTML=(result.notes||[]).map(n=>'<article class="admin-row"><span><b>'+esc(n.topic)+'</b><small>'+esc(n.className)+' • '+esc(n.subject)+' • '+esc(n.createdAt||"")+'</small></span><button type="button" data-old-note="'+esc(n.id)+'">Open / PDF</button></article>').join("")||"<p>अभी कोई AI Notes नहीं बने हैं।</p>";
   $("recentAiNotes").querySelectorAll("[data-old-note]").forEach(b=>b.onclick=()=>{const n=result.notes.find(x=>x.id===b.dataset.oldNote);if(n){showNotes(n);openPdf(n.topic+" - Study Notes",n.className+" • "+n.subject+" • "+n.topic,n.content)}});
  }catch(e){$("recentAiNotes").textContent=e.message}
 }
 function showNotes(n){
  const box=$("notesPreview");box.hidden=false;box.innerHTML='<div class="question-meta"><span>'+esc(n.className)+'</span><span>'+esc(n.subject)+'</span><span>'+esc(n.topic)+'</span></div><h2>'+esc(n.topic)+' — Study Notes</h2><div class="ai-notes-content">'+markdownHtml(n.content)+'</div><div class="overview-actions"><button id="downloadNotesPdf" class="success-action">Print / Save as PDF</button></div>';
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
