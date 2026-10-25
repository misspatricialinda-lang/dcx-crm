import { useEffect, useRef, useState } from 'react';
import { ArrowRight, FilePlus, MailX, MessageSquare, Mic, MicOff, Paperclip, RefreshCw, Save, Send, Sparkles, Trash2, Undo2, X } from 'lucide-react';
import type { Client } from '../../types/operations';
import { trackingRequest } from '../../lib/email-tracking';
import { crmRequest, toClient } from '../../lib/crm-client';
import { attachmentLimitError, uploadAttachment } from '../../lib/microsoft-mail';
import { SignatureField } from './EmailSignature';
import { buildCustomerQuotationPdf, quotationFileName, quotationLogo, type CustomerQuotation } from '../../lib/customer-quotation';
import { CustomerQuotations } from './CustomerQuotations';
import { useUndoHistory } from '../../lib/undo-history';

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
// Raza's cover note for a quote (from his sent mail): greeting, "see attached quote for…", a PO request
// for parts orders, "Kindly review…", "Thank you,". Prices stay in the PDF.
function coverNoteInstruction(quote:CustomerQuotation){
  const hour=Number(new Intl.DateTimeFormat('en-CA',{hour:'numeric',hourCycle:'h23',timeZone:'America/Toronto'}).format(new Date()));
  const greeting=hour<12?'Good Morning':hour<17?'Good Afternoon':'Good Evening';
  const items=quote.items.slice(0,12).map(item=>`${item.product_service}${item.description?` (${item.description.slice(0,120)})`:''} x ${item.quantity}`).join('; ');
  return [`Quotation PDF "${quotationFileName(quote)}" is attached to this reply. It covers: ${items}.`,
    `Rewrite the reply as Raza's usual short cover note for a quote: start with "${greeting} <first name of the person writing to us>,", then a sentence like "Please see attached quote for <what the quote covers, in plain words>."`,
    'If the quote is for batteries, parts or equipment DCX has to order, add "Please provide PO so I can order <the items>."',
    'Keep at most one or two short sentences from the current draft that answer something the customer asked. Then "Kindly review and let me know if you have any questions or concerns." and end with "Thank you,".',
    'Do not write any prices, totals, taxes or costs in the email; they are in the attached PDF.'].join(' ');
}
// Voice typing uses the browser's speech recognition (Chrome and Edge); the button is hidden elsewhere.
type Recognition = { lang:string; continuous:boolean; interimResults:boolean; start():void; stop():void;
  onresult:((event:{resultIndex:number; results:ArrayLike<ArrayLike<{transcript:string}>&{isFinal:boolean}>})=>void)|null; onend:(()=>void)|null; onerror:((event:{error:string})=>void)|null };
const SpeechRecognition:(new()=>Recognition)|undefined = typeof window==='undefined' ? undefined : (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
const learnCommand = /^\/learn(?![a-z])\s*/i;
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
  const editor=useRef<HTMLTextAreaElement>(null), askBox=useRef<HTMLTextAreaElement>(null);
  const [listening,setListening]=useState(false);
  const recognition=useRef<Recognition|null>(null);
  // "New quotation" opens the quotation editor here; a saved quote is attached and the draft becomes a cover note.
  const [quoteFor,setQuoteFor]=useState<Client|null>(null);
  // Customers added from this panel, before the app's customer list reloads.
  const [added,setAdded]=useState<Client[]>([]);
  const [newCustomer,setNewCustomer]=useState<{name:string;contact:string;email:string}|null>(null);
  const allCustomers=[...customers,...added.filter(item=>!customers.some(other=>other.id===item.id))];
  // Make quotation: the chosen customer, else the customer whose email sent this, else offer to add the sender.
  function makeQuotation(){
    const sender=(draft?.to_addresses[0]||'').toLowerCase();
    const match=allCustomers.find(item=>item.id===quotationCustomerId)||allCustomers.find(item=>item.id===customerId)||allCustomers.find(item=>sender&&item.email.toLowerCase()===sender);
    if(match){setQuotationCustomerId(match.id);setQuoteFor(match);return;}
    setNewCustomer({name:'',contact:'',email:sender});
  }
  async function addCustomer(){
    if(!newCustomer||!newCustomer.name.trim())return;
    setBusy('customer');setError('');
    try{
      const {record}=await crmRequest('entity=customers',{method:'POST',body:JSON.stringify({name:newCustomer.name.trim(),contact:newCustomer.contact.trim(),email:newCustomer.email.trim(),relationship_type:'customer'})});
      const client=toClient(record);
      setAdded(old=>[...old,client]);setQuotationCustomerId(client.id);setNewCustomer(null);setQuoteFor(client);
    }catch(cause){setError((cause as Error).message);}finally{setBusy('');}
  }
  const [undoBody,setUndoBody]=useState<{body:string;label:string}|null>(null);
  const dirty=!!draft&&body!==savedBody;
  const history=useUndoHistory(body,setBody,draft?.id);
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
    if(shownFor.current!==internetId){shownFor.current=internetId;setLoaded(false);setNotice('');setFiles([]);setQuotations(null);setChat([]);setUndoBody(null);setQuoteFor(null);setCc('');setBcc('');setShowCc(false);setShowBcc(false);void load();}
    else if(!dirty&&!busy)void load(true);
  },[internetId,revision]);
  useEffect(()=>{const node=editor.current;if(node){node.style.height='auto';node.style.height=`${Math.max(node.scrollHeight,90)}px`;}},[body,draft?.id]);
  useEffect(()=>{chatEnd.current?.scrollIntoView({block:'nearest'});},[chat.length,busy]);
  // The ask box grows with what is written, up to a limit, then scrolls.
  useEffect(()=>{const node=askBox.current;if(node){node.style.height='auto';node.style.height=`${Math.min(node.scrollHeight,220)}px`;}},[instruction]);
  useEffect(()=>()=>recognition.current?.stop(),[]);
  function toggleVoice(){
    if(listening){recognition.current?.stop();return;}
    if(!SpeechRecognition)return;
    const voice=new SpeechRecognition();
    const before=instruction.trimEnd();
    voice.lang=navigator.language||'en-CA';voice.continuous=true;voice.interimResults=true;
    voice.onresult=event=>{
      let spoken='';
      for(let i=0;i<event.results.length;i++)spoken+=event.results[i][0].transcript;
      setInstruction((before?`${before} `:'')+spoken.trim());
    };
    voice.onerror=event=>{if(event.error==='not-allowed')setError('Allow microphone access in the browser to speak instructions.');};
    voice.onend=()=>{setListening(false);recognition.current=null;askBox.current?.focus();};
    recognition.current=voice;setListening(true);voice.start();
  }

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
  async function rewrite(text:string){if(!text.trim())return null;if(dirty&&!await save())return null;return workflow('rewrite',{instruction:text});}
  // One box for both: questions are answered from this person's past emails and customer record;
  // instructions change the draft.
  async function ask(text:string){
    const message=text.trim();if(!message)return;
    recognition.current?.stop();
    const learn=learnCommand.exec(message);
    if(learn){await remember(message,message.slice(learn[0].length).trim());return;}
    if(dirty&&!await save())return;
    const earlier=chat.slice(-8).map(({role,text})=>({role,text}));
    setChat(old=>[...old,{role:'owner',text:message}]);setInstruction('');
    const result=await workflow('assist',{instruction:message,chat:earlier});
    if(!result){setChat(old=>[...old,{role:'assistant',text:'That did not work. Your draft is unchanged; try again.'}]);return;}
    setChat(old=>[...old,result.kind==='answer'?{role:'assistant',text:result.answer}:{role:'assistant',text:result.note?`Draft updated. ${result.note}`:'Draft updated.',changed:true}]);
  }
  // "/learn <rule>" saves a standing instruction that every future draft follows; it does not change this draft.
  async function remember(message:string,rule:string){
    setInstruction('');
    if(!rule){setChat(old=>[...old,{role:'owner',text:message},{role:'assistant',text:'Write the rule after /learn, for example: /learn Keep replies non-technical unless the customer asks for details.'}]);return;}
    if(busy)return;
    setChat(old=>[...old,{role:'owner',text:message}]);setBusy('learn');
    try{await assistant('',{action:'learn',rule,thread_id:draft?.thread_id,draft_id:draft?.id});setChat(old=>[...old,{role:'assistant',text:`Saved to memory: ${rule}
All future drafts will follow it.`,changed:true}]);}
    catch(cause){setChat(old=>[...old,{role:'assistant',text:`Not saved to memory: ${(cause as Error).message}`}]);}
    finally{setBusy('');}
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
    let attached=false;
    try{
      const pdf=await buildCustomerQuotationPdf(quote,await quotationLogo());
      const name=quotationFileName(quote);
      if(files.some(file=>file.name===name)){setNotice(`${name} is already attached.`);return;}
      addFiles([new File([pdf.output('blob')],name,{type:'application/pdf'})]);setQuotations(null);attached=true;
    }
    catch(cause){setError((cause as Error).message);}finally{setBusy('');}
    if(!attached)return;
    // Turn the draft into a cover note for the attached quote; the previous text can be restored.
    const before=body;
    if(await rewrite(coverNoteInstruction(quote))){setUndoBody({body:before,label:`Quote ${quote.estimate_number}`});setNotice(`Quote ${quote.estimate_number} attached and the reply rewritten as a cover note. Prices stay in the PDF.`);}
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
    {quoteFor&&<div className="modal-backdrop"><section className="detail-modal inline-quote-modal" role="dialog" aria-modal="true" aria-label={`Quotations for ${quoteFor.name}`}>
      <div className="panel-heading"><div><h2>Quotation for {quoteFor.name}</h2><p className="small muted">Save the quotation and it is attached to this reply as a PDF.</p></div><button type="button" className="text-button" onClick={()=>setQuoteFor(null)}><X size={16}/> Close</button></div>
      <CustomerQuotations customer={{id:quoteFor.id,name:quoteFor.name,contact:quoteFor.contact,email:quoteFor.email,billing_address:quoteFor.billingAddress}} preview={false} createNow onCreated={()=>{}} onSaved={record=>{setQuoteFor(null);void attachQuotation(record);}}/>
    </section></div>}
    <header><strong><Sparkles size={15}/> Draft reply</strong><span className={dirty?'unsaved':''}>{['rewrite','regenerate','assist'].includes(busy)?'AI is working…':dirty?'Unsaved changes':'Ready to review'}</span></header>
    <div className="inline-ai-to"><span>To: {draft.to_addresses.join(', ')}</span>{!showCc&&<button type="button" className="text-button" onClick={()=>setShowCc(true)}>Cc</button>}{!showBcc&&<button type="button" className="text-button" onClick={()=>setShowBcc(true)}>Bcc</button>}</div>
    {showCc&&<label className="inline-ai-copy"><span>Cc</span><input aria-label="Cc recipients" placeholder="name@company.com, another@company.com" value={cc} onChange={event=>setCc(event.target.value)} disabled={!!busy}/><button type="button" className="text-button" aria-label="Remove Cc" onClick={()=>{setCc('');setShowCc(false);}}><X size={13}/></button></label>}
    {showBcc&&<label className="inline-ai-copy"><span>Bcc</span><input aria-label="Bcc recipients" placeholder="name@company.com" value={bcc} onChange={event=>setBcc(event.target.value)} disabled={!!busy}/><button type="button" className="text-button" aria-label="Remove Bcc" onClick={()=>{setBcc('');setShowBcc(false);}}><X size={13}/></button></label>}
    {error&&<p role="alert" className="form-error">{error}</p>}{notice&&<p role="status" className="inline-ai-notice">{notice}{undoBody&&<button type="button" className="text-button" disabled={!!busy} onClick={()=>{setBody(undoBody.body);setUndoBody(null);setNotice('Previous text restored. The quote is still attached; remove it below if needed.');}}><Undo2 size={13}/> Undo rewrite</button>}</p>}
    <div className="reply-canvas" onClick={event=>{if(event.target===event.currentTarget)editor.current?.focus();}}>
      <textarea ref={editor} aria-label="Edit AI reply draft" value={body} onChange={event=>history.typed(event.target.value)} onKeyDown={history.onKeyDown} disabled={!!busy}/>
      <SignatureField key={draft.id} onChange={setSignatureHtml} disabled={!!busy}/>
    </div>
    <div className="inline-ai-tweaks"><span>Change it:</span>{quickChanges.map(label=><button type="button" key={label} className="chip" disabled={!!busy} onClick={()=>void rewrite(label)}>{label}</button>)}</div>
    <div className="inline-ai-chat" aria-label="Ask AI about this customer">
      {(!!chat.length||busy==='assist')&&<div className="inline-ai-chat-log" role="log">{chat.map((turn,index)=><p key={index} className={`chat-turn ${turn.role}${turn.changed?' changed':''}`}>{turn.text}</p>)}{busy==='assist'&&<p className="chat-turn assistant pending">Checking this customer's history…</p>}<div ref={chatEnd}/></div>}
      <form onSubmit={event=>{event.preventDefault();void ask(instruction);}}><MessageSquare size={15} aria-hidden="true"/>
        <textarea ref={askBox} rows={1} aria-label="Ask AI or tell it what to change" placeholder={listening?'Listening… speak your instruction':'Ask about this customer, tell AI what to change, or type /learn to teach it a rule'} value={instruction} onChange={event=>setInstruction(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();void ask(instruction);}}} disabled={!!busy}/>
        {SpeechRecognition&&<button type="button" className={`icon-button inline-ai-mic${listening?' listening':''}`} aria-label={listening?'Stop voice input':'Speak instead of typing'} aria-pressed={listening} title={listening?'Stop listening':'Speak instead of typing'} disabled={!!busy} onClick={toggleVoice}>{listening?<MicOff size={15}/>:<Mic size={15}/>}</button>}
        <button type="submit" className="secondary compact" disabled={!!busy||!instruction.trim()}>{busy==='assist'||busy==='learn'?'Working…':learnCommand.test(instruction.trim())?'Save':'Ask'}</button></form>
      {instruction.startsWith('/')&&!learnCommand.test(instruction)&&<button type="button" className="inline-ai-command" onClick={()=>{setInstruction('/learn ');askBox.current?.focus();}}><strong>/learn</strong> rule — save to the AI's memory for all future emails</button>}
      <small>Knows this conversation, this person's earlier emails with DCX and their customer record. Type <strong>/learn</strong> and a rule to make the AI remember it for every email. Shift+Enter adds a new line.</small>
    </div>
    <div className="inline-ai-files">
      <label className="text-button"><Paperclip size={14}/> Attach files<input type="file" multiple hidden onChange={event=>{if(event.target.files)addFiles(Array.from(event.target.files));event.target.value='';}} disabled={!!busy}/></label>
      <button type="button" className="secondary compact" disabled={!!busy} onClick={makeQuotation}><FilePlus size={14}/> Make quotation</button>
      <select aria-label="Customer for saved quotation" value={quotationCustomerId} onChange={event=>{setQuotationCustomerId(event.target.value);setQuotations(null);}}><option value="">Attach a saved quotation for…</option>{allCustomers.map(customer=><option key={customer.id} value={customer.id}>{customer.name}</option>)}</select>
      {quotationCustomerId&&!quotations&&<button type="button" className="text-button" disabled={!!busy} onClick={()=>void loadQuotations()}>{busy==='quotation'?'Loading…':'Choose quotation'}</button>}
      {newCustomer&&<form className="inline-ai-new-customer" onSubmit={event=>{event.preventDefault();void addCustomer();}}>
        <p>{newCustomer.email||'This sender'} is not a customer yet. Add them to make a quotation.</p>
        <label>Company or customer name<input aria-label="New customer name" required value={newCustomer.name} onChange={event=>setNewCustomer({...newCustomer,name:event.target.value})} placeholder="e.g. Front Street Offices"/></label>
        <label>Contact name<input aria-label="New customer contact" value={newCustomer.contact} onChange={event=>setNewCustomer({...newCustomer,contact:event.target.value})}/></label>
        <label>Email<input aria-label="New customer email" type="email" value={newCustomer.email} onChange={event=>setNewCustomer({...newCustomer,email:event.target.value})}/></label>
        <div className="btns"><button type="submit" className="primary compact" disabled={!!busy||!newCustomer.name.trim()}>{busy==='customer'?'Adding…':'Add customer and make quotation'}</button><button type="button" className="secondary compact" onClick={()=>setNewCustomer(null)}>Cancel</button></div>
      </form>}
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
