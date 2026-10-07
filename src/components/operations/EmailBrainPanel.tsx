import { useEffect, useState } from 'react';
import DOMPurify from 'dompurify';
import { trackingRequest, type ThreadDetail, type TrackedMessage } from '../../lib/email-tracking';
import { crmRequest } from '../../lib/crm-client';

const roles=['employee','customer','lead','supplier','wholesale_partner'];
const topics=['support','upgrade','quotation','billing','meeting','incomplete_inquiry'];
const label=(value:string)=>String(value||'Needs review').replace(/_/g,' ');
// Day boundaries follow the workspace reporting timezone, not the viewer's computer.
const dayKey=(value:Date)=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',year:'numeric',month:'2-digit',day:'2-digit'}).format(value);
const periods=[['today','Today'],['7','7 days'],['30','30 days'],['90','90 days'],['all','All time']] as const;
const activity=(r:any)=>new Date(r.last_activity_at||r.occurred_at);
function inPeriod(r:any,period:string,from:string,to:string){
  const when=activity(r);if(Number.isNaN(when.getTime()))return period==='all';
  if(period==='today')return dayKey(when)===dayKey(new Date());
  if(period==='custom'){const [a,b]=from&&to&&from>to?[to,from]:[from,to],key=dayKey(when);return(!a||key>=a)&&(!b||key<=b);}
  return period==='all'||when.getTime()>=Date.now()-Number(period)*86400000;
}
const needsReview=(r:any)=>r.classification_state==='needs_review'||!r.role||!r.topic;
function Chips({name,value,options,counts,onChange}:{name:string;value:string;options:string[];counts:(v:string)=>number;onChange:(v:string)=>void}){
  return <div className="chip-row" role="group" aria-label={name}><span className="chip-label">{name}</span>
    {['all',...options,'none'].map(v=><button key={v} type="button" className={`chip${value===v?' active':''}${v==='none'?' review':''}`} aria-pressed={value===v} onClick={()=>onChange(value===v&&v!=='all'?'all':v)}>{v==='all'?'All':v==='none'?'Needs review':label(v)} <b>{counts(v)}</b></button>)}</div>;
}


export function EmailBrainPanel({navigate}:{navigate:(tab:string,id?:string)=>void}) {
  const [data,setData]=useState<any>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [role,setRole]=useState('all'),[topic,setTopic]=useState('all'),[review,setReview]=useState(false),[period,setPeriod]=useState('all'),[from,setFrom]=useState(''),[to,setTo]=useState(''),[status,setStatus]=useState('all');
  const [selected,setSelected]=useState<ThreadDetail|null>(null),[readerError,setReaderError]=useState(''),[readerBusy,setReaderBusy]=useState(false),[selectedId,setSelectedId]=useState(''),[search,setSearch]=useState('');
  useEffect(()=>{if(!selectedId)return;let current=true;setSelected(null);setReaderError('');setReaderBusy(true);trackingRequest<ThreadDetail>('thread',{id:selectedId,history:'1'}).then(result=>{if(current)setSelected(result);}).catch(e=>{if(current)setReaderError(e.message);}).finally(()=>{if(current)setReaderBusy(false);});return()=>{current=false;};},[selectedId]);
  async function older(){if(!selected?.next||readerBusy)return;setReaderBusy(true);try{const result=await trackingRequest<ThreadDetail>('thread',{id:selected.thread.id,history:'1',cursor:selected.next});setSelected({...selected,messages:[...selected.messages,...result.messages],next:result.next});}catch(e){setReaderError((e as Error).message);}finally{setReaderBusy(false);}}
  async function load(){try{const result=await crmRequest('action=email-brain');if(!result.categories||!Array.isArray(result.categories.records))throw new Error('Email categories are unavailable. Apply the email brain migrations.');setData(result);setError('');}catch(e){setError((e as Error).message);}}
  useEffect(()=>{void load();const timer=setInterval(()=>void load(),15000);return()=>clearInterval(timer);},[]);
  async function update(input:Record<string,unknown>){if(busy)return;setBusy(true);setError('');try{await crmRequest('action=email-brain',{method:'POST',body:JSON.stringify(input)});await load();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  const [people,setPeople]=useState<any[]>([]);
  useEffect(()=>{let active=true;const refresh=()=>trackingRequest<any>('correspondents').then(result=>{if(active)setPeople(result.people||[]);}).catch(()=>{});void refresh();const timer=setInterval(()=>void refresh(),30000);return()=>{active=false;clearInterval(timer);};},[]);
  const contactStats=new Map(people.map(p=>[String(p.email).toLowerCase(),p]));
  // Date, search and status narrow everything; each chip group counts within the other group's selection.
  const base=(data?.categories.records||[]).filter((r:any)=>inPeriod(r,period,from,to)&&(status==='all'||r.status===status)&&`${r.email} ${r.company} ${r.subject}`.toLowerCase().includes(search.toLowerCase()));
  const matchRole=(r:any,v:string)=>v==='all'||(v==='none'?!r.role:r.role===v),matchTopic=(r:any,v:string)=>v==='all'||(v==='none'?!r.topic:r.topic===v);
  const rows=base.filter((r:any)=>matchRole(r,role)&&matchTopic(r,topic)&&(!review||needsReview(r)));
  const showAll=()=>{setRole('all');setTopic('all');setReview(false);setStatus('all');setSearch('');};
  const card=(view:string)=>view==='all'?role==='all'&&topic==='all'&&!review:view==='review'?review&&role==='all'&&topic==='all':!review&&role==='all'&&topic===view;
  const choosePeriod=(value:string)=>{setPeriod(value);setFrom('');setTo('');};
  const chooseDay=(which:'from'|'to',value:string)=>{(which==='from'?setFrom:setTo)(value);setPeriod(value||(which==='from'?to:from)?'custom':'all');};
  const periodText=period==='custom'?(from&&to&&from!==to?`${from>to?to:from} to ${from>to?from:to}`:from||to?`${from||to}`:'All time'):period==='all'?'All time':period==='today'?'Today':`Last ${period} days`;
  const today=dayKey(new Date());
  return <section className="panel email-brain-panel"><div className="panel-heading"><div><h2>Email activity</h2></div><button className="secondary" onClick={()=>void load()} disabled={busy}>Refresh</button></div>
    {error&&<p role="alert" className="notice amber">{error}</p>}
    {data&&<><div className="email-dates" role="group" aria-label="Activity period"><div className="chip-row">{periods.map(([v,text])=><button key={v} type="button" className={`chip${period===v?' active':''}`} aria-pressed={period===v} onClick={()=>choosePeriod(v)}>{text}</button>)}</div><label>From<input type="date" aria-label="From date" max={today} value={from} onChange={e=>chooseDay('from',e.target.value)}/></label><label>To<input type="date" aria-label="To date" max={today} value={to} onChange={e=>chooseDay('to',e.target.value)}/></label></div>
    <div className="email-summary">{([['all',base.length,'All conversations'],['review',base.filter(needsReview).length,'Need classification review']] as const).map(([view,count,text])=><button key={view} type="button" className={card(view)?'active':''} aria-pressed={card(view)} onClick={()=>{showAll();if(view==='review')setReview(true);else if(view!=='all')setTopic(view);}}><strong>{count}</strong><span>{text}</span></button>)}</div>
    <Chips name="Relationship" value={role} options={roles} counts={v=>base.filter((r:any)=>matchRole(r,v)&&matchTopic(r,topic)&&(!review||needsReview(r))).length} onChange={v=>{setRole(v);setReview(false);}}/>
    <Chips name="Purpose" value={topic} options={topics} counts={v=>base.filter((r:any)=>matchTopic(r,v)&&matchRole(r,role)&&(!review||needsReview(r))).length} onChange={v=>{setTopic(v);setReview(false);}}/>
    <div className="email-filters"><label className="email-filter-search">Search<input placeholder="Sender, company or subject" value={search} onChange={e=>setSearch(e.target.value)}/></label><label>Status<select aria-label="Status" value={status} onChange={e=>setStatus(e.target.value)}><option value="all">All statuses</option>{Array.from(new Set<string>(data.categories.records.map((r:any)=>r.status).filter(Boolean))).map(v=><option key={v} value={v}>{label(v)}</option>)}</select></label></div>
    <div className="classification-toolbar"><span className="small muted"><strong>{rows.length}</strong> {rows.length===1?'conversation':'conversations'} · {periodText}{data.categories.records.length<data.categories.total?` · Latest ${data.categories.records.length} of ${data.categories.total} loaded`:''}</span><span className="button-row"><button type="button" className="secondary" disabled={card('all')&&status==='all'&&!search} onClick={showAll}>All conversations</button><button type="button" className="text-button" onClick={()=>{showAll();choosePeriod('all');}}>Clear all filters</button></span></div>
    <div className="table-scroll"><table className="email-activity-table"><thead><tr><th>Email</th><th>Classification</th><th>Status</th></tr></thead><tbody>{rows.map((r:any)=><tr key={r.thread_id}><td className="email-preview-cell"><button type="button" className="email-preview" onClick={()=>setSelectedId(r.thread_id)} aria-label={`View conversation: ${r.subject}`}><strong>{r.subject||'(no subject)'}</strong><span className="email-preview-text">{r.preview||'No message text saved.'}</span><small>{r.email}{r.company?` · ${r.company}`:''} · {activity(r).toLocaleDateString(undefined,{timeZone:'America/Toronto'})}</small></button></td><td><select aria-label={`Classify ${r.email}`} disabled={busy||String(r.email).toLowerCase().split('@')[1]==='dcx-tech.com'} value={r.role||''} onChange={e=>void update({operation:'role',email:r.email,role:e.target.value,company:r.company})}>{!r.role&&<option value="" disabled>{r.classification_state==='pending'?'Classifying…':'Needs review'}</option>}{roles.map(v=><option value={v} key={v}>{label(v)}</option>)}</select><select aria-label={`Category of ${r.subject}`} value={r.topic||''} disabled={busy} onChange={e=>void update({operation:'topic',thread_id:r.thread_id,topic:e.target.value})}>{!r.topic&&<option value="" disabled>{r.classification_state==='pending'?'Classifying…':'Needs review'}</option>}{topics.map(v=><option value={v} key={v}>{label(v)}</option>)}</select></td><td className="contact-activity-cell"><span className="status-label">{label(r.status)}</span>{contactStats.has(String(r.email).toLowerCase())&&<small>{contactStats.get(String(r.email).toLowerCase()).received} received · {contactStats.get(String(r.email).toLowerCase()).sent} sent</small>}</td></tr>)}</tbody></table></div>
    {!rows.length&&<p className="muted">No conversations match these filters.</p>}
    {selectedId&&<div className="modal-backdrop"><section className="detail-modal classified-reader" role="dialog" aria-modal="true" aria-label="Email conversation" tabIndex={-1} onKeyDown={e=>{if(e.key==='Escape')setSelectedId('');}}><div className="panel-heading"><h2>{selected?.thread.subject||'Email conversation'}</h2><button autoFocus className="secondary" onClick={()=>setSelectedId('')}>Close</button></div>{readerError&&<p role="alert" className="form-error">{readerError}</p>}{readerBusy&&!selected&&<p role="status">Loading conversation…</p>}{selected&&<><button className="secondary" onClick={()=>{navigate('inbox',selected.thread.id);setSelectedId('');}}>Open in Inbox to reply</button><p className="small muted">Saved conversation · {label(selected.thread.status)}</p>{selected.next&&<button className="secondary" disabled={readerBusy} onClick={()=>void older()}>Load older messages</button>}{[...selected.messages].reverse().map((m:TrackedMessage)=><article className="classified-message" key={m.id}><header><strong>{m.sender}</strong><time>{new Date(m.occurred_at).toLocaleString()}</time></header><p className="small muted">To: {m.to_addresses.join(', ')}{m.cc_addresses.length?' · Cc: '+m.cc_addresses.join(', '):''}</p>{!m.body_loaded&&<p className="notice amber">Only a preview is saved. Open this conversation in Inbox to load the full message.</p>}{m.body_html?<div className="classified-message-body" dangerouslySetInnerHTML={{__html:DOMPurify.sanitize(m.body_html,{FORBID_TAGS:['img','style','form','input','iframe'],FORBID_ATTR:['style']})}}/>:<p className="pre-line">{m.body_text||'No message text saved.'}</p>}{m.has_attachments&&<p className="small muted">Attachments: open in Inbox to view available files.</p>}</article>)}</>}</section></div>}
    </>}
  </section>;
}
