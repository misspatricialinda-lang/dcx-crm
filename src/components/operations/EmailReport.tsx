import { useEffect, useState } from 'react';
import { trackingRequest } from '../../lib/email-tracking';

const timezone = 'America/Toronto';

export function EmailReport() {
  const [days,setDays]=useState('7');
  const [data,setData]=useState<any>(null), [error,setError]=useState('');
  useEffect(()=>{
    let active=true;setData(null);
    const load=()=>trackingRequest('report',{days,timezone}).then(result=>{if(active){setData(result);setError('');}}).catch(e=>{if(active)setError(e.message);});
    load(); const timer=setInterval(()=>{if(document.visibilityState==='visible')load();},30000);
    return()=>{active=false;clearInterval(timer);};
  },[days]);
  const r=data?.report;
  const complete=r?.folders?.filter((f:any)=>['inbox','sentitems'].includes(f.folder.toLowerCase()));
  return <section className="panel email-report">
    <div className="panel-heading"><h2>Email performance</h2><div className="button-row">
      <select aria-label="Email reporting period" value={days} onChange={e=>setDays(e.target.value)}><option value="1">Today</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option></select>
    </div></div>
    {error&&<p className="notice amber" role="alert">{error}</p>}
    {!r&&!error&&<p role="status">Loading email performance…</p>}
    {r&&<>
      {(complete?.length!==2||complete.some((f:any)=>!f.backfill_complete||f.last_error))&&<p className="notice amber">Counts may be incomplete. Finish syncing Inbox and Sent mail; check folder errors below.</p>}
      <div className="metric-grid">{[['Received',r.received],['Sent',r.sent],['Conversations replied',`${r.conversations_replied} / ${r.conversations_received}`],['Reply rate',r.reply_rate===null?'—':`${r.reply_rate}%`]].map(([label,value])=><div className="metric-card" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
    </>}
  </section>;
}
