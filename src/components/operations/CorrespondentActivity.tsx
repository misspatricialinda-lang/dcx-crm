import { useEffect, useState } from 'react';
import { ArrowRight, Mail } from 'lucide-react';
import { trackingRequest } from '../../lib/email-tracking';

type Person = { email: string; received: number; sent: number; replies: number; last_at: string; thread_id: string };
export function CorrespondentActivity({ navigate }: { navigate: (tab: string, id?: string) => void }) {
  const [people, setPeople] = useState<Person[]>([]);
  const [sampled, setSampled] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const load = () => trackingRequest<{ people: Person[]; sampled: number }>('correspondents')
      .then(data => { if (active) { setPeople(data.people); setSampled(data.sampled); setError(''); } })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Could not load contact activity.'); });
    load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 30000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  return <section className="panel correspondent-activity">
    <div className="panel-heading"><div><h2><Mail size={17} /> Recent contact activity</h2><p className="small muted">Received and sent messages across stored mailboxes.</p></div><button className="text-button" onClick={() => navigate('inbox')}>All conversations <ArrowRight size={14} /></button></div>
    {error && <p className="notice amber" role="alert">{error}</p>}
    {!error && !people.length && <p className="small muted">No stored email activity yet.</p>}
    {!!people.length && <div className="table-scroll"><table><thead><tr><th>Contact</th><th>Received</th><th>Sent</th><th>Replies in same chain</th><th>Last contact</th><th /></tr></thead><tbody>{people.map(person => <tr key={person.email}><td><strong>{person.email}</strong></td><td>{person.received}</td><td>{person.sent}</td><td>{person.replies}</td><td>{new Date(person.last_at).toLocaleDateString('en-CA')}</td><td><button className="text-button" onClick={() => navigate('inbox', person.thread_id)}>View chain</button></td></tr>)}</tbody></table></div>}
    {!!people.length && <p className="small muted correspondent-foot">Based on the latest {sampled} stored messages. “Replies in same chain” counts a sent message after an incoming message in that chain.</p>}
  </section>;
}
