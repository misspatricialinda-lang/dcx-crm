import { useEffect, useState, type FormEvent } from 'react';
import { Check, ChevronDown, Lightbulb, RefreshCw } from 'lucide-react';

type Area = 'general' | 'inbox' | 'customers' | 'quotations' | 'calendar' | 'reporting' | 'other';
type Priority = 'low' | 'normal' | 'high';
type Status = 'new' | 'reviewing' | 'planned' | 'in_progress' | 'completed' | 'declined';
type Request = { id: string; title: string; description: string; area: Area; priority: Priority; status: Status; owner_notes: string; created_by: string; created_at: string; updated_at: string; version: number };
type Edit = Pick<Request, 'status' | 'priority' | 'owner_notes'>;

const areas: { value: Area; label: string }[] = [
  { value: 'general', label: 'General' }, { value: 'inbox', label: 'Inbox and email' },
  { value: 'customers', label: 'Customers' }, { value: 'quotations', label: 'Quotations' },
  { value: 'calendar', label: 'Calendar' }, { value: 'reporting', label: 'Reporting' }, { value: 'other', label: 'Other' },
];
const statuses: { value: Status; label: string }[] = [
  { value: 'new', label: 'New' }, { value: 'reviewing', label: 'Reviewing' },
  { value: 'planned', label: 'Planned' }, { value: 'in_progress', label: 'In progress' },
  { value: 'completed', label: 'Completed' }, { value: 'declined', label: 'Declined' },
];
const labelFor = <T extends string>(options: { value: T; label: string }[], value: T) => options.find(option => option.value === value)?.label || value;

async function request<T>(method: 'GET' | 'POST' | 'PATCH', body?: unknown): Promise<T> {
  const response = await fetch('/api/feature-requests', {
    method, credentials: 'same-origin', cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Feature requests are unavailable.');
  return result;
}

export function FeatureRequestsPage({ preview }: { preview: boolean }) {
  const [records, setRecords] = useState<Request[]>([]);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [area, setArea] = useState<Area>('general');
  const [priority, setPriority] = useState<Priority>('normal');
  const [filter, setFilter] = useState<Status | 'all'>('all');
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(!preview);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function load() {
    if (preview) return;
    setLoading(true);
    try {
      const result = await request<{ records: Request[] }>('GET');
      setRecords(result.records);
      setEdits(Object.fromEntries(result.records.map(item => [item.id, { status: item.status, priority: item.priority, owner_notes: item.owner_notes }])));
      setError('');
    } catch (cause) { setError((cause as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [preview]);

  async function add(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy('add'); setError(''); setNotice('');
    try {
      const result = preview
        ? { record: { id: crypto.randomUUID(), title: title.trim(), description: description.trim(), area, priority, status: 'new' as Status, owner_notes: '', created_by: 'Preview', version: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } }
        : await request<{ record: Request }>('POST', { title, description, area, priority });
      setRecords(current => [result.record, ...current]);
      setEdits(current => ({ ...current, [result.record.id]: { status: result.record.status, priority: result.record.priority, owner_notes: '' } }));
      setTitle(''); setDescription(''); setArea('general'); setPriority('normal'); setFilter('all');
      setExpandedIds(current => [result.record.id, ...current]);
      setNotice(preview ? 'Preview request added for this session.' : 'Feature request saved.');
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(''); }
  }

  async function save(item: Request) {
    const edit = edits[item.id];
    if (!edit || busy) return;
    setBusy(item.id); setError(''); setNotice('');
    try {
      const result = preview
        ? { record: { ...item, ...edit, version: item.version + 1, updated_at: new Date().toISOString() } }
        : await request<{ record: Request }>('PATCH', { id: item.id, version: item.version, ...edit });
      setRecords(current => current.map(record => record.id === item.id ? result.record : record));
      setNotice('Request updated.');
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(''); }
  }

  const visible = filter === 'all' ? records : records.filter(item => item.status === filter);
  const counts = Object.fromEntries(statuses.map(status => [status.value, records.filter(item => item.status === status.value).length])) as Record<Status, number>;
  return <section className="feature-requests-page">
    <div className="feature-requests-header"><span className="feature-requests-icon"><Lightbulb size={26}/></span><div><span className="feature-requests-eyebrow">IMPROVE THE WORKSPACE</span><h1>Feature requests</h1><p>Capture ideas for future CRM updates and track what happens next.</p></div></div>
    {preview && <p className="notice amber">Preview requests stay in this page until you leave it. Sign in to save requests for the team.</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    <div className="feature-requests-layout">
      <form className="panel feature-request-form" onSubmit={event => void add(event)}>
        <h2>Suggest an improvement</h2><p>Describe the problem and what you would like the CRM to do.</p>
        <label>Title<input value={title} onChange={event => setTitle(event.target.value)} maxLength={160} minLength={3} required placeholder="e.g. Show overdue quotes on the dashboard"/></label>
        <label>What should change?<textarea value={description} onChange={event => setDescription(event.target.value)} maxLength={5000} minLength={10} required rows={6} placeholder="Explain the current problem and the result you want."/></label>
        <div className="feature-request-form-row"><label>Area<select value={area} onChange={event => setArea(event.target.value as Area)}>{areas.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><label>Priority<select value={priority} onChange={event => setPriority(event.target.value as Priority)}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option></select></label></div>
        <button type="submit" className="primary" disabled={busy === 'add'}>{busy === 'add' ? 'Saving…' : 'Add request'}</button>
      </form>
      <div className="panel feature-request-list"><div className="feature-request-list-head"><div><h2>Requests</h2><p>{records.length} ideas captured</p></div><button type="button" className="secondary compact" onClick={() => void load()} disabled={loading || preview} aria-label="Refresh requests"><RefreshCw size={16}/></button></div>
        <div className="feature-request-summary" aria-label="Request progress"><div className="feature-request-summary-card new"><strong>{counts.new}</strong><span>New</span></div><div className="feature-request-summary-card planned"><strong>{counts.planned + counts.in_progress}</strong><span>Planned or active</span></div><div className="feature-request-summary-card completed"><strong>{counts.completed}</strong><span>Completed</span></div></div>
        <div className="feature-request-filters" aria-label="Filter requests by status"><button type="button" className={filter === 'all' ? 'active' : ''} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All <span>{records.length}</span></button>{statuses.map(option => <button type="button" key={option.value} className={`status-${option.value} ${filter === option.value ? 'active' : ''}`} aria-pressed={filter === option.value} onClick={() => setFilter(option.value)}>{option.label} <span>{counts[option.value]}</span></button>)}</div>
        {loading ? <p className="feature-request-empty">Loading requests…</p> : visible.length === 0 ? <p className="feature-request-empty">{filter === 'all' ? 'No requests yet. Add the first idea.' : `No ${labelFor(statuses, filter)} requests.`}</p> : <div className="feature-request-items">{visible.map(item => {
          const edit = edits[item.id] || { status: item.status, priority: item.priority, owner_notes: item.owner_notes };
          const changed = edit.status !== item.status || edit.priority !== item.priority || edit.owner_notes !== item.owner_notes;
          const expanded = expandedIds.includes(item.id);
          return <article className={`feature-request-item status-${item.status}`} key={item.id}><div className="feature-request-item-head"><div><span className="feature-request-area">{labelFor(areas, item.area)}</span><h3>{item.title}</h3></div><span className={`feature-request-status ${item.status}`}>{labelFor(statuses, item.status)}</span></div><p className="feature-request-description">{item.description}</p><div className="feature-request-meta"><span className={`feature-request-priority ${item.priority}`}>{item.priority} priority</span><small>Added {new Date(item.created_at).toLocaleDateString()}</small></div><button type="button" className="feature-request-expand" aria-expanded={expanded} onClick={() => setExpandedIds(current => expanded ? current.filter(id => id !== item.id) : [...current, item.id])}>{expanded ? 'Hide details' : 'Review and update'}<ChevronDown size={16}/></button>{expanded && <div className="feature-request-details"><div className="feature-request-edit"><label>Status<select value={edit.status} onChange={event => setEdits(current => ({ ...current, [item.id]: { ...edit, status: event.target.value as Status } }))}>{statuses.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><label>Priority<select value={edit.priority} onChange={event => setEdits(current => ({ ...current, [item.id]: { ...edit, priority: event.target.value as Priority } }))}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option></select></label></div><label className="feature-request-note">Planning notes<textarea value={edit.owner_notes} onChange={event => setEdits(current => ({ ...current, [item.id]: { ...edit, owner_notes: event.target.value } }))} maxLength={3000} rows={2} placeholder="Decision, next step, or reason for declining"/></label><button type="button" className="secondary compact" onClick={() => void save(item)} disabled={!changed || !!busy}><Check size={15}/> {busy === item.id ? 'Saving…' : 'Save update'}</button></div>}</article>;
        })}</div>}
      </div>
    </div>
  </section>;
}
