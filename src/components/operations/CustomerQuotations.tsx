import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Plus, Save, Trash2 } from 'lucide-react';
import { crmRequest } from '../../lib/crm-client';
import { buildCustomerQuotationPdf, cad, exportCustomerQuotation, lineCents, quotationLogo, totals, type CustomerQuotation, type QuotationItem } from '../../lib/customer-quotation';

const blankRow = (): QuotationItem => ({ id: crypto.randomUUID(), product_service: '', description: '', quantity: 1, unit_price: '' });

export function CustomerQuotations({ customer, preview, createNow, onCreated }: { customer: Record<string, any>; preview: boolean; createNow: boolean; onCreated: () => void }) {
  const [records, setRecords] = useState<CustomerQuotation[]>([]);
  const [editing, setEditing] = useState<CustomerQuotation | null | 'new'>(createNow ? 'new' : null);
  const [items, setItems] = useState<QuotationItem[]>([blankRow()]);
  const [address, setAddress] = useState(customer.billing_address || '');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewPages, setPreviewPages] = useState(0);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const previewObjectUrl = useRef('');
  const sum = useMemo(() => totals(items), [items]);
  useEffect(() => () => { if (previewObjectUrl.current) URL.revokeObjectURL(previewObjectUrl.current); }, []);
  useEffect(() => {
    if (!editing) { setPreviewUrl(''); setPreviewPages(0); return; }
    let cancelled = false;
    setPreviewBusy(true);
    const timer = window.setTimeout(async () => {
      try {
        const existing = editing === 'new' ? null : editing;
        const q: CustomerQuotation = {
          id: existing?.id || '', customer_id: customer.id,
          estimate_number: existing?.estimate_number || 0,
          recipient_snapshot: existing?.recipient_snapshot || { name: customer.name || '', contact: customer.contact || '', email: customer.email || '', billing_address: customer.billing_address || '' },
          address_1: address, status: 'draft', version: existing?.version || 1,
          tax_rate: 13, subtotal: sum.subtotal, tax_total: sum.tax, grand_total: sum.total,
          created_at: existing?.created_at || new Date().toISOString(),
          items: items.map(row => ({ ...row, line_total: lineCents(row) / 100 })),
        };
        const doc = await buildCustomerQuotationPdf(q, await quotationLogo());
        const url = URL.createObjectURL(doc.output('blob'));
        if (cancelled) { URL.revokeObjectURL(url); return; }
        if (previewObjectUrl.current) URL.revokeObjectURL(previewObjectUrl.current);
        previewObjectUrl.current = url;
        setPreviewUrl(url); setPreviewPages(doc.getNumberOfPages()); setPreviewError('');
      } catch (e) { if (!cancelled) setPreviewError((e as Error).message || 'Preview could not be rendered.'); }
      finally { if (!cancelled) setPreviewBusy(false); }
    }, 600);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [editing, items, address, customer.id, customer.name, customer.contact, customer.email, customer.billing_address, sum.subtotal, sum.tax, sum.total]);
  const load = async () => {
    if (preview) { setLoading(false); return; }
    setLoading(true);
    try { setRecords((await crmRequest(`action=quotations&customer_id=${encodeURIComponent(customer.id)}`)).records); setError(''); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [customer.id, preview]);
  const newQuote = () => { setEditing('new'); setItems([blankRow()]); setAddress(customer.billing_address || ''); setDirty(false); setError(''); };
  useEffect(() => { if (createNow) { newQuote(); onCreated(); } }, [createNow]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => { if (dirty && editing) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', unload); return () => window.removeEventListener('beforeunload', unload);
  }, [dirty, editing]);
  const edit = (q: CustomerQuotation) => { setEditing(q); setItems(q.items.map(i => ({ ...i }))); setAddress(q.address_1); setDirty(false); setError(''); };
  const setRow = (index: number, patch: Partial<QuotationItem>) => { setItems(rows => rows.map((row, i) => i === index ? { ...row, ...patch } : row)); setDirty(true); };
  async function save(issue: boolean) {
    if (!editing || busy || preview) return;
    if (!items.length || items.some(r => !r.product_service.trim() || !/^\d{1,9}(\.\d{1,3})?$/.test(String(r.quantity)) || Number(r.quantity) <= 0 || !/^\d{1,10}(\.\d{1,2})?$/.test(String(r.unit_price)))) { setError('Complete every row with a product, positive quantity (up to 3 decimals), and unit price (up to 2 decimals).'); return; }
    setBusy(true); setError('');
    try {
      const existing = editing === 'new' ? null : editing;
      const { record } = await crmRequest(`action=quotations&customer_id=${encodeURIComponent(customer.id)}`, {
        method: existing ? 'PATCH' : 'POST',
        body: JSON.stringify({ id: existing?.id, version: existing?.version, address_1: address, issue, items: items.map(({ product_service, description, quantity, unit_price }) => ({ product_service, description, quantity, unit_price })) }),
      });
      setRecords(rows => [record, ...rows.filter(q => q.id !== record.id)]);
      setEditing(null); setDirty(false);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function remove(q: CustomerQuotation) {
    if (busy || !window.confirm(`Delete estimate #${q.estimate_number}? It will be hidden from this customer, and its number will never be reused.`)) return;
    setBusy(true); setError('');
    try { await crmRequest(`action=quotations&customer_id=${encodeURIComponent(customer.id)}`, { method: 'DELETE', body: JSON.stringify({ id: q.id, version: q.version }) }); setRecords(rows => rows.filter(r => r.id !== q.id)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function download(q: CustomerQuotation) {
    setError('');
    try { await exportCustomerQuotation(q); }
    catch (e) { setError((e as Error).message || 'PDF export failed.'); }
  }
  const visible = records.filter(q => `${q.estimate_number} ${q.recipient_snapshot.name} ${q.items.map(i => `${i.product_service} ${i.description}`).join(' ')}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="panel customer-quotation-panel">
    <div className="panel-heading"><div><h2>Quotations</h2><p className="small muted">Itemized DCX estimates saved with this customer</p></div><button className="primary" onClick={newQuote}><Plus size={15}/> New quotation</button></div>
    {preview && <p className="notice amber">Sign in to save quotations and receive estimate numbers.</p>}
    {error && !editing && <p className="form-error" role="alert">{error}</p>}
    <div className="search-field"><input aria-label="Search this customer's quotations" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search estimate number or item"/></div>
    {loading ? <p>Loading quotations…</p> : !visible.length ? <p className="muted">No matching quotations for this customer.</p> : <div className="table-scroll"><table><thead><tr><th>Estimate</th><th>Date</th><th>Status</th><th>Total</th><th>Actions</th></tr></thead><tbody>{visible.map(q => <tr key={q.id}><td>#{q.estimate_number}</td><td>{new Date(q.issued_at || q.created_at).toLocaleDateString('en-CA')}</td><td>{q.status}</td><td>{cad(Number(q.grand_total))}</td><td><div className="button-row">{q.status === 'draft' && <button className="secondary compact" onClick={() => edit(q)}>Edit</button>}<button className="secondary compact" onClick={() => void download(q)}><Download size={14}/> PDF</button><button className="secondary compact" disabled={busy} onClick={() => void remove(q)}><Trash2 size={14}/> Delete</button></div></td></tr>)}</tbody></table></div>}
    {editing && <div className="modal-backdrop"><section className={`detail-modal quotation-editor ${previewExpanded ? 'preview-expanded' : ''}`} role="dialog" aria-modal="true" aria-label="Quotation editor">
      <div className="panel-heading"><div><h2>{editing === 'new' ? 'New quotation' : `Estimate #${editing.estimate_number}`}</h2><p className="small muted">Prepared for {customer.name}</p></div><button className="text-button" disabled={busy} onClick={() => { if (!dirty || window.confirm('Discard unsaved quotation changes?')) { setEditing(null); setDirty(false); } }}>Close</button></div>
      <div className="quotation-editor-main"><div className="quotation-form-pane">
      <label className="quotation-address">Address 1<input value={address} maxLength={1000} onChange={e => { setAddress(e.target.value); setDirty(true); }}/></label>
      <div className="table-scroll"><table className="quotation-edit-table"><thead><tr><th>Product/Service</th><th>Description</th><th>Qty.</th><th>Unit Price (CAD)</th><th>Total</th><th></th></tr></thead><tbody>{items.map((row, index) => <tr key={row.id || index}><td><input aria-label={`Product/Service row ${index+1}`} maxLength={200} value={row.product_service} onChange={e => setRow(index, { product_service: e.target.value })}/></td><td><textarea aria-label={`Description row ${index+1}`} maxLength={2000} rows={2} value={row.description} onChange={e => setRow(index, { description: e.target.value })}/></td><td><input aria-label={`Quantity row ${index+1}`} type="number" min="0" max="999999999" step="1" value={row.quantity} onChange={e => setRow(index, { quantity: e.target.value })}/></td><td><input aria-label={`Unit price row ${index+1}`} type="number" min="0" max="9999999999" step="0.01" value={row.unit_price} onChange={e => setRow(index, { unit_price: e.target.value })}/></td><td>{cad(lineCents(row)/100)}</td><td><button className="text-button" aria-label={`Delete row ${index+1}`} disabled={items.length===1} onClick={() => { setItems(rows => rows.filter((_,i) => i!==index)); setDirty(true); }}><Trash2 size={16}/></button></td></tr>)}</tbody></table></div>
      <button className="secondary" onClick={() => { setItems(rows => [...rows, blankRow()]); setDirty(true); }}><Plus size={14}/> Add row</button>
      <div className="quotation-live-totals"><p>Subtotal <strong>{cad(sum.subtotal)}</strong></p><p>HST ON (13%) <strong>{cad(sum.tax)}</strong></p><p>Total <strong>{cad(sum.total)}</strong></p></div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="button-row"><button className="secondary" disabled={busy||preview} onClick={() => void save(false)}><Save size={15}/> Save draft</button><button className="primary" disabled={busy||preview} onClick={() => void save(true)}>Issue quotation</button></div>
      <p className="small muted">The estimate number is assigned when first saved. Issued quotations are fixed; deleting one never reuses its number.</p>
      </div><aside className="quotation-preview-pane"><div className="quotation-preview-heading"><strong>Live quotation preview</strong><span>{previewBusy ? 'Updating…' : previewPages ? `${previewPages} ${previewPages === 1 ? 'page' : 'pages'}` : ''}</span></div><div className="quotation-preview-actions"><button className="secondary compact" onClick={() => setPreviewExpanded(value => !value)}>{previewExpanded ? 'Show wider editor' : 'Expand preview'}</button><button className="secondary compact" disabled={!previewUrl} onClick={() => window.open(previewUrl, '_blank', 'noopener,noreferrer')}>Open full size</button></div><p>This is the generated PDF, updated as you edit. Its pages show the final margins and breaks.</p>{previewError && <p className="form-error" role="alert">{previewError}</p>}{previewUrl ? <iframe title="Live quotation PDF preview" src={`${previewUrl}#zoom=75`}/> : <div className="quotation-preview-wait">Rendering template…</div>}</aside></div>
    </section></div>}
  </section>;
}
