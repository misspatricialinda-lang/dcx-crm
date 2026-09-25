import { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { ArrowLeft, RefreshCw, Search, Inbox, Save, Send, Sparkles, Clock3, Paperclip } from 'lucide-react';
import type { Client } from '../../types/operations';
import { trackingRequest, trackingLabels, type TrackedThread, type TrackedMessage, type ThreadDetail } from '../../lib/email-tracking';

type Props = { focusId?: string; customers: Client[]; onQuote: (id:string)=>void; provider: string; onMailbox:()=>void };
const displayDate = (value: string) => new Date(value).toLocaleString('en-CA', { month:'short',day:'numeric',hour:'2-digit',minute:'2-digit' });
export function TrackedInbox({customers,provider,onMailbox,focusId}:Props) {
  const [filter,setFilter]=useState('all'), [query,setQuery]=useState(''), [records,setRecords]=useState<TrackedThread[]>([]);
  const [selected,setSelected]=useState(focusId || ''), [next,setNext]=useState<string|null>(null), [syncNext,setSyncNext]=useState<string|null>(null);
  const [folder,setFolder]=useState('inbox');
  const [loading,setLoading]=useState(false),[syncing,setSyncing]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [lastSync,setLastSync]=useState(''),[refresh,setRefresh]=useState(0),[automation,setAutomation]=useState(false);
  const [mailboxes,setMailboxes]=useState<{id:string;provider:string;address:string}[]>([]),[activeMailbox,setActiveMailbox]=useState('');
  const dirty=useRef(false), sequence=useRef(0);
  const leave=()=>!dirty.current || window.confirm('Discard unsaved conversation or reply changes?');
  async function load(cursor?:string) {
    const seq=++sequence.current;setLoading(true);setError('');
    try {
      const result=await trackingRequest('threads',{scope:'all',status:filter,q:query,...(cursor?{cursor}:{})});
      if(seq!==sequence.current)return;
      setRecords(old=>cursor?[...new Map([...old,...result.records].map(t=>[t.id,t])).values()]:result.records);
      setNext(result.next);setLastSync(result.mailbox.last_synced_at || '');setAutomation(result.automationEnabled);setMailboxes(result.mailboxes||[]);setActiveMailbox(result.mailbox.id);
    }catch(e){if(seq===sequence.current)setError((e as Error).message);}
    finally{if(seq===sequence.current)setLoading(false);}
  }
  useEffect(()=>{const timer=setTimeout(()=>load(),250);return()=>{clearTimeout(timer);sequence.current++;};},[filter,query,refresh]);
  useEffect(()=>{
    const timer=setInterval(()=>{if(document.visibilityState==='visible' && !dirty.current)setRefresh(v=>v+1);},30000);
    const guard=(event:Event)=>{if(!leave())event.preventDefault();};
    const unload=(event:BeforeUnloadEvent)=>{if(dirty.current){event.preventDefault();event.returnValue='';}};
    window.addEventListener('dcx-before-navigate',guard);window.addEventListener('beforeunload',unload);
    return()=>{clearInterval(timer);window.removeEventListener('dcx-before-navigate',guard);window.removeEventListener('beforeunload',unload);};
  },[]);
  async function sync(more=false) {
    if(syncing)return;setSyncing(true);setError('');setNotice('');
    try {const result=await trackingRequest('sync',{}, {folder,...(more && syncNext?{cursor:syncNext}:{})});setSyncNext(result.next);setNotice(`${result.processed} messages checked. ${result.next?'More history is available.':'This sync page is complete.'}`);setRefresh(v=>v+1);}
    catch(e){setError((e as Error).message);}finally{setSyncing(false);}
  }
  return <div className="tracking-workspace">
    <div className="page-heading"><div><p className="eyebrow">COMMUNICATIONS</p><h1>Conversations</h1><p>Stored conversations from all synced mailboxes. Replies use the active mailbox.</p></div><button className="secondary" onClick={()=>{if(leave())onMailbox();}}>Open mailbox</button></div>
    <div className="tracking-sync toolbar"><select aria-label="Folder to sync" value={folder} onChange={e=>{setFolder(e.target.value);setSyncNext(null);}} disabled={syncing}><option value="inbox">Inbox</option><option value="sentitems">Sent mail</option></select><button className="secondary" disabled={syncing} onClick={()=>sync()}><RefreshCw size={15}/>{syncing?'Syncing…':'Sync mail'}</button>{syncNext&&<button className="text-button" disabled={syncing} onClick={()=>sync(true)}>Import next page</button>}<span className="small muted">{lastSync?`Last sync ${displayDate(lastSync)}`:'Sync to start tracking your messages.'}</span></div>
    {error&&<div className="notice amber" role="alert">{error}<button className="text-button" onClick={()=>setRefresh(v=>v+1)}>Retry</button></div>}{notice&&<p className="notice" role="status">{notice}</p>}
    <div className="tracking-layout">
      <aside className="tracking-filters"><small>YOUR WORK</small>{Object.entries(trackingLabels).map(([key,label])=><button key={key} className={filter===key?'active':''} onClick={()=>{if(leave()){dirty.current=false;setSelected('');setFilter(key);}}}>{key==='due'?<Clock3 size={15}/>:<Inbox size={15}/>} {label}</button>)}</aside>
      <section className="tracking-list"><div className="search-field"><Search size={15}/><input aria-label="Search tracked conversations" placeholder="Search subject…" value={query} onChange={e=>{if(leave()){dirty.current=false;setQuery(e.target.value);setSelected('');}}}/></div>
        <div className="list-caption"><strong>{trackingLabels[filter]}</strong><button className="text-button" disabled={loading} onClick={()=>setRefresh(v=>v+1)}>Refresh</button></div>
        {records.map(t=><button className={`tracking-thread ${t.id===selected?'active':''}`} key={t.id} onClick={()=>{if(t.id!==selected&&leave()){dirty.current=false;setSelected(t.id);}}}><div><strong>{customers.find(c=>c.id===t.customer_id)?.name||'Customer not linked'}</strong><time>{displayDate(t.last_message_at)}</time></div><h3>{t.subject}</h3><p>{t.next_action||'Review conversation'}</p><footer><span className={`pill ${t.priority==='high'?'red':'neutral'}`}>{trackingLabels[t.status]}</span><small>{mailboxes.find(box=>box.id===t.mailbox_id)?.address||'Stored mailbox'}</small>{t.followup_at&&<small>Follow up {displayDate(t.followup_at)}</small>}</footer></button>)}
        {!records.length&&!loading&&<div className="empty-state"><Inbox size={28}/><p>{error?'Tracking is unavailable.':'No conversations in this view.'}</p>{!error&&<small>Sync your inbox to import real messages.</small>}</div>}
        {loading&&<p role="status" className="small muted padded">Loading conversations…</p>}{next&&<button className="secondary full" disabled={loading} onClick={()=>load(next)}>Load more conversations</button>}
      </section>
      {selected?<TrackedConversation key={selected} id={selected} history={records.find(t=>t.id===selected)?.mailbox_id!==activeMailbox} source={mailboxes.find(box=>box.id===records.find(t=>t.id===selected)?.mailbox_id)?.address||''} automation={automation} onDirty={v=>{dirty.current=v;}} onChange={()=>setRefresh(v=>v+1)} onBack={()=>{if(leave()){dirty.current=false;setSelected('');}}}/>:<section className="tracking-detail empty-state"><Inbox size={32}/><h2>Select a conversation</h2><p>Read the history and prepare a reply.</p></section>}
    </div>
  </div>;
}
function TrackedConversation({id,history,source,automation,onDirty,onChange,onBack}:{id:string;history:boolean;source:string;automation:boolean;onDirty:(v:boolean)=>void;onChange:()=>void;onBack:()=>void}) {
  const [detail,setDetail]=useState<ThreadDetail|null>(null),[body,setBody]=useState('');
  const [dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [review,setReview]=useState<any>(null);const mounted=useRef(true), editEpoch=useRef(0), loadSequence=useRef(0);
  useEffect(()=>{onDirty(dirty||busy);},[dirty,busy]);
  async function load(quiet=false){
    const epoch=editEpoch.current, seq=++loadSequence.current;
    try{const result=await trackingRequest<ThreadDetail>('thread',{id,...(history?{history:'1'}:{})});if(!mounted.current||epoch!==editEpoch.current||seq!==loadSequence.current)return;setDetail(result);if(!quiet){setBody(result.draft?.current_body||'');setDirty(false);}setError('');}
    catch(e){if(mounted.current)setError((e as Error).message);}
  }
  useEffect(()=>{mounted.current=true;load();return()=>{mounted.current=false;};},[id]);
  useEffect(()=>{const timer=setInterval(()=>{if(!dirty&&!busy&&!review&&document.visibilityState==='visible')load();},30000);return()=>clearInterval(timer);},[dirty,busy,review]);
  async function run(task:()=>Promise<void>){if(busy)return;setBusy(true);setError('');setNotice('');try{await task();onChange();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  const draft=detail?.draft;
  const locked=!!draft&&['sending','submitted','uncertain'].includes(draft.status);
  const incoming=detail?.reply_target || detail?.messages.find(m=>m.direction==='incoming');
  const activeJob=detail?.jobs.some(j=>j.kind==='generate_draft'&&['queued','running'].includes(j.status));
  if(!detail)return <section className="tracking-detail"><p role={error?'alert':'status'}>{error||'Loading conversation…'}</p><button className="secondary" onClick={()=>load()}>Retry</button></section>;
  return <section className="tracking-detail">
    <header><button className="text-button" onClick={onBack}><ArrowLeft size={14}/> All conversations</button><h2>{detail.thread.subject}</h2></header>
    {detail.readOnly&&<p className="notice">Stored history from {source||'another mailbox'}. Connect that mailbox to reply or open original messages.</p>}
    {error&&<p className="notice amber" role="alert">{error} Unsaved edits are retained.</p>}{notice&&<p className="notice" role="status">{notice}</p>}
    {detail.thread.summary&&<section className="tracking-summary"><strong><Sparkles size={15}/> AI summary</strong><p>{detail.thread.summary}</p>{detail.thread.summary_message_version!==detail.thread.message_version&&<small>New messages arrived after this summary. Review the conversation below.</small>}</section>}
    <div className="tracking-history"><h3>Conversation</h3>{detail.next&&<button className="text-button" disabled={busy} onClick={()=>run(async()=>{const older=await trackingRequest<ThreadDetail>('thread',{id,cursor:detail.next!,...(history?{history:'1'}:{})});setDetail(d=>({...d!,messages:[...new Map([...d!.messages,...older.messages].map(m=>[m.id,m])).values()],next:older.next}));})}>Load older messages</button>}
      {[...detail.messages].reverse().map(m=><TrackedMessageCard key={m.id} message={m} threadId={id} readOnly={!!detail.readOnly} onLoad={message=>setDetail(d=>({...d!,messages:d!.messages.map(m=>m.id===message.id?message:m)}))}/>)}
    </div>
    {!detail.readOnly&&<section className="tracking-reply"><div className="panel-heading"><h3>Reply draft</h3><span className="pill neutral">{dirty?'Unsaved edits':draft?draft.status==='editing'?'Saved':draft.status:'No saved draft'}</span></div>
      <p className="small muted">To: {draft?.to_addresses.join(', ')||incoming?.sender||'Select an incoming conversation'}</p>
      {draft&&draft.source_message_version!==detail.thread.message_version&&<p className="notice amber">The conversation has changed. Review the latest messages, then save and review your reply again.</p>}
      {locked&&<p className="notice amber">{draft?.status==='submitted'?'The mailbox accepted this reply. Delivery is not yet confirmed.':'This send needs checking.'} Sync Sent mail and confirm the matching copy below. Repeated sending is blocked.</p>}
      <textarea aria-label="Tracked reply draft" rows={8} maxLength={50000} disabled={busy||locked} value={body} placeholder="Write your reply, or request a draft from automation…" onChange={e=>{editEpoch.current++;setBody(e.target.value);setDirty(true);setReview(null);}}/>
      <div className="button-row"><button className="secondary" disabled={busy||locked||!body.trim()||!incoming} onClick={()=>run(async()=>{await trackingRequest('save_draft',{}, {thread_id:id,reply_to_message_id:incoming!.id,revision:draft?.revision||0,body});await load();setNotice('Draft saved to shared history.');})}><Save size={14}/> Save draft</button>
        <button className="secondary" disabled={busy||locked||dirty||activeJob||!automation} title={!automation?'The n8n drafting worker needs configuration.':undefined} onClick={()=>run(async()=>{await trackingRequest('queue_draft',{}, {thread_id:id,request_id:crypto.randomUUID()});await load();setNotice('Draft requested. It will appear here when the automation worker completes it.');})}><Sparkles size={14}/>{activeJob?'Draft requested':'Generate draft'}</button>
        <button className="primary" disabled={busy||locked||dirty||!draft} onClick={()=>run(async()=>{const result=await trackingRequest('review',{}, {draft_id:draft!.id,revision:draft!.revision});setReview(result.review);})}><Send size={14}/> Review & send</button></div>
      {!automation&&<p className="field-help">AI drafting becomes available after the n8n worker is configured. Manual drafts can be saved now.</p>}
      {draft?.original_ai_body&&<details><summary>Original AI draft</summary><p className="pre-line">{draft.original_ai_body}</p></details>}
      {locked&&<div className="tracking-sent-confirm"><label>Confirm the matching sent copy<select aria-label="Sent message to confirm" defaultValue="" disabled={busy} onChange={e=>{const messageId=e.target.value;if(messageId&&window.confirm('Confirm that this is the sent copy of this exact draft?'))run(async()=>{await trackingRequest('confirm_sent',{}, {draft_id:draft!.id,message_id:messageId});await load();setNotice('Sent copy linked to the draft.');});}}><option value="">Choose a synced outgoing message</option>{detail.messages.filter(m=>m.direction==='outgoing').map(m=><option key={m.id} value={m.id}>{displayDate(m.occurred_at)} · {m.subject}</option>)}</select></label></div>}
    </section>}
    <section className="tracking-activity"><h3>Activity & automation</h3>{detail.jobs.filter(j=>j.status==='failed'||j.status==='uncertain'||j.status==='queued'||j.status==='running').map(j=><p className="notice" key={j.id}>{j.kind==='generate_draft'?'Draft preparation':'Email dispatch'} · {j.status}{j.error?` — ${j.error}`:''}</p>)}{detail.activity.map(a=><div className="tracking-event" key={a.id}><span><strong>{a.action.replace(/_/g,' ')}</strong><small>{a.actor}</small></span><time>{displayDate(a.created_at)}</time></div>)}</section>
    {review&&<div className="modal-backdrop"><section className="detail-modal" role="dialog" aria-modal="true" aria-label="Review tracked reply"><div className="panel-heading"><h2>Review before sending</h2><button className="text-button" disabled={busy} onClick={()=>setReview(null)}>Close</button></div><p><strong>To:</strong> {review.to.join(', ')}</p><p><strong>Subject:</strong> {review.subject}</p><p className="pre-line tracking-review-body">{review.body}</p><p className="small muted">No attachments. This sends a real email. Review expires {displayDate(review.expires_at)}.</p><button className="primary" disabled={busy} onClick={()=>run(async()=>{try{const result=await trackingRequest('send',{}, {draft_id:review.draft_id,revision:review.revision});setNotice(result.message);}finally{setReview(null);await load();}})}><Send size={15}/>{busy?'Submitting…':'Send this reply'}</button></section></div>}
  </section>;
}
function TrackedMessageCard({message:m,threadId,readOnly,onLoad}:{message:TrackedMessage;threadId:string;readOnly:boolean;onLoad:(m:TrackedMessage)=>void}) {
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[attachments,setAttachments]=useState<any[]>([]);
  async function expand(){setOpen(v=>!v);if(open||busy)return;setBusy(true);setError('');try{if(!readOnly&&(!m.body_loaded||m.has_attachments)){const result=await trackingRequest('hydrate',{}, {thread_id:threadId,message_id:m.id});onLoad(result.message);setAttachments(result.attachments);}}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <article className={`tracking-message ${m.direction}`}><button className="tracking-message-heading" onClick={expand} aria-expanded={open}><span><strong>{m.sender||'Unknown sender'}</strong><small>{m.direction==='outgoing'?'Sent':'Received'} · {displayDate(m.occurred_at)}</small></span>{m.has_attachments&&<Paperclip size={15}/>}<span>{open?'−':'+'}</span></button>{open&&<div className="tracking-message-body">{busy?<p role="status">Loading original message…</p>:error?<p role="alert">{error}</p>:m.body_html?<div dangerouslySetInnerHTML={{__html:DOMPurify.sanitize(m.body_html,{FORBID_TAGS:['img','style','iframe','form','input','video','audio','svg'],FORBID_ATTR:['style']})}}/>:<p className="pre-line">{m.body_text}</p>}{attachments.map(a=><a className="secondary compact" key={a.id} href={`/api/tracking?action=attachment&id=${encodeURIComponent(a.id)}`}><Paperclip size={13}/>{a.name}</a>)}</div>}</article>;
}
