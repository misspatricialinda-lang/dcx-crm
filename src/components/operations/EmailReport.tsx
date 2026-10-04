import { useEffect, useState } from 'react';
import { trackingRequest } from '../../lib/email-tracking';

const timezone = 'America/Toronto';

export function EmailReport() {
  const [days,setDays]=useState('7');
  const [from,setFrom]=useState(new Intl.DateTimeFormat('en-CA',{timeZone:timezone}).format(new Date())),[through,setThrough]=useState('');
  const [data,setData]=useState<any>(null), [error,setError]=useState('');
  useEffect(()=>{
    let active=true;setData(null);
    const custom=days==='custom'||days==='day';
    if(custom&&(!from||(days==='custom'&&!through))){setError('Choose the reporting dates.');return;}
    const params=custom?{days:'7',timezone,from,through:days==='day'?from:through}:{days,timezone};
    const load=()=>trackingRequest('report',params).then(result=>{if(active){setData(result);setError('');}}).catch(e=>{if(active)setError(e.message);});
    load(); const timer=setInterval(()=>{if(document.visibilityState==='visible')load();},30000);
    return()=>{active=false;clearInterval(timer);};
  },[days,from,through]);
  const r=data?.report;
  return <section className="panel email-report">
    <div className="panel-heading"><h2>Email performance</h2><div className="button-row">
      <select aria-label="Email reporting period" value={days} onChange={e=>setDays(e.target.value)}><option value="1">Today</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="day">Specific day</option><option value="custom">Custom date range</option></select>
      {(days==='day'||days==='custom')&&<label>{days==='day'?'Date':'From'} <input type="date" aria-label={days==='day'?'Reporting date':'Report from date'} value={from} onChange={e=>setFrom(e.target.value)}/></label>}
      {days==='custom'&&<label>Through <input type="date" aria-label="Report through date" min={from} value={through} onChange={e=>setThrough(e.target.value)}/></label>}
    </div></div>
    {error&&<p className="notice amber" role="alert">{error}</p>}
    {!r&&!error&&<p role="status">Loading email performance…</p>}
    {r&&<>
      <div className="metric-grid">{[['Received',r.received],['Sent',r.sent],['Conversations replied',`${r.conversations_replied} / ${r.conversations_received}`],['Reply rate',r.reply_rate===null?'—':`${r.reply_rate}%`]].map(([label,value])=><div className="metric-card" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
    </>}
  </section>;
}
