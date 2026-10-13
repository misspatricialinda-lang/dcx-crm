import { useEffect, useRef, useState } from 'react';
import { ArrowRight, MailX, MessageSquare, Paperclip, RefreshCw, Save, Send, Sparkles, Trash2, X } from 'lucide-react';
import type { Client } from '../../types/operations';
import { trackingRequest } from '../../lib/email-tracking';
import { crmRequest } from '../../lib/crm-client';
import { attachmentLimitError, uploadAttachment } from '../../lib/microsoft-mail';
import { SignatureField } from './EmailSignature';
import { buildCustomerQuotationPdf, quotationLogo, type CustomerQuotation } from '../../lib/customer-quotation';

type Draft = { id:string; thread_id:string; current_body:string; original_ai_body:string|null; to_addresses:string[]; status:string; updated_at:string };
export type ReplyOutcome = 'sent' | 'discarded' | 'changed';
type ChatTurn = { role:'owner'|'assistant'; text:string; changed?:boolean };

async function assistant<T>(query:string, body?:unknown):Promise<T> {
  const response = await fetch(`/api/email-assistant?${query}`, { credentials:'same-origin', cache:'no-store', ...(body ? { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'AI replies are unavailable.');
  return result;
}
const quickChanges = ['Shorter', 'More formal', 'Friendlier', 'Fix grammar'];
const addressesIn = (value:string) => value.split(/[;,\s]+/).map(item => item.trim()).filter(Boolean);
const validAddress = (value:string) => /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(value);

// The AI reply for one conversation, edited in place above the email like an Outlook inline reply.
export function InlineAiReply({ internetId, sourceMessageId, revision, customers, customerId, onDirty, onOutcome, onNext, nextLabel, onDeleteEmail }: {
  internetId?: string; sourceMessageId?: string; revision:number; customers:Client[]; customerId?:string;
  onDirty:(dirty:boolean)=>void; onOutcome:(outcome:ReplyOutcome)=>void; onNext?:()=>void; nextLabel?:string; onDeleteEmail?:()=>void;
}) {
  const [draft,setDraft]=useState<Draft|null>(null), [loaded,setLoaded]=useState(false);
  const [body,setBody]=useState(''), [savedBody,setSavedBody]=useState('');
  const [busy,setBusy]=useState(''), [error,setError]=useState(''), [notice,setNotice]=useState('');
  const [instruction,setInstruction]=useState(''), [files,setFiles]=useState<File[]>([]);
  const [signatureHtml,setSignatureHtml]=useState<string>();
  const [cc,setCc]=useState(''), [bcc,setBcc]=useState(''), [showCc,setShowCc]=useState(false), [showBcc,setShowBcc]=useState(false);
  // A short chat with the AI about this customer and draft, kept while this email is open.
  const [chat,setChat]=useState<ChatTurn[]>([]);
  const chatEnd=useRef<HTMLDivElement>(null);
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
    if(shownFor.current!==internetId){shownFor.current=internetId;setLoaded(false);setNotice('');setFiles([]);setQuotations(null);setChat([]);setCc('');setBcc('');setShowCc(false);setShowBcc(false);void load();}
    else if(!dirty&&!busy)void load(true);
  },[internetId,revision]);
  useEffect(()=>{const node=editor.current;if(node){node.style.height='auto';node.style.height=`${Math.max(node.scrollHeight,90)}px`;}},[body,draft?.id]);
  useEffect(()=>{chatEnd.current?.scrollIntoView({block:'nearest'});},[chat.length,busy]);

  async function workflow(action:'rewrite'|'regenerate'|'save'|'send'|'assist',extra:Record<string,unknown>={}){
    if(!draft||busy)return null;
    setBusy(action);setError('');setNotice('');
    try{
      const result=await assistant<any>('',{action,thread_id:draft.thread_id,draft_id:draft.id,request_id:crypto.randomUUID(),...extra});
      if(action==='send'){setNotice('Reply sent. It will appear in Sent Items shortly.');setDraft(null);onOutcome('sent');return result;}
      if(action==='save')setNotice('Draft saved.');
      if(action==='assist'&&result.kind==='answer')return result;
      await load(true);
      onOutcome('changed');
      return result;
    }catch(cause){setError(action==='send'?`${(cause as Error).message} Check Outlook Sent Items before trying again.`:`${(cause as Error).message} Your draft is preserved.`);return null;}
    finally{setBusy('');}
  }
  const save=()=>workflow('save',{body_text:body,body_html:''});
  async function rewrite(text:string){if(!text.trim())return;if(dirty&&!await save())return;await workflow('rewrite',{instruction:text});}
  // One box for both: questions are answered from this person's past emails and customer record;
  // instructions change the draft.
  async function ask(text:string){
    const message=text.trim();if(!message)return;
    if(dirty&&!await save())return;
    const earlier=chat.slice(-8).map(({role,text})=>({role,text}));
    setChat(old=>[...old,{role:'owner',text:message}]);setInstruction('');
    const result=await workflow('assist',{instruction:message,chat:earlier});
    if(!result){setChat(old=>[...old,{role:'assistant',text:'That did not work. Your draft is unchanged; try again.'}]);return;}
    setChat(old=>[...old,result.kind==='answer'?{role:'assistant',text:result.answer}:{role:'assistant',text:result.note?`Draft updated. ${result.note}`:'Draft updated.',changed:true}]);
  }
  async function writeAgain(){if(dirty&&!window.confirm('Write a completely new reply? Your edits to this draft will be replaced.'))return;await workflow('regenerate');}
  async function send(){
    if(!draft||busy)return;
    const ccList=showCc?addressesIn(cc):[], bccList=showBcc?addressesIn(bcc):[];
    const wrong=[...ccList,...bccList].find(item=>!validAddress(item));
    if(wrong){setError(`"${wrong}" is not a valid email address.`);return;}
    if(dirty&&!await save())return;
    // Files go into the Outlook reply first (large ones in chunks), then that same reply is sent.
    let staged:string|undefined;
    if(files.length){
      setBusy('upload');setError('');setNotice('');
      try{
        staged=(await assistant<{reply_id:string}>('',{action:'prepare-send',draft_id:draft.id,thread_id:draft.thread_id})).reply_id;
        const total=files.reduce((sum,file)=>sum+file.size,0);let done=0;
        for(const file of files){await uploadAttachment(staged,file,sent=>setNotice(`Uploading attachments… ${Math.round((done+sent)/total*100)}%`));done+=file.size;}
        setNotice('');
      }catch(cause){
        if(staged)void assistant('',{action:'discard-staged',reply_id:staged}).catch(()=>{});
        setNotice('');setError(`No email was sent: ${(cause as Error).message} Your draft is preserved.`);setBusy('');return;
      }
      setBusy('');
    }
    // Send exactly the version on screen; after a save that is the freshly loaded one.
    await workflow('send',{attachments:[],...(staged?{staged_reply_id:staged}:{}),cc:ccList,bcc:bccList,updated_at:latest.current?.updated_at,...(signatureHtml===undefined?{}:{signature_html:signatureHtml})});
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
    const limit=attachmentLimitError(next);
    if(limit){setError(limit);return;}
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
  const totalKb=Math.ceil(files.reduce((sum,file)=>sum+file.size,0)/1024);
  return <section className="inline-ai-reply" aria-label="AI draft reply">
    <header><strong><Sparkles size={15}/> Draft reply</strong><span className={dirty?'unsaved':''}>{['rewrite','regenerate','assist'].includes(busy)?'AI is working…':dirty?'Unsaved changes':'Ready to review'}</span></header>
    <div className="inline-ai-to"><span>To: {draft.to_addresses.join(', ')}</span>{!showCc&&<button type="button" className="text-button" onClick={()=>setShowCc(true)}>Cc</button>}{!showBcc&&<button type="button" className="text-button" onClick={()=>setShowBcc(true)}>Bcc</button>}</div>
    {showCc&&<label className="inline-ai-copy"><span>Cc</span><input aria-label="Cc recipients" placeholder="name@company.com, another@company.com" value={cc} onChange={event=>setCc(event.target.value)} disabled={!!busy}/><button type="button" className="text-button" aria-label="Remove Cc" onClick={()=>{setCc('');setShowCc(false);}}><X size={13}/></button></label>}
    {showBcc&&<label className="inline-ai-copy"><span>Bcc</span><input aria-label="Bcc recipients" placeholder="name@company.com" value={bcc} onChange={event=>setBcc(event.target.value)} disabled={!!busy}/><button type="button" className="text-button" aria-label="Remove Bcc" onClick={()=>{setBcc('');setShowBcc(false);}}><X size={13}/></button></label>}
    {error&&<p role="alert" className="form-error">{error}</p>}{notice&&<p role="status" className="inline-ai-notice">{notice}</p>}
    <div className="reply-canvas" onClick={event=>{if(event.target===event.currentTarget)editor.current?.focus();}}>
      <textarea ref={editor} aria-label="Edit AI reply draft" value={body} onChange={event=>setBody(event.target.value)} disabled={!!busy}/>
      <SignatureField key={draft.id} onChange={setSignatureHtml} disabled={!!busy}/>
    </div>
    <div className="inline-ai-tweaks"><span>Change it:</span>{quickChanges.map(label=><button type="button" key={label} className="chip" disabled={!!busy} onClick={()=>void rewrite(label)}>{label}</button>)}</div>
    <div className="inline-ai-chat" aria-label="Ask AI about this customer">
      {(!!chat.length||busy==='assist')&&<div className="inline-ai-chat-log" role="log">{chat.map((turn,index)=><p key={index} className={`chat-turn ${turn.role}${turn.changed?' changed':''}`}>{turn.text}</p>)}{busy==='assist'&&<p className="chat-turn assistant pending">Checking this customer's history…</p>}<div ref={chatEnd}/></div>}
      <form onSubmit={event=>{event.preventDefault();void ask(instruction);}}><MessageSquare size={15} aria-hidden="true"/><input aria-label="Ask AI or tell it what to change" placeholder="Ask about this customer (what did we quote last time?) or tell AI what to change…" value={instruction} onChange={event=>setInstruction(event.target.value)} disabled={!!busy}/><button type="submit" className="secondary compact" disabled={!!busy||!instruction.trim()}>{busy==='assist'?'Working…':'Ask'}</button></form>
      <small>Knows this conversation, this person's earlier emails with DCX and their customer record.</small>
    </div>
    <div className="inline-ai-files">
      <label className="text-button"><Paperclip size={14}/> Attach files<input type="file" multiple hidden onChange={event=>{if(event.target.files)addFiles(Array.from(event.target.files));event.target.value='';}} disabled={!!busy}/></label>
      <select aria-label="Customer for saved quotation" value={quotationCustomerId} onChange={event=>{setQuotationCustomerId(event.target.value);setQuotations(null);}}><option value="">Attach a quotation for…</option>{customers.map(customer=><option key={customer.id} value={customer.id}>{customer.name}</option>)}</select>
      {quotationCustomerId&&!quotations&&<button type="button" className="text-button" disabled={!!busy} onClick={()=>void loadQuotations()}>{busy==='quotation'?'Loading…':'Choose quotation'}</button>}
      {quotations&&<select aria-label="Choose saved quotation to attach" value="" onChange={event=>{const quote=quotations.find(item=>item.id===event.target.value);if(quote)void attachQuotation(quote);}}><option value="">{quotations.length?'Choose a quotation PDF':'No saved quotations'}</option>{quotations.map(quote=><option key={quote.id} value={quote.id}>Estimate #{quote.estimate_number} - {quote.status}</option>)}</select>}
      {files.map((file,index)=><span className="inline-ai-file" key={`${file.name}-${index}`}>{file.name} ({Math.ceil(file.size/1024)} KB)<button type="button" aria-label={`Remove ${file.name}`} onClick={()=>setFiles(old=>old.filter((_,i)=>i!==index))}><X size={12}/></button></span>)}
      {files.length>1&&<small className="inline-ai-file-total">{files.length} files · {totalKb>1024?`${(totalKb/1024).toFixed(1)} MB`:`${totalKb} KB`} of 25 MB</small>}
    </div>
    <footer>
      <button type="button" className="primary" disabled={!!busy||!body.trim()} onClick={()=>void send()}><Send size={15}/>{busy==='send'?'Sending…':busy==='upload'?'Uploading…':'Send'}</button>
      <button type="button" className="secondary" disabled={!!busy} onClick={()=>void discard()}><Trash2 size={15}/>{busy==='discard'?'Discarding…':'Discard draft'}</button>
      <button type="button" className="secondary" disabled={!!busy} onClick={()=>void writeAgain()}><RefreshCw size={15}/>{busy==='regenerate'?'Writing…':'Write again'}</button>
      {dirty&&<button type="button" className="secondary" disabled={!!busy||!body.trim()} onClick={()=>void save()}><Save size={15}/>{busy==='save'?'Saving…':'Save'}</button>}
      {onDeleteEmail&&<button type="button" className="secondary" disabled={!!busy} onClick={()=>{if(!dirty||window.confirm('Delete this email? Your unsaved edits to the draft will be lost.'))onDeleteEmail();}}><MailX size={15}/> Delete email</button>}
      <span className="inline-ai-spacer"/>
      {onNext&&<button type="button" className="text-button" disabled={!!busy} onClick={()=>{if(!dirty||window.confirm('Leave this draft with unsaved changes?'))onNext();}}>{nextLabel||'Next'} <ArrowRight size={14}/></button>}
    </footer>
  </section>;
}
