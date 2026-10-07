import { useState } from 'react';
import { AlarmClock, Check, X } from 'lucide-react';

export type FollowupRecord = {
  thread_id: string; provider_thread_key: string | null; subject: string; followup_at: string; reason: string;
  stage: number; source: string | null; notified_at: string | null; due: boolean; contact: string | null; last_sent_at: string | null;
};
export type FollowupSettings = { enabled: boolean; quote_days: number[]; question_days: number[]; lead_days: number[] };
export const followupLabels: Record<string, string> = {
  quote: 'Quotation sent, no reply yet',
  awaiting_answer: 'Waiting for an answer to our question',
  quiet_lead: 'Prospect went quiet',
  manual: 'Your reminder',
};

export async function followupRequest<T>(action: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/followups?action=${action}`, { credentials: 'same-origin', cache: 'no-store', ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Follow-ups are unavailable.');
  return result;
}

export const followupDate = (iso: string) => new Date(iso).toLocaleString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Toronto' });

// 9:00 AM on the business day `days` after today (weekends skipped), in the viewer's clock.
function businessDays(days: number) {
  const date = new Date();
  for (let added = 0; added < days;) { date.setDate(date.getDate() + 1); if (date.getDay() !== 0 && date.getDay() !== 6) added++; }
  date.setHours(9, 0, 0, 0);
  return date;
}
const choices: [string, () => Date][] = [['Tomorrow', () => businessDays(1)], ['In 3 business days', () => businessDays(3)], ['Next week', () => businessDays(5)]];

// The follow-up line under a conversation's subject: when it is due, why, and snooze / done / remind me.
export function FollowupBar({ followup, conversationKey, onChanged }: { followup?: FollowupRecord; conversationKey: string; onChanged: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [picking, setPicking] = useState(false);
  async function set(op: 'snooze' | 'remind' | 'done', until?: Date) {
    setBusy(true); setError('');
    try {
      await followupRequest('set', { ...(followup ? { thread_id: followup.thread_id } : { provider_thread_key: conversationKey }), op, ...(until ? { until: until.toISOString() } : {}) });
      setPicking(false); onChanged();
    } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); }
  }
  const op = followup ? 'snooze' : 'remind';
  const menu = <select aria-label={followup ? 'Snooze follow-up' : 'Remind me to follow up'} value="" disabled={busy} onChange={event => {
    const value = event.target.value; event.target.value = '';
    if (value === 'pick') setPicking(true); else { const choice = choices.find(([label]) => label === value); if (choice) void set(op, choice[1]()); }
  }}>
    <option value="">{followup ? 'Snooze…' : 'Remind me…'}</option>
    {choices.map(([label]) => <option key={label} value={label}>{label}</option>)}
    <option value="pick">Pick a date…</option>
  </select>;
  return <div className={`followup-bar ${followup ? (followup.due ? 'due' : 'upcoming') : 'none'}`}>
    {followup ? <span className="followup-when"><AlarmClock size={15} /> <strong>{followup.due ? 'Follow-up due' : `Follow up ${followupDate(followup.followup_at)}`}</strong> · {followupLabels[followup.reason] || 'Follow-up'}{followup.stage > 1 ? ' (second reminder)' : ''}</span>
      : <span className="followup-when muted"><AlarmClock size={15} /> No follow-up set</span>}
    {menu}
    {picking && <form className="followup-pick" onSubmit={event => { event.preventDefault(); const value = new FormData(event.currentTarget).get('date'); if (value) { const date = new Date(`${value}T09:00`); void set(op, date); } }}>
      <input type="date" name="date" aria-label="Follow-up date" min={new Date().toISOString().slice(0, 10)} required />
      <button type="submit" className="secondary compact" disabled={busy}>Set</button>
      <button type="button" className="text-button" aria-label="Cancel" onClick={() => setPicking(false)}><X size={14} /></button>
    </form>}
    {followup && <button type="button" className="secondary compact" disabled={busy} onClick={() => void set('done')}><Check size={14} /> Done</button>}
    {error && <span role="alert" className="form-error">{error}</span>}
  </div>;
}

// Follow-up rules: how many business days to wait before each reminder.
export function FollowupRules({ settings, onClose, onSaved }: { settings: FollowupSettings; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ enabled: settings.enabled, quote: settings.quote_days.join(', '), question: settings.question_days.join(', '), lead: settings.lead_days.join(', ') });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const parse = (text: string) => text.split(/[\s,]+/).filter(Boolean).map(Number);
  async function save() {
    setBusy(true); setError('');
    try { await followupRequest('settings', { enabled: form.enabled, quote_days: parse(form.quote), question_days: parse(form.question), lead_days: parse(form.lead) }); onSaved(); onClose(); }
    catch (cause) { setError((cause as Error).message); } finally { setBusy(false); }
  }
  const field = (key: 'quote' | 'question' | 'lead', label: string, help: string) => <label>{label}<input value={form[key]} onChange={event => setForm(old => ({ ...old, [key]: event.target.value }))} inputMode="numeric" /><small>{help}</small></label>;
  return <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <form className="detail-modal followup-rules" role="dialog" aria-modal="true" aria-label="Follow-up rules" onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="panel-heading"><h2>Follow-up rules</h2><button type="button" className="text-button" aria-label="Close" onClick={onClose}><X size={18} /></button></div>
      <p>After DCX replies, the app waits this many business days for an answer, then prepares a follow-up draft and notifies you. Nothing is sent without you. A customer reply stops the reminders; staff and suppliers are never chased.</p>
      {error && <p role="alert" className="form-error">{error}</p>}
      <label className="checkbox-label"><input type="checkbox" checked={form.enabled} onChange={event => setForm(old => ({ ...old, enabled: event.target.checked }))} /> Follow-up reminders are on</label>
      {field('quote', 'Quotation sent', 'Business days before the 1st and 2nd reminder, e.g. 3, 7')}
      {field('question', 'We asked the customer a question', 'e.g. 3, 7')}
      {field('lead', 'Prospect went quiet', 'e.g. 7, 14')}
      <div className="button-row"><button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save rules'}</button><button type="button" className="secondary" onClick={onClose} disabled={busy}>Cancel</button></div>
    </form>
  </div>;
}
