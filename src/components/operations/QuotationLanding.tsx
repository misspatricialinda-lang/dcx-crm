import { useEffect, useState } from 'react';
import { Archive, ArrowLeft, Download, Search, Trash2 } from 'lucide-react';
import { crmRequest, toClient } from '../../lib/crm-client';
import { cad, exportCustomerQuotation, type CustomerQuotation } from '../../lib/customer-quotation';
import type { Client, Workspace } from '../../types/operations';
import { CustomerQuotations } from './CustomerQuotations';

type Customer = Record<string, any>;
type ArchivedQuotation = CustomerQuotation & { archived_customer?: { name?: string; removed_at?: string } | null };

// The open customer lives in the address (#quotations/<customer id>, #quotations/archived), so the
// browser Back button and the Quotations menu item both return to the customer list.
function routeFromHash() {
  const [page, sub = ''] = location.hash.slice(1).split('/');
  return page === 'quotations' ? decodeURIComponent(sub) : '';
}

export function QuotationLanding({ preview, data, onLoaded }: { preview: boolean; data: Workspace; onLoaded: (customers: Client[]) => void }) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [route, setRoute] = useState(routeFromHash);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [createNow, setCreateNow] = useState(false);

  useEffect(() => {
    let active = true;
    crmRequest('entity=customers', undefined, preview ? data : undefined)
      .then(({ records }) => { if (active) { setCustomers(records); onLoaded(records.map(toClient)); } })
      .catch((cause: Error) => { if (active) setError(cause.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [preview]);
  useEffect(() => {
    const change = () => { const next = routeFromHash(); setRoute(next); if (!next) setCreateNow(false); };
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);

  const go = (sub: string) => { location.hash = sub ? `quotations/${encodeURIComponent(sub)}` : 'quotations'; };
  const selected = route && route !== 'archived' ? customers.find(customer => customer.id === route) || null : null;
  const visible = customers.filter(customer => `${customer.name} ${customer.contact || ''} ${customer.email || ''}`.toLowerCase().includes(search.toLowerCase()));
  const choose = (customer: Customer, create: boolean) => { setCreateNow(create); go(customer.id); };
  const back = <div className="toolbar"><button className="secondary" onClick={() => go('')}><ArrowLeft size={15}/> All customers</button></div>;

  return <>
    <div className="page-heading"><div><h1>Quotations</h1><p>{route === 'archived' ? 'Quotations kept after their customer was deleted.' : selected ? `Quotations for ${selected.name}` : 'Select a customer to create or view quotations.'}</p></div></div>
    {route === 'archived' ? <>{back}<ArchivedQuotations /></>
    : selected ? <>
      {back}
      <CustomerQuotations key={selected.id} customer={selected} preview={preview} createNow={createNow} onCreated={() => setCreateNow(false)}/>
    </> : route && loading ? <p role="status">Loading customer…</p>
    : <>
      {route && !loading && <p className="notice amber" role="alert">That customer is no longer available. Choose another customer.</p>}
      {!preview && <div className="toolbar quotation-toolbar"><button className="secondary" onClick={() => go('archived')}><Archive size={15}/> Archived quotations</button></div>}
      {error && <p className="notice amber" role="alert">{error}</p>}
      <div className="search-field"><Search size={15}/><input aria-label="Search customers for quotations" placeholder="Search customers, contacts or email" value={search} onChange={event => setSearch(event.target.value)}/></div>
      {loading ? <p role="status">Loading customers…</p> : !visible.length ? <div className="empty-state"><h2>{customers.length ? 'No matching customers' : 'No customers yet'}</h2><p>{customers.length ? 'Try another search.' : 'Add customers on the Customers page, then create their quotations here.'}</p></div> : <div className="customer-grid crm-cards">{visible.map(customer => <section className="panel crm-customer" key={customer.id}><h2>{customer.name}</h2><p>{customer.contact || customer.email || customer.phone || 'Add contact details'}</p><div className="button-row"><button className="secondary compact" onClick={() => choose(customer, false)}>View quotations</button><button className="primary compact" onClick={() => choose(customer, true)}>New quotation</button></div></section>)}</div>}
    </>}
  </>;
}

// Read-only list: these quotations can be downloaded or deleted, not edited, because the customer is gone.
function ArchivedQuotations() {
  const [records, setRecords] = useState<ArchivedQuotation[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [search, setSearch] = useState('');
  const load = () => crmRequest('action=archived-quotations').then(result => setRecords(result.records || [])).catch((cause: Error) => setError(cause.message));
  useEffect(() => { void load(); }, []);
  async function remove(q: ArchivedQuotation) {
    if (!window.confirm(`Delete estimate #${q.estimate_number} for ${q.archived_customer?.name || q.recipient_snapshot?.name || 'a removed customer'} permanently? This cannot be undone.`)) return;
    setBusy(q.id); setError('');
    try { await crmRequest('action=archived-quotations', { method: 'POST', body: JSON.stringify({ action: 'purge', id: q.id, version: q.version }) }); await load(); }
    catch (cause) { setError((cause as Error).message); } finally { setBusy(''); }
  }
  async function download(q: ArchivedQuotation) {
    setBusy(q.id); setError('');
    try { await exportCustomerQuotation(q); } catch (cause) { setError((cause as Error).message); } finally { setBusy(''); }
  }
  const shown = (records || []).filter(q => `${q.estimate_number} ${q.archived_customer?.name || ''} ${q.recipient_snapshot?.name || ''} ${q.items.map(item => item.product_service).join(' ')}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="panel">
    <div className="panel-heading"><div><h2>Archived quotations</h2><p className="small muted">Kept when a customer was deleted permanently. They stay here until you delete them.</p></div></div>
    {error && <p className="notice amber" role="alert">{error}</p>}
    <div className="search-field"><Search size={15}/><input aria-label="Search archived quotations" placeholder="Search customer, estimate number or item" value={search} onChange={event => setSearch(event.target.value)}/></div>
    {!records ? <p role="status">Loading archived quotations…</p> : !shown.length ? <div className="empty-state"><p>{records.length ? 'No archived quotations match your search.' : 'No archived quotations. Quotations appear here when you permanently delete a customer and choose to keep them.'}</p></div> :
      <div className="table-wrap"><table><thead><tr><th>Estimate</th><th>Former customer</th><th>Date</th><th>Status</th><th>Total</th><th>Actions</th></tr></thead><tbody>
        {shown.map(q => <tr key={q.id}><td>#{q.estimate_number}</td><td>{q.archived_customer?.name || q.recipient_snapshot?.name || 'Removed customer'}</td><td>{q.created_at.slice(0, 10)}</td><td>{q.status}</td><td>{cad(Number(q.grand_total))}</td>
          <td><div className="button-row"><button className="secondary compact" disabled={busy === q.id} onClick={() => void download(q)}><Download size={14}/> PDF</button><button className="secondary compact" disabled={busy === q.id} onClick={() => void remove(q)}><Trash2 size={14}/> Delete</button></div></td></tr>)}
      </tbody></table></div>}
  </section>;
}
