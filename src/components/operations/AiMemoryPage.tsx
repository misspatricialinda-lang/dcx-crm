import { useEffect, useState } from 'react';
import { Brain, Check, ExternalLink, Pencil, Plus, Search, Trash2, X } from 'lucide-react';

type Rule = { id:string; rule:string; active:boolean; source:'learn'|'chat'|'setup'; source_thread_id:string|null; created_by:string; created_at:string; updated_at:string; updated_by:string|null };

async function request<T>(query:string, body?:Record<string,unknown>):Promise<T> {
  const response = await fetch(`/api/email-assistant?${query}`, { credentials:'same-origin', cache:'no-store', ...(body ? { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) } : {}) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'AI memory is unavailable.');
  return result;
}
const sourceLabel = { learn:'Typed with /learn', chat:'From a draft correction', setup:'Added here' } as const;
const day = (iso:string) => new Date(iso).toLocaleDateString('en-CA', { month:'short', day:'numeric', year:'numeric', timeZone:'America/Toronto' });
const filters = [['all','All'],['on','On'],['off','Off']] as const;
type Filter = typeof filters[number][0];

// Hidden page (#ai-memory, not in the menu): every standing rule the email AI follows. Active rules are
// sent at the top of every AI prompt, newest first; a newer rule wins when two conflict.
export function AiMemoryPage({ preview, onOpenInbox }: { preview:boolean; onOpenInbox:(threadId:string)=>void }) {
  const [rules,setRules]=useState<Rule[]|null>(null), [error,setError]=useState(''), [busy,setBusy]=useState('');
  const [adding,setAdding]=useState(''), [editing,setEditing]=useState<{id:string;text:string}|null>(null);
  const [deleting,setDeleting]=useState(''), [search,setSearch]=useState(''), [filter,setFilter]=useState<Filter>('all');
  async function load(){
    if(preview){setRules([]);return;}
    try{setRules((await request<{rules:Rule[]}>('action=rules')).rules);setError('');}catch(cause){setError((cause as Error).message);}
  }
  useEffect(()=>{void load();},[preview]);
  async function run(key:string, body:Record<string,unknown>, after?:()=>void){
    if(busy)return;setBusy(key);setError('');
    try{await request('',body);after?.();await load();}catch(cause){setError((cause as Error).message);}finally{setBusy('');}
  }
  const all=rules||[];
  const counts={all:all.length,on:all.filter(r=>r.active).length,off:all.filter(r=>!r.active).length};
  const visible=all.filter(r=>(filter==='all'||(filter==='on')===r.active)&&r.rule.toLowerCase().includes(search.trim().toLowerCase()));
  return <section className="sq-page ai-memory-page">
    <div className="sq-hero">
      <div className="sq-hero-icon"><Brain size={26}/></div>
      <div><span className="sq-eyebrow">WHAT THE EMAIL AI HAS LEARNED</span><h1>AI memory</h1><p>Every rule that is on is followed in every email the AI writes, newest first. When two rules disagree, the newer one wins.</p></div>
    </div>
    {error&&<p className="form-error" role="alert">{error}</p>}
    {preview?<p className="sq-empty">AI memory needs the live database.</p>:<>
    <form className="panel ai-memory-add" onSubmit={event=>{event.preventDefault();const rule=adding.trim();if(rule.length>=3)void run('add',{action:'learn',rule},()=>setAdding(''));}}>
      <label htmlFor="ai-memory-new">Teach the AI a new rule</label>
      <textarea id="ai-memory-new" rows={3} maxLength={1000} placeholder="e.g. For price requests, don't ask for delivery details. Say we are checking with our supplier and will get back to them." value={adding} onChange={event=>setAdding(event.target.value)}/>
      <div className="ai-memory-add-row"><small>Write it as an instruction that applies to every email. {adding.length}/1000</small><button className="primary" disabled={adding.trim().length<3||!!busy}><Plus size={15}/> {busy==='add'?'Saving…':'Add rule'}</button></div>
    </form>
    <div className="ai-memory-tools">
      <div className="sq-filters" role="tablist">{filters.map(([id,label])=><button key={id} role="tab" aria-selected={filter===id} className={filter===id?'active':''} onClick={()=>setFilter(id)}>{label}<b>{counts[id]}</b></button>)}</div>
      <label className="ai-memory-search"><Search size={15} aria-hidden="true"/><input id="ai-memory-search" aria-label="Search rules" placeholder="Search rules" value={search} onChange={event=>setSearch(event.target.value)}/></label>
    </div>
    {!rules?<p className="sq-empty">Loading rules…</p>
      :!visible.length?<div className="sq-empty"><span><Brain size={26}/></span><h3>{all.length?'No rules match':'No rules yet'}</h3><p>{all.length?'Try another search or filter.':'Add one above, or correct an AI draft in the Inbox and choose Remember.'}</p></div>
      :<ol className="ai-memory-list">{visible.map(r=>{
        const position=all.filter(x=>x.active).findIndex(x=>x.id===r.id);
        return <li key={r.id} className={`panel ${r.active?'':'off'}`}>
          <div className="ai-memory-rank" title={r.active?'Order the AI reads it in (1 = newest)':'Switched off'}>{r.active?position+1:'Off'}</div>
          <div className="ai-memory-body">
            {editing?.id===r.id?<form onSubmit={event=>{event.preventDefault();void run('edit:'+r.id,{action:'rule-update',id:r.id,rule:editing.text},()=>setEditing(null));}}>
              <textarea id={`ai-memory-edit-${r.id}`} aria-label="Edit rule" rows={3} maxLength={1000} value={editing.text} onChange={event=>setEditing({id:r.id,text:event.target.value})} autoFocus/>
              <div className="button-row"><button className="primary compact" disabled={editing.text.trim().length<3||editing.text.trim()===r.rule||!!busy}><Check size={14}/> {busy==='edit:'+r.id?'Saving…':'Save'}</button><button type="button" className="secondary compact" onClick={()=>setEditing(null)}><X size={14}/> Cancel</button></div>
            </form>:<p className="ai-memory-text">{r.rule}</p>}
            <div className="ai-memory-meta">
              <small>{sourceLabel[r.source]||'Saved'} · {day(r.created_at)}{r.updated_by?` · edited ${day(r.updated_at)}`:''}</small>
              {r.source_thread_id&&<button className="text-button" onClick={()=>onOpenInbox(r.source_thread_id!)}><ExternalLink size={13}/> Email it came from</button>}
            </div>
          </div>
          <div className="ai-memory-actions">
            {deleting===r.id?<span className="ai-memory-confirm">Delete?<button className="text-button danger" disabled={!!busy} onClick={()=>void run('delete:'+r.id,{action:'rule-delete',id:r.id},()=>setDeleting(''))}>{busy==='delete:'+r.id?'Deleting…':'Yes, delete'}</button><button className="text-button" onClick={()=>setDeleting('')}>Keep</button></span>:<>
              <label className="ai-memory-switch"><input type="checkbox" role="switch" checked={r.active} disabled={!!busy} onChange={event=>void run('toggle:'+r.id,{action:'rule-update',id:r.id,active:event.target.checked})}/><span>{r.active?'On':'Off'}</span></label>
              <button className="text-button" disabled={!!busy||editing?.id===r.id} onClick={()=>setEditing({id:r.id,text:r.rule})}><Pencil size={13}/> Edit</button>
              <button className="text-button" disabled={!!busy} onClick={()=>setDeleting(r.id)}><Trash2 size={13}/> Delete</button>
            </>}
          </div>
        </li>;})}</ol>}
    </>}
  </section>;
}
