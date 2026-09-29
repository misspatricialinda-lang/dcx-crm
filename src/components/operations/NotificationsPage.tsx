import { useEffect, useState } from 'react';
import { ArrowRight, Bell, BellRing, CheckCheck, Mail, RefreshCw, Smartphone } from 'lucide-react';

type Notice = { id: string; thread_id: string; sender: string; subject: string; preview: string; occurred_at: string; read_at: string | null };
type Feed = { records: Notice[]; unread: number };

async function api<T>(action: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/notifications?action=${action}`, { credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Notifications are unavailable.');
  return result;
}
function keyBytes(value: string) {
  const binary = atob((value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

export function NotificationsPage({ preview, onUnread, onOpenInbox }: { preview: boolean; onUnread: (count: number) => void; onOpenInbox: (threadId: string) => void }) {
  const [feed, setFeed] = useState<Feed>({ records: [], unread: 0 });
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [pushAvailable, setPushAvailable] = useState(false);
  const [publicKey, setPublicKey] = useState('');
  const [subscribed, setSubscribed] = useState(false);
  const supported = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const ios = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent);
  const standalone = typeof window !== 'undefined' && (window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone);

  async function load() {
    if (preview) { setLoading(false); return; }
    try { const result = await api<Feed>('list'); setFeed(result); onUnread(result.unread); setError(''); setLoaded(true); }
    catch (cause) { setError((cause as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    void load();
    if (!preview) void api<{ available: boolean; publicKey: string }>('config').then(config => {
      setPushAvailable(config.available); setPublicKey(config.publicKey);
      if (supported && config.available) void navigator.serviceWorker.register('/sw.js').then(registration => registration.pushManager.getSubscription()).then(async subscription => {
        if (subscription) await api('subscribe', { subscription: subscription.toJSON() });
        setSubscribed(!!subscription);
      }).catch(cause => setError((cause as Error).message));
    }).catch(() => {});
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 30000);
    return () => clearInterval(timer);
  }, [preview]);

  async function setPhoneAlerts() {
    if (!supported || !pushAvailable || busy) return;
    setBusy('push'); setError('');
    try {
      const registration = await navigator.serviceWorker.register('/sw.js');
      const current = await registration.pushManager.getSubscription();
      if (current) {
        await api('unsubscribe', { endpoint: current.endpoint });
        await current.unsubscribe();
        setSubscribed(false);
      } else {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') throw new Error('Allow notifications in your phone settings to receive alerts.');
        const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource });
        try { await api('subscribe', { subscription: subscription.toJSON() }); }
        catch (cause) { await subscription.unsubscribe(); throw cause; }
        setSubscribed(true);
      }
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(''); }
  }
  async function read(id: string) {
    try { await api('read', { id }); const item = feed.records.find(record => record.id === id); const wasUnread = !!item && !item.read_at; setFeed(current => ({ records: current.records.map(record => record.id === id ? { ...record, read_at: new Date().toISOString() } : record), unread: Math.max(0, current.unread - (wasUnread ? 1 : 0)) })); onUnread(Math.max(0, feed.unread - (wasUnread ? 1 : 0))); if (item) onOpenInbox(item.thread_id); }
    catch (cause) { setError((cause as Error).message); }
  }
  async function readAll() {
    setBusy('read');
    try { await api('read-all', {}); setFeed(current => ({ records: current.records.map(item => ({ ...item, read_at: item.read_at || new Date().toISOString() })), unread: 0 })); onUnread(0); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(''); }
  }

  return <section className="notifications-page">
    <div className="notifications-hero"><div className="notifications-hero-icon"><BellRing size={26}/></div><div><span className="notifications-eyebrow">YOUR INBOX, AT A GLANCE</span><h1>Notifications</h1><p>New emails appear here as soon as they are saved.</p></div><button className="secondary compact" onClick={() => void load()} disabled={loading} aria-label="Refresh notifications"><RefreshCw size={16}/></button></div>
    <div className="notifications-layout"><div className="notifications-feed panel"><div className="notifications-feed-head"><div><h2>Recent activity</h2><span>{feed.unread ? `${feed.unread} unread` : 'All caught up'}</span></div>{feed.unread > 0 && <button className="text-button" disabled={busy === 'read'} onClick={() => void readAll()}><CheckCheck size={16}/> Mark all read</button>}</div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {loading ? <p className="notifications-empty">Loading notifications…</p> : !loaded && error ? <div className="notifications-empty"><h3>Notifications could not load</h3><button className="secondary" onClick={() => void load()}>Try again</button></div> : !feed.records.length ? <div className="notifications-empty"><span><Mail size={28}/></span><h3>No new mail yet</h3><p>Incoming email alerts will appear here.</p></div> : <div className="notifications-items">{feed.records.map(item => <button className={`notification-item ${item.read_at ? '' : 'unread'}`} key={item.id} onClick={() => void read(item.id)}><span className="notification-item-icon"><Mail size={18}/></span><span className="notification-item-copy"><strong>{item.sender || 'New email'}</strong><b>{item.subject || '(No subject)'}</b><small>{item.preview || 'Open the conversation to read this email.'}</small><time>{new Date(item.occurred_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></span><ArrowRight size={17}/></button>)}</div>}
    </div><aside className="notifications-phone panel"><span className="notifications-phone-icon"><Smartphone size={24}/></span><h2>Alerts on your phone</h2><p>Get a notification when a new email arrives, even when the CRM is closed.</p>{ios && !standalone && <p className="notifications-hint">On iPhone, add this website to your Home Screen first, then open it from the new icon.</p>}{!preview && supported && pushAvailable ? <button className={subscribed ? 'secondary' : 'primary'} onClick={() => void setPhoneAlerts()} disabled={busy === 'push' || (ios && !standalone)}>{busy === 'push' ? 'Updating…' : subscribed ? 'Turn off phone alerts' : 'Enable phone alerts'}</button> : <p className="notifications-hint">{preview ? 'Sign in to enable phone alerts.' : !supported ? 'This browser does not support phone alerts.' : 'Phone alerts are not ready yet.'}</p>}<div className="notifications-phone-status"><Bell size={15}/>{subscribed ? 'Phone alerts are on' : 'In-app alerts are available'}</div></aside></div>
  </section>;
}
