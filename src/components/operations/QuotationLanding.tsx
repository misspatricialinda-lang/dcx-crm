import { useEffect, useState } from 'react';
import { ArrowLeft, Plus, Search } from 'lucide-react';
import { crmRequest, toClient } from '../../lib/crm-client';
import type { Client, Workspace } from '../../types/operations';
import { CustomerQuotations } from './CustomerQuotations';

type Customer = Record<string, any>;

export function QuotationLanding({ preview, data, onLoaded, onAddCustomer }: { preview: boolean; data: Workspace; onLoaded: (customers: Client[]) => void; onAddCustomer: () => void }) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selected, setSelected] = useState<Customer | null>(null);
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

  const visible = customers.filter(customer => `${customer.name} ${customer.contact || ''} ${customer.email || ''}`.toLowerCase().includes(search.toLowerCase()));
  const choose = (customer: Customer, create: boolean) => { setSelected(customer); setCreateNow(create); };

  return <>
    <div className="page-heading"><div><h1>Quotations</h1><p>{selected ? `Quotations for ${selected.name}` : 'Select a customer to create or view quotations.'}</p></div></div>
    {selected ? <>
      <div className="toolbar"><button className="secondary" onClick={() => { setSelected(null); setCreateNow(false); }}><ArrowLeft size={15}/> All customers</button></div>
      <CustomerQuotations key={selected.id} customer={selected} preview={preview} createNow={createNow} onCreated={() => setCreateNow(false)}/>
    </> : <>
      <div className="toolbar"><button className="primary" onClick={onAddCustomer}><Plus size={15}/> Add customer</button></div>
      {error && <p className="notice amber" role="alert">{error}</p>}
      <div className="search-field"><Search size={15}/><input aria-label="Search customers for quotations" placeholder="Search customers, contacts or email" value={search} onChange={event => setSearch(event.target.value)}/></div>
      {loading ? <p role="status">Loading customers…</p> : !visible.length ? <div className="empty-state"><h2>{customers.length ? 'No matching customers' : 'No customers yet'}</h2><p>{customers.length ? 'Try another search.' : 'Add a customer to create their first quotation.'}</p></div> : <div className="customer-grid crm-cards">{visible.map(customer => <section className="panel crm-customer" key={customer.id}><h2>{customer.name}</h2><p>{customer.contact || customer.email || customer.phone || 'Add contact details'}</p><div className="button-row"><button className="secondary compact" onClick={() => choose(customer, false)}>View quotations</button><button className="primary compact" onClick={() => choose(customer, true)}>New quotation</button></div></section>)}</div>}
    </>}
  </>;
}
