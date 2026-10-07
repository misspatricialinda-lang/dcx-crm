import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Paperclip, RefreshCw, Save, Send, Sparkles, Trash2, X } from 'lucide-react';
import type { Client } from '../../types/operations';
import { trackingRequest } from '../../lib/email-tracking';
import { crmRequest } from '../../lib/crm-client';
import { SignaturePreview } from './EmailSignature';
import { buildCustomerQuotationPdf, quotationLogo, type CustomerQuotation } from '../../lib/customer-quotation';

type Draft = { id:string; thread_id:string; current_body:string; original_ai_body:string|null; to_addresses:string[]; status:string; updated_at:string };
export type ReplyOutcome = 'sent' | 'discarded' | 'changed';

async function assistant<T>(query:string, body?:unknown):Promise<T> {
  const response = await fetch(`/api/email-assistant?${query}`, { credentials:'same-origin', cache:'no-store', ...(body ? { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'AI replies are unavailable.');
  return result;
}
async function fileToBase64(file:File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let start = 0; start < bytes.length; start += 16384) binary += String.fromCharCode(...bytes.subarray(start, start + 16384));
  return btoa(binary);
}
const quickChanges = ['Shorter', 'More formal', 'Friendlier', 'Fix grammar'];

// The AI reply for one conversation, edited in place below the email like an Outlook inline reply.
export function InlineAiReply({ internetId, sourceMessageId, revision, customers, customerId, onDirty, onOutcome, onNext, nextLabel }: {
  internetId?: string; sourceMessageId?: string; revision:number; customers:Client[]; customerId?:string;
  onDirty:(dirty:boolean)=>void; onOutcome:(outcome:ReplyOutcome)=>void; onNext?:()=>void; nextLabel?:string;
}) {
  const [draft,setDraft]=useState<Draft|null>(null), [loaded,setLoaded]=useState(false);
  const [body,setBody]=useState(''), [savedBody,setSavedBody]=useState('');
  const [busy,setBusy]=useState(''), [error,setError]=useState(''), [notice,setNotice]=useState('');
  const [instruction,setInstruction]=useState(''), [files,setFiles]=useState<File[]>([]);
  const [quotationCustomerId,setQuotationCustomerId]=useState(customerId||''), [quotations,setQuotations]=useState<CustomerQuotation[]|null>(null);
  const editor=useRef<HTMLTextAreaElement>(null);
  const dirty=!!draft&&body!==savedBody;
  useEffect(()=>{onDirty(dirty);},[dirty]);
  useEffect(()=>()=>onDirty(false),[]);
  const latest=useRef<Draft|null>(null);
  async function load(quiet=false){
    if(!internetId){setDraft(null);setLoaded(true);return;}
    try{
      const result=await assistant<{draft:Draft|null}>(`action=for-message&internet_message_id=${encodeURIComponent(internetId)}`);
      latest.current=result.draft;setDraft(result.draft);setBody(result.draft?.current_body||'');setSavedBody(result.draft?.current_body||'');
      if(!quiet)setError('');
    }catch(cause){setError((cause as Error).message);}
    finally{setLoaded(true);}
  }
  // A new email resets the panel; the mailbox's minute refresh only reloads quietly and never replaces unsaved edits.
  const shownFor=useRef<string>();
  useEffect(()=>{
    if(shownFor.current!==internetId){shownFor.current=internetId;setLoaded(false);setNotice('');setFiles([]);setQuotations(null);void load();}
    else if(!dirty&&!busy)void load(true);
  },[internetId,revision]);
  useEffect(()=>{const node=editor.current;if(node){node.style.height='auto';node.style.height=`${Math.max(node.scrollHeight,140)}px`;}},[body,draft?.id]);

  async function workflow(action:'rewrite'|'regenerate'|'save'|'send',extra:Record<string,unknown>={}){
    if(!draft||busy)return null;
    setBusy(action);setError('');setNotice('');
    try{
      const result=await assistant<any>('',{action,thread_id:draft.thread_id,draft_id:draft.id,request_id:crypto.randomUUID(),...extra});
      if(action==='send'){setNotice('Reply sent. It will appear in Sent Items shortly.');setDraft(null);onOutcome('sent');return result;}
      if(action==='save')setNotice('Draft saved.');
      await load(true);
      onOutcome('changed');
      return result;
    }catch(cause){setError(action==='send'?`${(cause as Error).message} Check Outlook Sent Items before trying again.`:`${(cause as Error).message} Your draft is preserved.`);return null;}
    finally{setBusy('');}
  }
  const save=()=>workflow('save',{body_text:body,body_html:''});
  async function rewrite(text:string){if(!text.trim())return;if(dirty&&!await save())return;if(await workflow('rewrite',{instruction:text}))setInstruction('');}
  async function writeAgain(){if(dirty&&!window.confirm('Write a completely new reply? Your edits to this draft will be replaced.'))return;await workflow('regenerate');}
  async function send(){
    if(dirty&&!await save())return;
    const attachments=await Promise.all(files.map(async file=>({name:file.name,content_type:file.type||'application/octet-stream',content_base64:await fileToBase64(file)})));
    // Send exactly the version on screen; after a save that is the freshly loaded one.
    await workflow('send',{attachments,updated_at:latest.current?.updated_at});
  }
  async function discard(){
    if(!draft||busy)return;
    if(dirty&&!window.confirm('Discard this draft and your unsaved edits?'))return;
    setBusy('discard');setError('');
    try{await assistant('',{action:'delete',draft_id:draft.id,updated_at:draft.updated_at});setDraft(null);setSavedBody('');setBody('');setNotice('Draft discarded. Restore it from Discarded AI drafts if needed.');onOutcome('discarded');}
    catch(cause){setError((cause as Error).message);}finally{setBusy('');}
  }
  async function draftWithAi(){
    if(!sourceMessageId||busy)return;
    setBusy('create');setError('');setNotice('');
    try{
      const prepared=await trackingRequest<any>('prepare_ai',{}, {message_id:sourceMessageId});
      if(prepared.needs_generation)await assistant('',{action:'regenerate',thread_id:prepared.draft.thread_id,draft_id:prepared.draft.id,request_id:crypto.randomUUID()});
      await load(true);onOutcome('changed');
    }catch(cause){setError((cause as Error).message);}finally{setBusy('');}
  }
  function addFiles(list:File[]){
    const next=[...files,...list];
    if(next.length>5||next.reduce((sum,file)=>sum+file.size,0)>3*1024*1024){setError('Attach up to five files, with a combined size under 3 MB.');return;}
    setError('');setFiles(next);
  }
  async function loadQuotations(){
    if(!quotationCustomerId)return;setBusy('quotation');setError('');
    try{const result=await crmRequest(`action=quotations&customer_id=${encodeURIComponent(quotationCustomerId)}`);setQuotations(result.records||[]);}
    catch(cause){setError((cause as Error).message);}finally{setBusy('');}
  }
  async function attachQuotation(quote:CustomerQuotation){
    setBusy('quotation');setError('');
    try{const pdf=await buildCustomerQuotationPdf(quote,await quotationLogo());addFiles([new File([pdf.output('blob')],`DCX-Estimate-${quote.estimate_number}.pdf`,{type:'application/pdf'})]);setQuotations(null);}
    catch(cause){setError((cause as Error).message);}finally{setBusy('');}
  }

  if(!loaded)return <section className="inline-ai-reply loading"><Sparkles size={15}/> Checking for an AI reply…</section>;
  if(!draft)return <section className="inline-ai-reply empty">
    {error&&<p role="alert" className="form-error">{error}</p>}{notice&&<p role="status" className="inline-ai-notice">{notice}</p>}
    <div className="inline-ai-empty-row"><span><Sparkles size={15}/> No AI reply for this conversation.</span>
      {sourceMessageId&&<button type="button" className="secondary" disabled={!!busy} onClick={()=>void draftWithAi()}>{busy==='create'?'Writing a reply…':'Draft a reply with AI'}</button>}
      {onNext&&<button type="button" className="text-button" onClick={onNext}>{nextLabel||'Next'} <ArrowRight size={14}/></button>}
    </div>
  </section>;
  return <section className="inline-ai-reply" aria-label="AI draft reply">
    <header><strong><Sparkles size={15}/> Draft reply</strong><span className={dirty?'unsaved':''}>{busy==='rewrite'||busy==='regenerate'?'AI is writing…':dirty?'Unsaved changes':'Ready to review'}</span></header>
    <p className="inline-ai-to">To: {draft.to_addresses.join(', ')}</p>
    {error&&<p role="alert" className="form-error">{error}</p>}{notice&&<p role="status" className="inline-ai-notice">{notice}</p>}
    <textarea ref={editor} aria-label="Edit AI reply draft" value={body} onChange={event=>setBody(event.target.value)} disabled={!!busy}/>
    <SignaturePreview/>
    <div className="inline-ai-tweaks"><span>Change it:</span>{quickChanges.map(label=><button type="button" key={label} className="chip" disabled={!!busy} onClick={()=>void rewrite(label)}>{label}</button>)}
      <form onSubmit={event=>{event.preventDefault();void rewrite(instruction);}}><input aria-label="Tell AI what to change" placeholder="Tell AI what to change…" value={instruction} onChange={event=>setInstruction(event.target.value)} disabled={!!busy}/><button type="submit" className="secondary compact" disabled={!!busy||!instruction.trim()}>Apply</button></form>
    </div>
    <div className="inline-ai-files">
      <label className="text-button"><Paperclip size={14}/> Attach files<input type="file" multiple hidden onChange={event=>{if(event.target.files)addFiles(Array.from(event.target.files));event.target.value='';}} disabled={!!busy}/></label>
      <select aria-label="Customer for saved quotation" value={quotationCustomerId} onChange={event=>{setQuotationCustomerId(event.target.value);setQuotations(null);}}><option value="">Attach a quotation for…</option>{customers.map(customer=><option key={customer.id} value={customer.id}>{customer.name}</option>)}</select>
      {quotationCustomerId&&!quotations&&<button type="button" className="text-button" disabled={!!busy} onClick={()=>void loadQuotations()}>{busy==='quotation'?'Loading…':'Choose quotation'}</button>}
      {quotations&&<select aria-label="Choose saved quotation to attach" value="" onChange={event=>{const quote=quotations.find(item=>item.id===event.target.value);if(quote)void attachQuotation(quote);}}><option value="">{quotations.length?'Choose a quotation PDF':'No saved quotations'}</option>{quotations.map(quote=><option key={quote.id} value={quote.id}>Estimate #{quote.estimate_number} - {quote.status}</option>)}</select>}
      {files.map((file,index)=><span className="inline-ai-file" key={`${file.name}-${index}`}>{file.name} ({Math.ceil(file.size/1024)} KB)<button type="button" aria-label={`Remove ${file.name}`} onClick={()=>setFiles(old=>old.filter((_,i)=>i!==index))}><X size={12}/></button></span>)}
    </div>
    <footer>
      <button type="button" className="primary" disabled={!!busy||!body.trim()} onClick={()=>void send()}><Send size={15}/>{busy==='send'?'Sending…':'Send'}</button>
      <button type="button" className="secondary" disabled={!!busy} onClick={()=>void discard()}><Trash2 size={15}/>{busy==='discard'?'Discarding…':'Discard draft'}</button>
      <button type="button" className="secondary" disabled={!!busy} onClick={()=>void writeAgain()}><RefreshCw size={15}/>{busy==='regenerate'?'Writing…':'Write again'}</button>
      {dirty&&<button type="button" className="secondary" disabled={!!busy||!body.trim()} onClick={()=>void save()}><Save size={15}/>{busy==='save'?'Saving…':'Save'}</button>}
      <span className="inline-ai-spacer"/>
      {onNext&&<button type="button" className="text-button" disabled={!!busy} onClick={()=>{if(!dirty||window.confirm('Leave this draft with unsaved changes?'))onNext();}}>{nextLabel||'Next'} <ArrowRight size={14}/></button>}
    </footer>
  </section>;
}
