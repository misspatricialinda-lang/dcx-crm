import { useEffect, useState } from 'react';
import { PenLine, X } from 'lucide-react';

type Fields = { name: string; title: string; direct_phone: string; email: string; support_label: string; support_phone: string; support_email: string };
type Signature = { fields: Fields; enabled: boolean; preview_html: string; updated_at: string; updated_by: string | null };
const labels: [keyof Fields, string][] = [['name', 'Name'], ['title', 'Job title'], ['direct_phone', 'Direct phone'], ['email', 'Email'], ['support_label', 'Support line heading'], ['support_phone', 'Support phone'], ['support_email', 'Support email']];

// One shared copy so every open reply shows the same signature and updates together after an edit.
let cached: Promise<Signature | null> | undefined;
const listeners = new Set<() => void>();
function loadSignature(force = false) {
  if (!cached || force) cached = fetch('/api/email-assistant?action=signature', { credentials: 'same-origin', cache: 'no-store' })
    .then(async response => { const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Signature unavailable.'); return result.signature as Signature | null; })
    .catch(() => { cached = undefined; return null; });
  return cached;
}

// Shows the signature that will be added when the email is sent, with a way to edit it.
export function SignaturePreview() {
  const [signature, setSignature] = useState<Signature | null>(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    const refresh = () => void loadSignature().then(setSignature);
    refresh(); listeners.add(refresh);
    return () => { listeners.delete(refresh); };
  }, []);
  if (!signature) return null;
  return <div className="signature-preview">
    <div className="signature-preview-head"><span>{signature.enabled ? 'Signature added when sent' : 'Signature is turned off'}</span><button type="button" className="text-button" onClick={() => setEditing(true)}><PenLine size={13} /> Edit signature</button></div>
    {signature.enabled && <div className="signature-preview-body" dangerouslySetInnerHTML={{ __html: signature.preview_html }} />}
    {editing && <SignatureEditor signature={signature} onClose={() => setEditing(false)} />}
  </div>;
}

function SignatureEditor({ signature, onClose }: { signature: Signature; onClose: () => void }) {
  const [fields, setFields] = useState<Fields>(signature.fields);
  const [enabled, setEnabled] = useState(signature.enabled);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function save() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/email-assistant', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'signature', fields, enabled }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Signature could not be saved.');
      await loadSignature(true); listeners.forEach(refresh => refresh()); onClose();
    } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); }
  }
  return <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <form className="detail-modal signature-editor" role="dialog" aria-modal="true" aria-label="Email signature" onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="panel-heading"><h2>Email signature</h2><button type="button" className="text-button" aria-label="Close" onClick={onClose}><X size={18} /></button></div>
      <p>Added to every email sent from this app, with the DCX banner below it. Outlook adds its own signature only to emails written in Outlook.</p>
      {error && <p role="alert" className="form-error">{error}</p>}
      <div className="signature-fields">{labels.map(([key, label]) => <label key={key}>{label}<input value={fields[key] || ''} onChange={event => setFields(old => ({ ...old, [key]: event.target.value }))} required={key === 'name'} maxLength={200} /></label>)}</div>
      <label className="checkbox-label"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /> Add this signature to sent emails</label>
      <div className="button-row"><button type="submit" className="primary" disabled={busy || !fields.name.trim()}>{busy ? 'Saving…' : 'Save signature'}</button><button type="button" className="secondary" onClick={onClose} disabled={busy}>Cancel</button></div>
    </form>
  </div>;
}
