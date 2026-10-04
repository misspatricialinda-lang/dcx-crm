import { useEffect, useState } from 'react';

export function InboxAiDraft({ internetId, revision }: { internetId?: string; revision: number }) {
  const [draft,setDraft]=useState<any>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{
    let active=true;setDraft(null);setError('');
    if(internetId)void fetch(`/api/email-assistant?action=for-message&internet_message_id=${encodeURIComponent(internetId)}`,{cache:'no-store'}).then(async response=>{const result=await response.json();if(!response.ok)throw new Error(result.error);if(active)setDraft(result.draft);}).catch(e=>{if(active)setError(e.message);});
    return()=>{active=false;};
  },[internetId,revision]);
  async function remove(){
    if(!draft||busy)return;setBusy(true);setError('');
    try {const response=await fetch('/api/email-assistant',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'delete',draft_id:draft.id,updated_at:draft.updated_at})});const result=await response.json();if(!response.ok)throw new Error(result.error);setDraft(null);}catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  if(!draft&&!error)return null;
  return <section className="panel"><div className="panel-heading"><strong>AI reply draft</strong></div>{error&&<p role="alert" className="form-error">{error}</p>}{draft&&<><p className="small muted">To: {draft.to_addresses.join(', ')}</p><p className="pre-line">{draft.current_body}</p><div className="button-row"><button className="primary" onClick={()=>window.dispatchEvent(new CustomEvent('dcx-open-ai',{detail:draft.thread_id}))}>Review / edit AI reply</button><button className="secondary" disabled={busy} onClick={()=>void remove()}>Delete AI draft</button></div></>}</section>;
}
