import { useEffect, useRef, useState } from 'react';
import { CalendarDays, Send } from 'lucide-react';

type Message = { role: 'user' | 'agent'; text: string };
const sessionKey = 'dcx-calendar-agent-session';
const historyKey = 'dcx-calendar-agent-messages';
const suggestions = [
  "Check this week's availability",
  "What's on my calendar tomorrow?",
  'Help me schedule a meeting',
];
function sessionId() {
  let id = sessionStorage.getItem(sessionKey);
  if (!id) { id = crypto.randomUUID(); sessionStorage.setItem(sessionKey, id); }
  return id;
}

export function CalendarAgent({ preview }: { preview: boolean }) {
  const [messages, setMessages] = useState<Message[]>(() => { try { return JSON.parse(sessionStorage.getItem(historyKey) || '[]'); } catch { return []; } });
  useEffect(() => { sessionStorage.setItem(historyKey, JSON.stringify(messages.slice(-40))); }, [messages]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [mention, setMention] = useState<{ start: number; end: number; query: string } | null>(null);
  const [emails, setEmails] = useState<string[]>([]);
  const [emailError, setEmailError] = useState('');
  const [emailLoading, setEmailLoading] = useState(false);
  const [activeEmail, setActiveEmail] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!mention || preview) { setEmails([]); setEmailError(''); setEmailLoading(false); return; }
    setEmailLoading(true); setEmailError('');
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/calendar-agent?action=emails&q=${encodeURIComponent(mention.query)}`, { signal: controller.signal, cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Email search is unavailable.');
        setEmails(data.emails); setEmailError(''); setEmailLoading(false); setActiveEmail(0);
      } catch (cause) { if (!controller.signal.aborted) { setEmails([]); setEmailLoading(false); setEmailError(cause instanceof Error ? cause.message : 'Email search is unavailable.'); } }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [mention?.query, preview]);
  function updateMention(value: string, cursor: number) {
    const before = value.slice(0, cursor);
    const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
    setMention(match ? { start: cursor - match[1].length - 1, end: cursor, query: match[1] } : null);
  }
  function chooseEmail(email: string) {
    if (!mention) return;
    const next = `${input.slice(0, mention.start)}${email} ${input.slice(mention.end)}`;
    const cursor = mention.start + email.length + 1;
    setInput(next); setMention(null); setEmails([]);
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(cursor, cursor); });
  }
  async function send(event: React.FormEvent) {
    event.preventDefault();
    const message = input.trim();
    if (!message || busy || preview) return;
    setInput(''); setMention(null); setEmails([]); setError(''); setBusy(true);
    setMessages(current => [...current, { role: 'user', text: message }]);
    try {
      const response = await fetch('/api/calendar-agent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, sessionId: sessionId() }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Calendar Agent is unavailable.');
      setMessages(current => [...current, { role: 'agent', text: data.answer }]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Calendar Agent is unavailable.'); }
    finally { setBusy(false); }
  }
  return <section className="panel calendar-agent">
    <div className="panel-heading"><h1><CalendarDays size={22} /> Calendar Agent</h1></div>
    <p className="muted">Ask about your calendar, create meetings, or change events.</p>
    <div className="calendar-agent-messages" role="log" aria-live="polite">
      {!messages.length && <p className="muted">Ask about your schedule or type @ to find an email address.</p>}
      {messages.map((message, index) => <div className={`calendar-agent-message ${message.role}`} key={index}>{message.text}</div>)}
      {busy && <p className="muted">Calendar Agent is thinking…</p>}
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {preview && <p className="notice amber">Sign in to use Calendar Agent.</p>}
    <div className="calendar-agent-prompts" aria-label="Suggested questions">{suggestions.map(question => <button key={question} type="button" className="secondary" disabled={busy || preview} onClick={() => { setInput(question); setMention(null); inputRef.current?.focus(); }}>{question}</button>)}</div>
    <div className="calendar-agent-composer">
      {mention && !preview && <div className="calendar-agent-email-list" role="listbox" aria-label="Email suggestions">
        {emailError ? <p role="status">{emailError}</p> : emailLoading ? <p>Searching saved email addresses…</p> : emails.length ? emails.map((email, index) => <button type="button" role="option" aria-selected={index === activeEmail} key={email} onMouseDown={event => event.preventDefault()} onClick={() => chooseEmail(email)}>{email}</button>) : <p>No matching email addresses</p>}
      </div>}
      <form className="calendar-agent-compose" onSubmit={send}><input ref={inputRef} aria-label="Message Calendar Agent" placeholder="Ask about your calendar or type @ for an email…" value={input} onChange={event => { setInput(event.target.value); updateMention(event.target.value, event.target.selectionStart ?? event.target.value.length); }} onClick={event => updateMention(input, event.currentTarget.selectionStart ?? input.length)} onKeyDown={event => { if (!mention) return; if (event.key === 'Escape') { setMention(null); event.preventDefault(); } else if (event.key === 'ArrowDown' && emails.length) { setActiveEmail(index => (index + 1) % emails.length); event.preventDefault(); } else if (event.key === 'ArrowUp' && emails.length) { setActiveEmail(index => (index - 1 + emails.length) % emails.length); event.preventDefault(); } else if (event.key === 'Enter' && emails.length) { chooseEmail(emails[activeEmail]); event.preventDefault(); } }} disabled={busy || preview} maxLength={4000} /><button className="primary" disabled={busy || preview || !input.trim()} aria-label="Send message"><Send size={17} /></button></form>
    </div>
  </section>;
}
