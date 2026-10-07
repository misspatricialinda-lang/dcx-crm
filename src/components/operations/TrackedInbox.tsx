import { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { Mail, Paperclip, RefreshCw, Search, Send, Sparkles, Save, X } from 'lucide-react';
import type { Client } from '../../types/operations';
import { trackingRequest } from '../../lib/email-tracking';
import { crmRequest } from '../../lib/crm-client';
import { buildCustomerQuotationPdf, quotationLogo, type CustomerQuotation } from '../../lib/customer-quotation';

type Draft = { id:string; thread_id:string; current_body:string; original_ai_body:string|null; to_addresses:string[]; status:string; updated_at:string; deleted_at?:string|null };
type Thread = { id:string; subject:string; status:string; priority:string; last_message_at:string; customer_id:string|null; has_attachments?:boolean; sender?:string; preview?:string; draft:Draft };
type Message = { id:string; sender:string; to_addresses:string[]; cc_addresses:string[]; body_text:string; body_html:string; body_loaded:boolean; has_attachments:boolean; direction:string; occurred_at:string };
type Attachment = { id:string; message_id:string; name:string; size_bytes:number };
type Detail = { thread:Thread; draft:Draft; messages:Message[]; attachments:Attachment[] };
type Props = { initialTrash?:boolean; trashOnly?:boolean; focusId?:string; customers:Client[]; onQuote:(id:string)=>void; provider:string; onMailbox:()=>void; onSent?:()=>void };
const date = (value:string) => new Date(value).toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
async function request<T>(query:string, body?:unknown):Promise<T> {
  const response = await fetch(`/api/email-assistant?${query}`, { credentials:'same-origin', cache:'no-store', ...(body ? { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'AI replies are unavailable.');
  return result;
}

async function fileToBase64(file:File):Promise<string> {
  const bytes=new Uint8Array(await file.arrayBuffer());
  let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
  return btoa(binary);
}

export function TrackedInbox({focusId,customers,onSent,initialTrash=false,trashOnly=false}:Props) {
  const [records,setRecords]=useState<Thread[]>([]), [selected,setSelected]=useState(focusId||'');
  useEffect(() => { if (focusId) setSelected(focusId); }, [focusId]);
  const [detail,setDetail]=useState<Detail|null>(null), [body,setBody]=useState(''), [savedBody,setSavedBody]=useState('');
  const [query,setQuery]=useState('');
  const [trash,setTrash]=useState(initialTrash);
  const [files,setFiles]=useState<File[]>([]);
  const [quotationOptions,setQuotationOptions]=useState<CustomerQuotation[]|null>(null), [quotationBusy,setQuotationBusy]=useState(false);
  const [quotationCustomerId,setQuotationCustomerId]=useState('');
  const [loading,setLoading]=useState(true), [detailLoading,setDetailLoading]=useState(false), [busy,setBusy]=useState('');
  const [error,setError]=useState(''), [notice,setNotice]=useState(''), [assistant,setAssistant]=useState(true);
  const [instruction,setInstruction]=useState(''), [chat,setChat]=useState<{role:'user'|'agent';text:string}[]>([]);
  const [expanded,setExpanded]=useState<Record<string,boolean>>({});
  const detailSeq=useRef(0);
  const dirty=body!==savedBody;
  const leave=()=>!dirty||window.confirm('Discard unsaved draft changes?');
  async function loadQueue() {
    setLoading(true);setError('');
    try { const result=await request<{records:Thread[]}>(`action=queue&trash=${trash}`);setRecords(result.records);setSelected(current=>result.records.some(t=>t.id===current)?current:result.records[0]?.id||''); }
    catch(cause){setError((cause as Error).message);}finally{setLoading(false);}
  }
  useEffect(()=>{void loadQueue();},[trash]);
  useEffect(()=>{
    if(!selected){setDetail(null);return;}
    const seq=++detailSeq.current;setDetailLoading(true);setError('');setNotice('');setChat([]);setExpanded({});setFiles([]);setQuotationOptions(null);setQuotationCustomerId('');
    request<Detail>(`action=thread&id=${encodeURIComponent(selected)}&trash=${trash}`).then(result=>{
      if(seq!==detailSeq.current)return;
      setDetail(result);setError('');setQuotationCustomerId(result.thread.customer_id||'');setBody(result.draft.current_body);setSavedBody(result.draft.current_body);
      setExpanded(Object.fromEntries(result.messages.map(m=>[m.id,true])));
      for(const message of result.messages.filter(m=>!m.body_loaded||m.has_attachments)) {
        void trackingRequest<{message:Message;attachments:Attachment[]}>('hydrate',{}, {thread_id:result.thread.id,message_id:message.id}).then(hydrated=>{
          if(seq!==detailSeq.current)return;
          setDetail(old=>old?{...old,messages:old.messages.map(m=>m.id===message.id?hydrated.message:m),attachments:[...old.attachments.filter(a=>a.message_id!==message.id),...hydrated.attachments]}:old);
        }).catch(()=>{});
      }
    }).catch(cause=>{if(seq===detailSeq.current){setError((cause as Error).message);if((cause as Error).message.includes('Conversation not found'))void loadQueue();}}).finally(()=>{if(seq===detailSeq.current)setDetailLoading(false);});
  },[selected,trash]);
  useEffect(()=>{
    const guard=(event:Event)=>{if(!leave())event.preventDefault();};
    const unload=(event:BeforeUnloadEvent)=>{if(dirty){event.preventDefault();event.returnValue='';}};
    window.addEventListener('dcx-before-navigate',guard);window.addEventListener('beforeunload',unload);
    return()=>{window.removeEventListener('dcx-before-navigate',guard);window.removeEventListener('beforeunload',unload);};
  },[dirty]);
  async function changeTrash() {
    if(!detail || busy || !leave())return;
    setBusy('trash');setError('');
    try {await request('',{action:trash?'restore':'delete',draft_id:detail.draft.id,updated_at:detail.draft.updated_at});setSelected('');setDetail(null);setBody('');setSavedBody('');await loadQueue();}catch(e){setError((e as Error).message);}finally{setBusy('');}
  }
  const visible=useMemo(()=>records.filter(t=>`${t.subject} ${customers.find(c=>c.id===t.customer_id)?.name||''}`.toLowerCase().includes(query.toLowerCase())),[records,query,customers]);
  async function workflow(action:'rewrite'|'regenerate'|'save'|'send',extra:Record<string,unknown>={}) {
    if(!detail||busy)return null;
    setBusy(action);setError('');setNotice('');
    try {
      const result=await request<any>('',{action,thread_id:detail.thread.id,draft_id:detail.draft.id,request_id:crypto.randomUUID(),...extra});
      if(action==='save'){setSavedBody(body);setNotice('Draft saved.');}
      if(action==='rewrite'||action==='regenerate'){
        const updated=typeof result.body_text==='string'?result.body_text:result.body_html?.replace(/<[^>]*>/g,'');
        if(typeof updated!=='string')throw new Error('The AI returned no updated draft.');
        setBody(updated);setSavedBody(updated);setDetail(old=>old?{...old,draft:{...old.draft,current_body:updated}}:old);
      }
      if(action==='send'){setNotice('Reply sent.');setRecords(old=>old.filter(t=>t.id!==detail.thread.id));setSelected('');setDetail(null);onSent?.();}
      else {
        const fresh=await request<Detail>(`action=thread&id=${encodeURIComponent(detail.thread.id)}`);
        setDetail(old=>old?{...old,draft:fresh.draft,thread:fresh.thread}:old);
      }
      return result;
    }catch(cause){setError(action==='send'?`${(cause as Error).message} Send outcome needs checking. Check Outlook Sent Items before trying again.`:`${(cause as Error).message} Your draft has been preserved.`);return null;}
    finally{setBusy('');}
  }
  async function save(){return workflow('save',{body_text:body,body_html:''});}
  async function rewrite(text:string){
    if(!text.trim())return;
    if(dirty&&!await save())return;
    setChat(old=>[...old,{role:'user',text}]);
    const result=await workflow('rewrite',{instruction:text});
    if(result){setChat(old=>[...old,{role:'agent',text:'Updated the draft.'}]);setInstruction('');}
  }
  async function regenerate(){if(dirty&&!await save())return;await workflow('regenerate');}
  async function send(){if(dirty&&!await save())return;const attachments=await Promise.all(files.map(async file=>({name:file.name,content_type:file.type||'application/octet-stream',content_base64:await fileToBase64(file)})));await workflow('send',{attachments});}
  function addFileObjects(selectedFiles:File[]) {
    const next=[...files,...selectedFiles];
    if(next.length>5||next.reduce((sum,file)=>sum+file.size,0)>3*1024*1024){setError('Attach up to five files, with a combined size under 3 MB.');return;}
    setError('');setFiles(next);
  }
  function addFiles(selectedFiles:FileList|null) {if(selectedFiles)addFileObjects(Array.from(selectedFiles));}
  async function loadQuotations() {
    if(!quotationCustomerId)return;
    setQuotationBusy(true);setError('');
    try {const result=await crmRequest(`action=quotations&customer_id=${encodeURIComponent(quotationCustomerId)}`);setQuotationOptions(result.records||[]);}
    catch(cause){setError((cause as Error).message);}finally{setQuotationBusy(false);}
  }
  async function attachQuotation(quote:CustomerQuotation) {
    setQuotationBusy(true);setError('');
    try {const pdf=await buildCustomerQuotationPdf(quote,await quotationLogo());addFileObjects([new File([pdf.output('blob')],`DCX-Estimate-${quote.estimate_number}.pdf`,{type:'application/pdf'})]);setQuotationOptions(null);}
    catch(cause){setError((cause as Error).message);}finally{setQuotationBusy(false);}
  }
  async function expandMessage(message:Message) {
    setExpanded(old=>({...old,[message.id]:!old[message.id]}));
    if(!detail||(!message.has_attachments&&message.body_loaded))return;
    try {
      const result=await trackingRequest<{message:Message;attachments:Attachment[]}>('hydrate',{}, {thread_id:detail.thread.id,message_id:message.id});
      setDetail(old=>old?{...old,messages:old.messages.map(m=>m.id===message.id?result.message:m),attachments:[...old.attachments.filter(a=>a.message_id!==message.id),...result.attachments]}:old);
    }catch(cause){setError((cause as Error).message);}
  }
  return <div className="ai-mail">
    <div className="ai-mail-toolbar"><div><strong>{trash ? 'Discarded AI drafts' : 'AI replies'}</strong><small>{trash ? 'Discarded replies can be restored for review' : 'Emails with a draft ready for review'}</small></div>{!trashOnly&&<button className="secondary" onClick={()=>{if(leave()){setSelected('');setTrash(v=>!v);}}}>{trash ? 'Show active AI drafts' : 'Deleted AI drafts'}</button>}<button className="ai-mail-icon" aria-label="Refresh AI replies" onClick={loadQueue} disabled={loading}><RefreshCw size={17}/></button></div>
    {error&&<div className="ai-mail-alert" role="alert">{error}</div>}{notice&&<div className="ai-mail-notice" role="status">{notice}</div>}
    <div className="ai-mail-grid">
      <div className="ai-mail-list"><label className="ai-mail-search"><Search size={16}/><input value={query} onChange={event=>setQuery(event.target.value)} placeholder="Search AI replies" aria-label="Search AI replies"/></label><div className="ai-mail-list-title">Conversations <span>{visible.length}</span></div>
        {loading?<p className="ai-mail-empty">Loading replies…</p>:visible.length?visible.map(thread=><button key={thread.id} className={`ai-mail-row ${selected===thread.id?'active':''}`} onClick={()=>{if(selected!==thread.id&&leave())setSelected(thread.id);}}><span className="ai-mail-row-top"><strong>{customers.find(c=>c.id===thread.customer_id)?.name||thread.sender||'Email conversation'}</strong><time>{date(thread.last_message_at)}</time></span><b>{thread.subject}</b><span className="ai-mail-preview">{thread.preview}</span><small>AI draft ready</small>{thread.has_attachments&&<Paperclip size={14}/>}</button>):<p className="ai-mail-empty">No AI reply drafts in this view.</p>}
      </div>
      <main className="ai-mail-detail">{detailLoading?<p className="ai-mail-empty">Loading conversation…</p>:detail?<><div className="ai-mail-subject"><div><h1>{detail.thread.subject}</h1><small>{detail.messages.length} messages · AI draft ready</small></div><button className="ai-mail-icon" onClick={()=>setAssistant(!assistant)} aria-label={assistant?'Close AI assistant':'Open AI assistant'}><Sparkles size={18}/></button></div>
        <div className={`ai-mail-content ${assistant?'with-assistant':''}`}><div className="ai-mail-thread"><div className="ai-mail-history">{[...detail.messages].sort((a,b)=>a.occurred_at.localeCompare(b.occurred_at)||a.id.localeCompare(b.id)).map(message=>{const open=!!expanded[message.id];const files=detail.attachments.filter(a=>a.message_id===message.id);return <article className="ai-mail-message" key={message.id}><button className="ai-mail-message-head" onClick={()=>void expandMessage(message)} aria-expanded={open}><span className="ai-mail-sender"><strong>{message.sender||(message.direction==='outgoing'?'DCX':'Unknown sender')}</strong><small>{message.direction==='outgoing'?'Sent':'Received'} · {date(message.occurred_at)}</small></span><time>{date(message.occurred_at)}</time>{(files.length>0||message.has_attachments)&&<Paperclip size={15}/>}</button>{open&&<div className="ai-mail-message-open"><div className="ai-mail-addresses">To: {message.to_addresses?.join(', ')||'—'}{message.cc_addresses?.length>0&&<div>CC: {message.cc_addresses.join(', ')}</div>}</div>{message.body_html?<div className="ai-mail-html" dangerouslySetInnerHTML={{__html:DOMPurify.sanitize(message.body_html,{FORBID_TAGS:['img','style','iframe','form','input','video','audio','svg'],FORBID_ATTR:['style']})}}/>:<p className="ai-mail-text">{message.body_text||'Message body is not stored yet.'}</p>}{files.length>0&&<div className="ai-mail-files"><strong>Attachments ({files.length})</strong>{files.map(file=><a key={file.id} href={`/api/tracking?action=attachment&id=${encodeURIComponent(file.id)}`} target="_blank" rel="noreferrer"><Paperclip size={14}/>{file.name}<small>{Math.ceil(file.size_bytes/1024)} KB</small></a>)}</div>}</div>}</article>;})}</div>
          {trash ? <section className="ai-mail-compose"><p className="ai-mail-text">{body}</p><button className="primary" disabled={!!busy} onClick={()=>void changeTrash()}>Restore to AI drafts</button></section> : <section className="ai-mail-compose"><div className="ai-mail-compose-head"><strong>Reply</strong><span>{dirty?'Unsaved changes':'AI draft ready'}</span></div><p>To: {detail.draft.to_addresses?.join(', ')}</p><textarea aria-label="Edit AI reply draft" value={body} onChange={event=>setBody(event.target.value)} rows={10} disabled={!!busy}/><div className="ai-mail-outgoing-files"><label><Paperclip size={15}/> Attach files<input type="file" multiple onChange={event=>{void addFiles(event.target.files);event.target.value='';}} disabled={!!busy}/></label><select aria-label="Customer for saved quotation" value={quotationCustomerId} onChange={event=>{setQuotationCustomerId(event.target.value);setQuotationOptions(null);}}><option value="">Choose customer for quotation</option>{customers.map(customer=><option key={customer.id} value={customer.id}>{customer.name}</option>)}</select><button className="secondary compact" type="button" disabled={!!busy||quotationBusy||!quotationCustomerId} onClick={()=>void loadQuotations()}>{quotationBusy?'Loading...':'Attach saved quotation'}</button>{quotationOptions&&<select aria-label="Choose saved quotation to attach" value="" onChange={event=>{const quote=quotationOptions.find(item=>item.id===event.target.value);if(quote)void attachQuotation(quote);}}><option value="">{quotationOptions.length?'Choose a quotation PDF':'No saved quotations for this customer'}</option>{quotationOptions.map(quote=><option key={quote.id} value={quote.id}>Estimate #{quote.estimate_number} - {quote.status}</option>)}</select>}{files.map((file,index)=><span key={`${file.name}-${index}`}>{file.name} ({Math.ceil(file.size/1024)} KB)<button type="button" aria-label={`Remove ${file.name}`} onClick={()=>setFiles(old=>old.filter((_,i)=>i!==index))}><X size={13}/></button></span>)}</div><div className="ai-mail-actions"><button className="secondary" disabled={!!busy} onClick={()=>void changeTrash()}>Delete AI draft</button><button className="secondary" disabled={!!busy||!dirty||!body.trim()} onClick={save}><Save size={15}/>{busy==='save'?'Saving…':'Save draft'}</button><button className="secondary" disabled={!!busy} onClick={regenerate}><RefreshCw size={15}/>{busy==='regenerate'?'Regenerating…':'Regenerate'}</button><button className="primary" disabled={!!busy||!body.trim()} onClick={send}><Send size={15}/>{busy==='send'?'Sending…':'Send reply'}</button></div></section>}
        </div>{assistant&&<aside className="ai-mail-assistant"><div className="ai-mail-assistant-head"><strong><Sparkles size={16}/> AI assistant</strong><button aria-label="Close AI assistant" onClick={()=>setAssistant(false)}><X size={16}/></button></div><p>Improve this conversation’s current reply.</p><div className="ai-mail-shortcuts">{['Shorten','More professional','Friendlier','Fix grammar'].map(label=><button key={label} disabled={!!busy} onClick={()=>rewrite(label)}>{label}</button>)}</div><div className="ai-mail-chat">{chat.map((item,index)=><p className={item.role} key={index}>{item.text}</p>)}{busy==='rewrite'&&<p>Updating draft…</p>}</div><form onSubmit={event=>{event.preventDefault();void rewrite(instruction);}}><input aria-label="Ask AI about this reply" placeholder="Ask AI about this reply…" value={instruction} onChange={event=>setInstruction(event.target.value)} disabled={!!busy}/><button type="submit" aria-label="Send AI instruction" disabled={!!busy||!instruction.trim()}><Send size={16}/></button></form></aside>}</div>
      </>:<div className="ai-mail-empty"><Mail size={30}/><p>Select an AI reply to review.</p></div>}</main>
    </div>
  </div>;
}
