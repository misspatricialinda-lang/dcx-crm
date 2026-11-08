import { useEffect, useRef, useState } from 'react';
import { BellRing, Check, CheckCircle2, Clock3, Copy, ExternalLink, Mail, PackageSearch, Plus, Send, Sparkles, Trash2, Users, X } from 'lucide-react';

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
  const [managing, setManaging] = useState(false);
  const [notice, setNotice] = useState('');
  // The inbox links a supplier email to its request at #suppliers/rfq/<id>.
  const [focus] = useState(() => { const [, mode, id] = location.hash.slice(1).split('/'); return mode === 'rfq' ? id || '' : ''; });
  const reading = useRef(new Set<string>());

  async function load() {
    if (preview) { setLoading(false); return; }
    try { setData(await api<Data>('rfq-list')); setError(''); }
    catch (cause) { setError((cause as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    if (ask || focus) history.replaceState(null, '', '#suppliers');
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
        <button className="secondary sq-manage" onClick={() => setManaging(!managing)} aria-expanded={managing}><Users size={16}/> Suppliers <b>{data.suppliers.length}</b></button>
        <button className="primary" onClick={() => { setAsk(null); setComposer(true); }}><Plus size={16}/> New request</button>
      </div>
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {notice && <p className="sq-notice" role="status"><Sparkles size={14}/> {notice} <button className="text-button" onClick={() => setNotice('')} aria-label="Dismiss"><X size={13}/></button></p>}
    {managing && <SupplierList suppliers={data.suppliers} busy={busy} run={run} onClose={() => setManaging(false)}/>}
    {composer && <NewRequest suppliers={data.suppliers} source={ask} busy={busy === 'create'} onCancel={() => { setComposer(false); setAsk(null); }}
      onCreate={body => run('create', 'rfq-create', body, () => { setComposer(false); setAsk(null); setFilter('all'); })}/>}
    <div className="sq-filters" role="tablist">{filters.map(([id, label]) => <button key={id} role="tab" aria-selected={filter === id} className={filter === id ? 'active' : ''} onClick={() => setFilter(id)}>{label}<b>{data.rfqs.filter(r => matches(r, id)).length}</b></button>)}</div>
    {loading ? <p className="sq-empty">Loading supplier requests…</p>
      : preview ? <p className="sq-empty">Supplier quotes need the live database.</p>
      : !visible.length ? <div className="sq-empty"><span><Mail size={26}/></span><h3>No requests here</h3><p>Open a customer's email in the Inbox and choose <b>Ask suppliers</b>, or start a new request.</p></div>
      : visible.map(r => <RfqCard key={r.id} rfq={r} busy={busy} run={run} onOpenInbox={onOpenInbox} focused={r.id === focus} onNotice={setNotice}/>)}
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
      {!suppliers.length ? <p className="field-help">No suppliers yet. Add them with the <b>Suppliers</b> button above.</p>
        : <div className="sq-suppliers">{suppliers.map(s => <label key={s.id} className={chosen.includes(s.id) ? 'on' : ''}><input type="checkbox" checked={chosen.includes(s.id)} onChange={() => toggle(s.id)}/><span><b>{s.name}</b><small>{s.email}</small></span></label>)}</div>}
    </div>
    <div className="sq-new-actions"><button className="primary" disabled={!ready || busy} onClick={() => onCreate({ supplier_ids: chosen, request, ...(source ? { internet_message_id: source.internetId } : {}) })}><Sparkles size={15}/> {busy ? 'Writing emails…' : `Write ${chosen.length} email${chosen.length === 1 ? '' : 's'}`}</button><small>Nothing is sent until you review and click Send.</small></div>
  </div>;
}

// Add or remove the suppliers price requests go to. Saved in the database, so every device sees the same list.
function SupplierList({ suppliers, busy, run, onClose }: { suppliers: Supplier[]; busy: string; run: (key: string, action: string, body: Record<string, unknown>, after?: (result: any) => void) => Promise<void>; onClose: () => void }) {
  const [form, setForm] = useState({ name: '', contact: '', email: '' });
  const valid = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(form.email.trim());
  return <div className="sq-new panel sq-manager">
    <div className="sq-new-head"><h2>Suppliers</h2><button className="text-button" onClick={onClose} aria-label="Close"><X size={16}/></button></div>
    <p className="field-help">Price requests can go to everyone on this list. Changes are saved for all devices.</p>
    <form className="sq-add" onSubmit={event => { event.preventDefault(); if (valid) void run('supplier-add', 'rfq-supplier-add', form, () => setForm({ name: '', contact: '', email: '' })); }}>
      <label className="sq-label">Email<input type="email" inputMode="email" autoComplete="off" required value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="sales@supplier.com"/></label>
      <label className="sq-label">Company<input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Battery Depot"/></label>
      <label className="sq-label">Contact name<input value={form.contact} onChange={e => setForm({ ...form, contact: e.target.value })} placeholder="Optional"/></label>
      <button className="primary" disabled={!valid || !!busy}><Plus size={15}/> {busy === 'supplier-add' ? 'Adding…' : 'Add supplier'}</button>
    </form>
    {!suppliers.length ? <p className="field-help">No suppliers yet.</p>
      : <ul className="sq-supplier-list">{suppliers.map(s => <li key={s.id}>
        <span><b>{s.name}</b><small>{s.contact ? `${s.contact} · ` : ''}{s.email}</small></span>
        <button className="text-button" disabled={!!busy} aria-label={`Remove ${s.name}`} onClick={() => { if (confirm(`Remove ${s.name} (${s.email}) from suppliers? Past requests keep their emails. You can restore it from the Customers trash.`)) void run('supplier-remove:' + s.id, 'rfq-supplier-remove', { id: s.id }); }}><Trash2 size={14}/> {busy === 'supplier-remove:' + s.id ? 'Removing…' : 'Remove'}</button>
      </li>)}</ul>}
  </div>;
}

function RfqCard({ rfq, busy, run, onOpenInbox, focused, onNotice }: { rfq: Rfq; busy: string; run: (key: string, action: string, body: Record<string, unknown>, after?: (result: any) => void) => Promise<void>; onOpenInbox: (threadId: string) => void; focused: boolean; onNotice: (text: string) => void }) {
  const drafts = rfq.recipients.filter(x => x.status === 'draft');
  const total = sentCount(rfq), answered = replied(rfq);
  const node = useRef<HTMLElement>(null);
  useEffect(() => { if (focused) node.current?.scrollIntoView({ block: 'start' }); }, [focused]);
  return <article ref={node} className={`sq-card panel ${rfq.status} ${focused ? 'focused' : ''}`}>
    <header className="sq-card-head">
      <div>
        <span className="sq-ref">{rfq.reference}</span>
        <h2>{rfq.title}</h2>
        <p>{rfq.customer_label ? <>For <b>{rfq.customer_label}</b> · </> : null}Created {when(rfq.created_at)}</p>
        {rfq.thread_id && <button className="secondary compact sq-customer-link" onClick={() => onOpenInbox(rfq.thread_id!)}><Mail size={14}/> Open customer's email <ExternalLink size={12}/></button>}
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
      {drafts.map(d => <DraftEmail key={d.id + d.updated_at} draft={d} busy={busy} run={run} canRemove={rfq.recipients.length > 1} onNotice={onNotice}/>)}
      <div className="sq-send"><button className="primary" disabled={!!busy} onClick={() => void run('send:' + rfq.id, 'rfq-send', { rfq_id: rfq.id })}><Send size={15}/> {busy === 'send:' + rfq.id ? 'Sending…' : `Send to ${drafts.length} supplier${drafts.length === 1 ? '' : 's'}`}</button><small>Each supplier gets their own email from your Outlook mailbox, with your signature.</small></div>
    </div>}
    {total > 0 && <div className="sq-table" role="table">
      <div className="sq-row sq-row-head" role="row"><span>Supplier</span><span>Sent</span><span>Reply</span><span>Price</span><span>Delivery time</span><span/></div>
      {rfq.recipients.filter(x => x.status !== 'draft').map(x => <SupplierRow key={x.id} rfq={rfq} row={x} busy={busy} run={run} onOpenInbox={onOpenInbox}/>)}
    </div>}
  </article>;
}

function DraftEmail({ draft, busy, run, canRemove, onNotice }: { draft: Recipient; busy: string; run: (key: string, action: string, body: Record<string, unknown>, after?: (result: any) => void) => Promise<void>; canRemove: boolean; onNotice: (text: string) => void }) {
  const [instruction, setInstruction] = useState('');
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const dirty = subject !== draft.subject || body !== draft.body;
  return <details className="sq-draft">
    <summary><Mail size={14}/> <b>{draft.supplier_name}</b> <small>{draft.supplier_email}</small>{draft.error && <span className="sq-error">{draft.error}</span>}</summary>
    <label className="sq-label">Subject<input value={subject} onChange={e => setSubject(e.target.value)}/></label>
    <label className="sq-label">Message<textarea rows={10} value={body} onChange={e => setBody(e.target.value)}/></label>
    <form className="sq-ai-change" onSubmit={e => { e.preventDefault(); const text = instruction.trim(); if (!text || busy || dirty) return;
      void run('rewrite:' + draft.id, 'rfq-rewrite', { id: draft.id, instruction: text }, result => { setInstruction(''); onNotice(`Updated ${result.changed} email${result.changed === 1 ? '' : 's'} in this request.${result.rule ? ` Saved to AI memory: ${result.rule}` : ''}`); }); }}>
      <Sparkles size={15} aria-hidden="true"/>
      <input id={`sq-ai-change-${draft.id}`} aria-label="Tell AI what to change" placeholder="Tell AI what to change, e.g. don't ask for CAD or lead time" value={instruction} onChange={e => setInstruction(e.target.value)} disabled={!!busy}/>
      <button className="secondary compact" disabled={!!busy || !instruction.trim() || dirty} title={dirty ? 'Save or undo your own edits first' : undefined}>{busy === 'rewrite:' + draft.id ? 'Rewriting…' : 'Change'}</button>
    </form>
    <small className="field-help">Changes every unsent email in this request. Corrections that should apply to every request are saved to AI memory.</small>
    <div className="sq-draft-actions">
      <button className="secondary compact" disabled={!dirty || !!busy} onClick={() => void run('save:' + draft.id, 'rfq-save', { id: draft.id, subject, body })}>{busy === 'save:' + draft.id ? 'Saving…' : 'Save changes'}</button>
      {canRemove && <button className="text-button" disabled={!!busy} onClick={() => void run('remove:' + draft.id, 'rfq-remove', { id: draft.id })}><Trash2 size={14}/> Don't send to this supplier</button>}
    </div>
  </details>;
}

type ChainMessage = { id: string; direction: 'incoming' | 'outgoing'; sender: string; subject: string; occurred_at: string; text: string };

function SupplierRow({ rfq, row, busy, run, onOpenInbox }: { rfq: Rfq; row: Recipient; busy: string; run: (key: string, action: string, body: Record<string, unknown>) => Promise<void>; onOpenInbox: (threadId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [chain, setChain] = useState<ChainMessage[] | null>(null);
  const [chainError, setChainError] = useState('');
  const [message, setMessage] = useState('');
  const [version, setVersion] = useState(0);
  const [facts, setFacts] = useState({ price: row.price, lead_time: row.lead_time, notes: row.reply_notes });
  useEffect(() => setFacts({ price: row.price, lead_time: row.lead_time, notes: row.reply_notes }), [row.price, row.lead_time, row.reply_notes]);
  const isReplied = row.status === 'replied';
  // The chain reloads when the row changes (a new reply arrives or we answered).
  useEffect(() => {
    if (!open) return;
    let current = true;
    api<{ messages: ChainMessage[] }>(`rfq-thread&id=${encodeURIComponent(row.id)}`).then(result => { if (current) { setChain(result.messages); setChainError(''); } }).catch(cause => { if (current) setChainError((cause as Error).message); });
    return () => { current = false; };
  }, [open, row.updated_at, row.last_reply_at, version]);
  function toggle() {
    if (!open && !message && row.status === 'sent') setMessage(reminderText(row, rfq.reference));
    setOpen(!open);
  }
  async function send() {
    await run((isReplied ? 'reply:' : 'nudge:') + row.id, isReplied ? 'rfq-reply' : 'rfq-nudge', { id: row.id, body: message });
    setMessage('');
    setVersion(v => v + 1);
  }
  return <>
    <div className={`sq-row ${row.status} ${open ? 'open' : ''} ${row.status !== 'uncertain' ? 'clickable' : ''}`} role="row" aria-expanded={open}
      onClick={event => { if (row.status !== 'uncertain' && !(event.target as HTMLElement).closest('button,a,input,textarea')) toggle(); }}>
      <span className="sq-supplier">{isReplied ? <CheckCircle2 size={16} className="sq-ok"/> : <Clock3 size={16} className="sq-pending"/>}<span><b>{row.supplier_name}</b><small>{row.supplier_email}</small></span></span>
      <span data-label="Sent">{row.sent_at ? when(row.sent_at) : row.status === 'uncertain' ? <em className="sq-error">Not confirmed: check Sent Items</em> : '—'}{row.nudge_count > 0 && <small>Reminded {row.nudge_count}× · {when(row.last_nudged_at!)}</small>}</span>
      <span data-label="Reply">{isReplied ? when(row.last_reply_at || row.replied_at!) : row.sent_at ? <em>Waiting · {waited(row.sent_at)}</em> : '—'}</span>
      <span data-label="Price">{isReplied ? (row.reply_read_at ? row.price || <em>Not stated</em> : <em>Reading…</em>) : ''}</span>
      <span data-label="Delivery time">{isReplied && row.reply_read_at ? row.lead_time || <em>Not stated</em> : ''}</span>
      <span className="sq-actions">
        {row.status !== 'uncertain' && <button className={isReplied ? 'secondary compact' : 'text-button'} onClick={toggle}>{open ? 'Hide' : isReplied ? 'Open' : <><BellRing size={14}/> Remind</>}</button>}
      </span>
    </div>
    {open && <div className="sq-detail">
      {isReplied && <>
        <div className="sq-facts">
          <label className="sq-label">Price<input value={facts.price} onChange={e => setFacts({ ...facts, price: e.target.value })}/></label>
          <label className="sq-label" title="How soon the supplier can deliver or ship, e.g. in stock, 3 weeks">Delivery time<input value={facts.lead_time} onChange={e => setFacts({ ...facts, lead_time: e.target.value })}/></label>
          <label className="sq-label sq-wide">Notes<input value={facts.notes} onChange={e => setFacts({ ...facts, notes: e.target.value })}/></label>
          <button className="secondary compact" disabled={!!busy || (facts.price === row.price && facts.lead_time === row.lead_time && facts.notes === row.reply_notes)} onClick={() => void run('correct:' + row.id, 'rfq-correct', { id: row.id, ...facts })}>Save</button>
        </div>
        <p className="field-help">Filled in by the AI from the latest reply. <button className="text-button" disabled={!!busy} onClick={() => void run('read:' + row.id, 'rfq-read-reply', { id: row.id })}><Sparkles size={12}/> {busy === 'read:' + row.id ? 'Reading…' : 'Read again'}</button></p>
      </>}
      <div className="sq-chain" aria-label={`Emails with ${row.supplier_name}`}>
        {chainError ? <p className="form-error">{chainError}</p> : !chain ? <p className="field-help">Loading emails…</p>
          : chain.map(m => <div key={m.id} className={`sq-msg ${m.direction}`}>
            <header><b>{m.direction === 'outgoing' ? 'You' : row.supplier_name}</b><span><time>{when(m.occurred_at)}</time><CopyButton text={m.text}/></span></header>
            <p>{m.text || '(No text)'}</p>
          </div>)}
      </div>
      <label className="sq-label">{isReplied ? `Reply to ${row.supplier_name}` : `Reminder to ${row.supplier_name}`}
        <textarea rows={isReplied ? 4 : 6} value={message} onChange={e => setMessage(e.target.value)} placeholder={isReplied ? 'e.g. Thanks. Please confirm the final price in CAD and whether shipping is included.' : ''}/></label>
      <div className="sq-draft-actions">
        <button className="primary compact" disabled={!!busy || !message.trim()} onClick={() => void send()}><Send size={14}/> {busy === 'reply:' + row.id || busy === 'nudge:' + row.id ? 'Sending…' : isReplied ? 'Send reply' : 'Send reminder'}</button>
        <small>Goes only to {row.supplier_email}, in the same email conversation.</small>
        {row.supplier_thread_id && <button className="text-button" onClick={() => onOpenInbox(row.supplier_thread_id!)}><ExternalLink size={14}/> Open in Inbox</button>}
      </div>
    </div>}
  </>;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  }
  return <button type="button" className="sq-copy" onClick={() => void copy()} aria-label="Copy this email">{copied ? <><Check size={12}/> Copied</> : <><Copy size={12}/> Copy</>}</button>;
}
