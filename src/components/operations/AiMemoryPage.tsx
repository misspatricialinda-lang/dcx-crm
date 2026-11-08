import { useEffect, useState } from 'react';
import { InfoTip } from './InfoTip';
import { Brain, Check, ExternalLink, Inbox, PackageSearch, Pencil, Plus, Search, Trash2, X } from 'lucide-react';

type Scope = 'customer'|'supplier';
type Rule = { id:string; rule:string; active:boolean; scope:Scope; source:'learn'|'chat'|'setup'; source_thread_id:string|null; created_by:string; created_at:string; updated_at:string; updated_by:string|null };

async function request<T>(query:string, body?:Record<string,unknown>):Promise<T> {
  const response = await fetch(`/api/email-assistant?${query}`, { credentials:'same-origin', cache:'no-store', ...(body ? { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) } : {}) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'AI memory is unavailable.');
  return result;
}
const sourceLabel = { learn:'Typed with /learn', chat:'From a correction', setup:'Added here' } as const;
const scopeLabel = { customer:'Inbox', supplier:'Supplier' } as const;
const scopeHelp = { customer:'Inbox replies to customers', supplier:'Price requests to suppliers' } as const;
const day = (iso:string) => new Date(iso).toLocaleDateString('en-CA', { month:'short', day:'numeric', year:'numeric', timeZone:'America/Toronto' });
const states = [['all','All'],['on','On'],['off','Off']] as const;
const places = [['all','Everywhere'],['customer','Inbox'],['supplier','Supplier']] as const;
type State = typeof states[number][0];
type Place = typeof places[number][0];

function ScopeTag({ scope }:{ scope:Scope }) {
  return <span className={`ai-memory-scope ${scope}`} title={scopeHelp[scope]}>{scope==='supplier'?<PackageSearch size={12}/>:<Inbox size={12}/>} {scopeLabel[scope]}</span>;
}

// Hidden page (#ai-memory, not in the menu): every standing rule the AI follows. Inbox rules lead every
// customer reply prompt; Supplier rules lead the Supplier quotes prompts only. Newest first; newer wins.
export function AiMemoryPage({ preview, onOpenInbox }: { preview:boolean; onOpenInbox:(threadId:string)=>void }) {
  const [rules,setRules]=useState<Rule[]|null>(null), [error,setError]=useState(''), [busy,setBusy]=useState('');
  const [adding,setAdding]=useState(''), [addScope,setAddScope]=useState<Scope>('customer');
  const [editing,setEditing]=useState<{id:string;text:string;scope:Scope}|null>(null);
  const [deleting,setDeleting]=useState(''), [search,setSearch]=useState(''), [state,setState]=useState<State>('all'), [place,setPlace]=useState<Place>(()=>{const tag=location.hash.slice(1).split('/')[1];return tag==='supplier'||tag==='customer'?tag:'all';});
  async function load(){
    if(preview){setRules([]);return;}
    try{setRules((await request<{rules:Rule[]}>('action=rules')).rules.map(r=>({...r,scope:r.scope||'customer'})));setError('');}catch(cause){setError((cause as Error).message);}
  }
  useEffect(()=>{void load();},[preview]);
  // #ai-memory/supplier or #ai-memory/customer opens the page on those rules (the AI memory buttons use it).
  useEffect(()=>{const follow=()=>{const tag=location.hash.slice(1).split('/')[1];if(tag==='supplier'||tag==='customer')setPlace(tag);};window.addEventListener('hashchange',follow);return()=>window.removeEventListener('hashchange',follow);},[]);
  async function run(key:string, body:Record<string,unknown>, after?:()=>void){
    if(busy)return;setBusy(key);setError('');
    try{await request('',body);after?.();await load();}catch(cause){setError((cause as Error).message);}finally{setBusy('');}
  }
  const all=rules||[];
  const inPlace=all.filter(r=>place==='all'||r.scope===place);
  const counts={all:inPlace.length,on:inPlace.filter(r=>r.active).length,off:inPlace.filter(r=>!r.active).length};
  const placeCounts={all:all.length,customer:all.filter(r=>r.scope==='customer').length,supplier:all.filter(r=>r.scope==='supplier').length};
  const visible=inPlace.filter(r=>(state==='all'||(state==='on')===r.active)&&r.rule.toLowerCase().includes(search.trim().toLowerCase()));
  // The order each AI reads its own rules in (1 = newest active rule of that kind).
  const rank=(r:Rule)=>all.filter(x=>x.active&&x.scope===r.scope).findIndex(x=>x.id===r.id)+1;
  return <section className="sq-page ai-memory-page">
    <div className="sq-hero">
      <div className="sq-hero-icon"><Brain size={26}/></div>
      <div><span className="sq-eyebrow">WHAT THE AI HAS LEARNED</span><h1>AI memory <InfoTip title="How AI memory works" label="How AI memory works"><p>Rules are short instructions the AI follows <b>every time</b> it writes. They are plain text, sent with each request, newest first; when two disagree, the newer one wins.</p><ul><li><b>Inbox</b> rules: replies to customers.</li><li><b>Supplier</b> rules: price requests in Supplier quotes.</li></ul><p>Rules are added when you correct the AI, type <b>/learn</b>, or add one here. Switch a rule off to pause it without deleting it.</p></InfoTip></h1><p>Rules that are on are followed every time, newest first. <b>Inbox</b> rules apply to replies to customers; <b>Supplier</b> rules apply only to price requests in Supplier quotes.</p></div>
    </div>
    {error&&<p className="form-error" role="alert">{error}</p>}
    {preview?<p className="sq-empty">AI memory needs the live database.</p>:<>
    <form className="panel ai-memory-add" onSubmit={event=>{event.preventDefault();const rule=adding.trim();if(rule.length>=3)void run('add',{action:'learn',rule,scope:addScope},()=>setAdding(''));}}>
      <label htmlFor="ai-memory-new">Teach the AI a new rule</label>
      <textarea id="ai-memory-new" rows={3} maxLength={1000} placeholder={addScope==='supplier'?"e.g. Ask suppliers for a quote in one or two lines. Don't ask for lead time or validity.":"e.g. For price requests, don't ask for delivery details. Say we are checking with our supplier."} value={adding} onChange={event=>setAdding(event.target.value)}/>
      <div className="ai-memory-add-row">
        <div className="ai-memory-where" role="radiogroup" aria-label="Where the rule applies">
          <span>Applies to</span>
          {(['customer','supplier'] as Scope[]).map(scope=><label key={scope} className={addScope===scope?'on':''}><input type="radio" name="ai-memory-scope" value={scope} checked={addScope===scope} onChange={()=>setAddScope(scope)}/>{scopeHelp[scope]}</label>)}
        </div>
        <button className="primary" disabled={adding.trim().length<3||!!busy}><Plus size={15}/> {busy==='add'?'Saving…':'Add rule'}</button>
      </div>
    </form>
    <div className="ai-memory-tools">
      <div className="ai-memory-filters">
        <div className="sq-filters" role="tablist" aria-label="Where rules apply">{places.map(([id,label])=><button key={id} role="tab" aria-selected={place===id} className={place===id?'active':''} onClick={()=>setPlace(id)}>{label}<b>{placeCounts[id]}</b></button>)}</div>
        <div className="sq-filters" role="tablist" aria-label="On or off">{states.map(([id,label])=><button key={id} role="tab" aria-selected={state===id} className={state===id?'active':''} onClick={()=>setState(id)}>{label}<b>{counts[id]}</b></button>)}</div>
      </div>
      <label className="ai-memory-search"><Search size={15} aria-hidden="true"/><input id="ai-memory-search" aria-label="Search rules" placeholder="Search rules" value={search} onChange={event=>setSearch(event.target.value)}/></label>
    </div>
    {!rules?<p className="sq-empty">Loading rules…</p>
      :!visible.length?<div className="sq-empty"><span><Brain size={26}/></span><h3>{all.length?'No rules match':'No rules yet'}</h3><p>{all.length?'Try another search or filter.':'Add one above, or correct an AI draft and the AI saves the rule here.'}</p></div>
      :<ol className="ai-memory-list">{visible.map(r=>
        <li key={r.id} className={`panel ${r.active?'':'off'}`}>
          <div className="ai-memory-rank" title={r.active?`Order the ${scopeLabel[r.scope]} AI reads it in (1 = newest)`:'Switched off'}>{r.active?rank(r):'Off'}</div>
          <div className="ai-memory-body">
            {editing?.id===r.id?<form onSubmit={event=>{event.preventDefault();void run('edit:'+r.id,{action:'rule-update',id:r.id,rule:editing.text,scope:editing.scope},()=>setEditing(null));}}>
              <textarea id={`ai-memory-edit-${r.id}`} aria-label="Edit rule" rows={3} maxLength={1000} value={editing.text} onChange={event=>setEditing({...editing,text:event.target.value})} autoFocus/>
              <label className="ai-memory-scope-select">Applies to<select id={`ai-memory-scope-${r.id}`} value={editing.scope} onChange={event=>setEditing({...editing,scope:event.target.value as Scope})}><option value="customer">{scopeHelp.customer}</option><option value="supplier">{scopeHelp.supplier}</option></select></label>
              <div className="button-row"><button className="primary compact" disabled={editing.text.trim().length<3||(editing.text.trim()===r.rule&&editing.scope===r.scope)||!!busy}><Check size={14}/> {busy==='edit:'+r.id?'Saving…':'Save'}</button><button type="button" className="secondary compact" onClick={()=>setEditing(null)}><X size={14}/> Cancel</button></div>
            </form>:<p className="ai-memory-text">{r.rule}</p>}
            <div className="ai-memory-meta">
              <ScopeTag scope={r.scope}/>
              <small>{sourceLabel[r.source]||'Saved'} · {day(r.created_at)}{r.updated_by?` · edited ${day(r.updated_at)}`:''}</small>
              {r.source_thread_id&&<button className="text-button" onClick={()=>onOpenInbox(r.source_thread_id!)}><ExternalLink size={13}/> Email it came from</button>}
            </div>
          </div>
          <div className="ai-memory-actions">
            {deleting===r.id?<span className="ai-memory-confirm">Delete?<button className="text-button danger" disabled={!!busy} onClick={()=>void run('delete:'+r.id,{action:'rule-delete',id:r.id},()=>setDeleting(''))}>{busy==='delete:'+r.id?'Deleting…':'Yes, delete'}</button><button className="text-button" onClick={()=>setDeleting('')}>Keep</button></span>:<>
              <label className="ai-memory-switch"><input type="checkbox" role="switch" checked={r.active} disabled={!!busy} onChange={event=>void run('toggle:'+r.id,{action:'rule-update',id:r.id,active:event.target.checked})}/><span>{r.active?'On':'Off'}</span></label>
              <button className="text-button" disabled={!!busy||editing?.id===r.id} onClick={()=>setEditing({id:r.id,text:r.rule,scope:r.scope})}><Pencil size={13}/> Edit</button>
              <button className="text-button" disabled={!!busy} onClick={()=>setDeleting(r.id)}><Trash2 size={13}/> Delete</button>
            </>}
          </div>
        </li>)}</ol>}
    </>}
  </section>;
}
