import { useEffect, useRef, useState } from 'react';
import { BellRing, CheckCircle2, Clock3, ExternalLink, Mail, PackageSearch, Plus, RefreshCw, Send, Sparkles, Trash2, X } from 'lucide-react';

type Supplier = { id: string; name: string; contact: string | null; email: string };
type Recipient = {
  id: string; rfq_id: string; supplier_name: string; supplier_email: string; subject: string; body: string;
  status: 'draft' | 'sending' | 'sent' | 'uncertain' | 'replied'; sent_at: string | null; replied_at: string | null; last_reply_at: string | null;
  supplier_thread_id: string | null; reply_text: string; price: string; lead_time: string; reply_notes: string; reply_read_at: string | null;
  nudge_count: number; last_nudged_at: string | null; error: string | null; updated_at: string;
};
type Rfq = { id: string; number: number; reference: string; thread_id: string | null; customer_label: string; title: string; request_text: string; status: 'draft' | 'open' | 'closed'; created_at: string; recipients: Recipient[] };
type Data = { suppliers: Supplier[]; rfqs: Rfq[] };

async function api<T>(action: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(body ? '/api/email-assistant' : `/api/email-assistant?action=${action}`, { credentials: 'same-origin', cache: 'no-store', ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...body }) } : {}) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Supplier quotes are unavailable.');
  return result;
}

// Toronto time, since that is where DCX works.
const when = (iso: string) => new Date(iso).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Toronto' });
const waited = (iso: string) => { const hours = Math.floor((Date.now() - Date.parse(iso)) / 3600000); return hours < 1 ? 'under an hour' : hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} days`; };
const replied = (r: Rfq) => r.recipients.filter(x => x.status === 'replied').length;
const sentCount = (r: Rfq) => r.recipients.filter(x => x.status !== 'draft').length;
const reminderText = (r: Recipient, ref: string) => `Hello,\n\nJust following up on our price request (${ref}) sent ${new Date(r.sent_at || r.updated_at).toLocaleDateString('en-CA', { month: 'long', day: 'numeric', timeZone: 'America/Toronto' })}. Could you let us know your price and lead time when you have a chance?\n\nThank you,`;

const filters = [['waiting', 'Waiting on suppliers'], ['replied', 'All replied'], ['draft', 'Not sent'], ['closed', 'Closed'], ['all', 'All']] as const;
type Filter = typeof filters[number][0];
const matches = (r: Rfq, f: Filter) => f === 'all' || (f === 'closed' ? r.status === 'closed' : f === 'draft' ? r.status === 'draft' : r.status === 'open' && (f === 'replied' ? replied(r) === sentCount(r) : replied(r) < sentCount(r)));

export function SupplierQuotes({ preview, onOpenInbox }: { preview: boolean; onOpenInbox: (threadId: string) => void }) {
  const [data, setData] = useState<Data>({ suppliers: [], rfqs: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  // "Ask suppliers" in the inbox opens this page at #suppliers/ask/<email id>.
  const [ask, setAsk] = useState<{ internetId: string } | null>(() => {
    const [, mode, id] = location.hash.slice(1).split('/');
    return mode === 'ask' && id ? { internetId: decodeURIComponent(id) } : null;
  });
  const [composer, setComposer] = useState(!!ask);
  const reading = useRef(new Set<string>());

  async function load() {
    if (preview) { setLoading(false); return; }
    try { setData(await api<Data>('rfq-list')); setError(''); }
    catch (cause) { setError((cause as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    if (ask) history.replaceState(null, '', '#suppliers');
    void load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 30000);
    return () => clearInterval(timer);
  }, [preview]);
  // New replies are read by the AI once, one at a time, to fill in price and lead time.
  useEffect(() => {
    const next = data.rfqs.flatMap(r => r.recipients).find(x => x.status === 'replied' && !x.reply_read_at && !reading.current.has(x.id));
    if (!next) return;
    reading.current.add(next.id);
    void api('rfq-read-reply', { id: next.id }).then(load).catch(() => {});
  }, [data]);

  async function run(key: string, action: string, body: Record<string, unknown>, after?: (result: any) => void) {
    if (busy) return;
    setBusy(key); setError('');
    try { const result = await api<any>(action, body); after?.(result); await load(); }
    catch (cause) { setError((cause as Error).message); await load(); }
    finally { setBusy(''); }
  }

  const visible = data.rfqs.filter(r => matches(r, filter));
  return <section className="sq-page">
    <div className="sq-hero">
      <div className="sq-hero-icon"><PackageSearch size={26}/></div>
      <div><span className="sq-eyebrow">PRICE REQUESTS TO SUPPLIERS</span><h1>Supplier quotes</h1><p>Ask several suppliers at once and see who has answered.</p></div>
      <div className="sq-hero-actions">
        <button className="secondary compact" onClick={() => void load()} disabled={loading} aria-label="Refresh"><RefreshCw size={16}/></button>
        <button className="primary" onClick={() => { setAsk(null); setComposer(true); }}><Plus size={16}/> New request</button>
      </div>
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {composer && <NewRequest suppliers={data.suppliers} source={ask} busy={busy === 'create'} onCancel={() => { setComposer(false); setAsk(null); }}
      onCreate={body => run('create', 'rfq-create', body, () => { setComposer(false); setAsk(null); setFilter('all'); })}/>}
    <div className="sq-filters" role="tablist">{filters.map(([id, label]) => <button key={id} role="tab" aria-selected={filter === id} className={filter === id ? 'active' : ''} onClick={() => setFilter(id)}>{label}<b>{data.rfqs.filter(r => matches(r, id)).length}</b></button>)}</div>
    {loading ? <p className="sq-empty">Loading supplier requests…</p>
      : preview ? <p className="sq-empty">Supplier quotes need the live database.</p>
      : !visible.length ? <div className="sq-empty"><span><Mail size={26}/></span><h3>No requests here</h3><p>Open a customer's email in the Inbox and choose <b>Ask suppliers</b>, or start a new request.</p></div>
      : visible.map(r => <RfqCard key={r.id} rfq={r} busy={busy} run={run} onOpenInbox={onOpenInbox}/>)}
  </section>;
}

function NewRequest({ suppliers, source, busy, onCancel, onCreate }: { suppliers: Supplier[]; source: { internetId: string } | null; busy: boolean; onCancel: () => void; onCreate: (body: Record<string, unknown>) => void }) {
  const [request, setRequest] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  useEffect(() => { if (!chosen.length && suppliers.length) setChosen(suppliers.map(s => s.id)); }, [suppliers]);
  const toggle = (id: string) => setChosen(list => list.includes(id) ? list.filter(x => x !== id) : [...list, id]);
  const ready = chosen.length > 0 && (!!source || request.trim().length > 2);
  return <div className="sq-new panel">
    <div className="sq-new-head"><h2>{source ? 'Ask suppliers about this email' : 'New price request'}</h2><button className="text-button" onClick={onCancel} aria-label="Close"><X size={16}/></button></div>
    {source && <p className="field-help">The AI reads the customer's email and writes the request. The customer's name and details are never included.</p>}
    <label className="sq-label">{source ? 'Anything to add? (optional)' : 'What do you need priced?'}
      <textarea rows={3} value={request} onChange={e => setRequest(e.target.value)} placeholder={source ? 'e.g. Ask for genuine APC batteries only' : 'e.g. 4 × 12V 9Ah batteries for an APC SRT3000'}/></label>
    <div className="sq-label">Send to
      {!suppliers.length ? <p className="field-help">No suppliers yet. Add a customer with the type <b>Supplier</b> and an email address on the Customers page.</p>
        : <div className="sq-suppliers">{suppliers.map(s => <label key={s.id} className={chosen.includes(s.id) ? 'on' : ''}><input type="checkbox" checked={chosen.includes(s.id)} onChange={() => toggle(s.id)}/><span><b>{s.name}</b><small>{s.email}</small></span></label>)}</div>}
    </div>
    <div className="sq-new-actions"><button className="primary" disabled={!ready || busy} onClick={() => onCreate({ supplier_ids: chosen, request, ...(source ? { internet_message_id: source.internetId } : {}) })}><Sparkles size={15}/> {busy ? 'Writing emails…' : `Write ${chosen.length} email${chosen.length === 1 ? '' : 's'}`}</button><small>Nothing is sent until you review and click Send.</small></div>
  </div>;
}

function RfqCard({ rfq, busy, run, onOpenInbox }: { rfq: Rfq; busy: string; run: (key: string, action: string, body: Record<string, unknown>, after?: (result: any) => void) => Promise<void>; onOpenInbox: (threadId: string) => void }) {
  const drafts = rfq.recipients.filter(x => x.status === 'draft');
  const total = sentCount(rfq), answered = replied(rfq);
  return <article className={`sq-card panel ${rfq.status}`}>
    <header className="sq-card-head">
      <div>
        <span className="sq-ref">{rfq.reference}</span>
        <h2>{rfq.title}</h2>
        <p>{rfq.customer_label ? <>For <b>{rfq.customer_label}</b> · </> : null}Created {when(rfq.created_at)}{rfq.thread_id && <> · <button className="text-button" onClick={() => onOpenInbox(rfq.thread_id!)}>Customer email <ExternalLink size={12}/></button></>}</p>
      </div>
      <div className="sq-card-status">
        {rfq.status === 'draft' ? <span className="pill neutral">Not sent</span>
          : <span className={`pill ${answered === total ? 'sq-done' : 'sq-wait'}`}>{answered} of {total} replied</span>}
        {rfq.status === 'draft'
          ? <button className="text-button" disabled={!!busy} onClick={() => { if (confirm('Delete this unsent request?')) void run('close', 'rfq-close', { rfq_id: rfq.id, closed: true }); }}><Trash2 size={14}/> Delete</button>
          : <button className="text-button" disabled={!!busy} onClick={() => void run('close', 'rfq-close', { rfq_id: rfq.id, closed: rfq.status !== 'closed' })}>{rfq.status === 'closed' ? 'Reopen' : 'Close'}</button>}
      </div>
    </header>
    {drafts.length > 0 && <div className="sq-drafts">
      {drafts.map(d => <DraftEmail key={d.id + d.updated_at} draft={d} busy={busy} run={run} canRemove={rfq.recipients.length > 1}/>)}
      <div className="sq-send"><button className="primary" disabled={!!busy} onClick={() => void run('send:' + rfq.id, 'rfq-send', { rfq_id: rfq.id })}><Send size={15}/> {busy === 'send:' + rfq.id ? 'Sending…' : `Send to ${drafts.length} supplier${drafts.length === 1 ? '' : 's'}`}</button><small>Each supplier gets their own email from your Outlook mailbox, with your signature.</small></div>
    </div>}
    {total > 0 && <div className="sq-table" role="table">
      <div className="sq-row sq-row-head" role="row"><span>Supplier</span><span>Sent</span><span>Reply</span><span>Price</span><span>Lead time</span><span/></div>
      {rfq.recipients.filter(x => x.status !== 'draft').map(x => <SupplierRow key={x.id} rfq={rfq} row={x} busy={busy} run={run} onOpenInbox={onOpenInbox}/>)}
    </div>}
  </article>;
}

function DraftEmail({ draft, busy, run, canRemove }: { draft: Recipient; busy: string; run: (key: string, action: string, body: Record<string, unknown>) => Promise<void>; canRemove: boolean }) {
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const dirty = subject !== draft.subject || body !== draft.body;
  return <details className="sq-draft">
    <summary><Mail size={14}/> <b>{draft.supplier_name}</b> <small>{draft.supplier_email}</small>{draft.error && <span className="sq-error">{draft.error}</span>}</summary>
    <label className="sq-label">Subject<input value={subject} onChange={e => setSubject(e.target.value)}/></label>
    <label className="sq-label">Message<textarea rows={10} value={body} onChange={e => setBody(e.target.value)}/></label>
    <div className="sq-draft-actions">
      <button className="secondary compact" disabled={!dirty || !!busy} onClick={() => void run('save:' + draft.id, 'rfq-save', { id: draft.id, subject, body })}>{busy === 'save:' + draft.id ? 'Saving…' : 'Save changes'}</button>
      {canRemove && <button className="text-button" disabled={!!busy} onClick={() => void run('remove:' + draft.id, 'rfq-remove', { id: draft.id })}><Trash2 size={14}/> Don't send to this supplier</button>}
    </div>
  </details>;
}

function SupplierRow({ rfq, row, busy, run, onOpenInbox }: { rfq: Rfq; row: Recipient; busy: string; run: (key: string, action: string, body: Record<string, unknown>) => Promise<void>; onOpenInbox: (threadId: string) => void }) {
  const [open, setOpen] = useState<'' | 'reply' | 'nudge'>('');
  const [reminder, setReminder] = useState('');
  const [facts, setFacts] = useState({ price: row.price, lead_time: row.lead_time, notes: row.reply_notes });
  useEffect(() => setFacts({ price: row.price, lead_time: row.lead_time, notes: row.reply_notes }), [row.price, row.lead_time, row.reply_notes]);
  const isReplied = row.status === 'replied';
  return <>
    <div className={`sq-row ${row.status}`} role="row">
      <span className="sq-supplier">{isReplied ? <CheckCircle2 size={16} className="sq-ok"/> : <Clock3 size={16} className="sq-pending"/>}<span><b>{row.supplier_name}</b><small>{row.supplier_email}</small></span></span>
      <span data-label="Sent">{row.sent_at ? when(row.sent_at) : row.status === 'uncertain' ? <em className="sq-error">Not confirmed: check Sent Items</em> : '—'}{row.nudge_count > 0 && <small>Reminded {row.nudge_count}× · {when(row.last_nudged_at!)}</small>}</span>
      <span data-label="Reply">{isReplied ? when(row.replied_at!) : row.sent_at ? <em>Waiting · {waited(row.sent_at)}</em> : '—'}</span>
      <span data-label="Price">{isReplied ? (row.reply_read_at ? row.price || <em>Not stated</em> : <em>Reading…</em>) : ''}</span>
      <span data-label="Lead time">{isReplied && row.reply_read_at ? row.lead_time || <em>Not stated</em> : ''}</span>
      <span className="sq-actions">
        {isReplied && <button className="secondary compact" onClick={() => setOpen(open === 'reply' ? '' : 'reply')}>{open === 'reply' ? 'Hide' : 'View'}</button>}
        {row.status === 'sent' && <button className="text-button" onClick={() => { setReminder(reminder || reminderText(row, rfq.reference)); setOpen(open === 'nudge' ? '' : 'nudge'); }}><BellRing size={14}/> Remind</button>}
      </span>
    </div>
    {open === 'reply' && <div className="sq-detail">
      <div className="sq-facts">
        <label className="sq-label">Price<input value={facts.price} onChange={e => setFacts({ ...facts, price: e.target.value })}/></label>
        <label className="sq-label">Lead time<input value={facts.lead_time} onChange={e => setFacts({ ...facts, lead_time: e.target.value })}/></label>
        <label className="sq-label sq-wide">Notes<input value={facts.notes} onChange={e => setFacts({ ...facts, notes: e.target.value })}/></label>
        <button className="secondary compact" disabled={!!busy || (facts.price === row.price && facts.lead_time === row.lead_time && facts.notes === row.reply_notes)} onClick={() => void run('correct:' + row.id, 'rfq-correct', { id: row.id, ...facts })}>Save</button>
      </div>
      <p className="field-help">Filled in by the AI from the reply. Check it against the email below.</p>
      <pre className="sq-reply">{row.reply_text || 'The reply is still being read…'}</pre>
      <div className="sq-draft-actions">
        {row.supplier_thread_id && <button className="text-button" onClick={() => onOpenInbox(row.supplier_thread_id!)}><ExternalLink size={14}/> Open in Inbox</button>}
        <button className="text-button" disabled={!!busy} onClick={() => void run('read:' + row.id, 'rfq-read-reply', { id: row.id })}><Sparkles size={14}/> {busy === 'read:' + row.id ? 'Reading…' : 'Read again'}</button>
      </div>
    </div>}
    {open === 'nudge' && <div className="sq-detail">
      <label className="sq-label">Reminder to {row.supplier_name}<textarea rows={6} value={reminder} onChange={e => setReminder(e.target.value)}/></label>
      <div className="sq-draft-actions"><button className="primary compact" disabled={!!busy || !reminder.trim()} onClick={() => void run('nudge:' + row.id, 'rfq-nudge', { id: row.id, body: reminder }).then(() => setOpen(''))}><Send size={14}/> {busy === 'nudge:' + row.id ? 'Sending…' : 'Send reminder'}</button></div>
    </div>}
  </>;
}
