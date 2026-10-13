import { PricingAgreementPicker } from './PricingAgreementPicker';
import { useEffect, useState, type ReactNode } from 'react';
import { Plus, Search, ArrowLeft, RefreshCw } from 'lucide-react';
import type { Client, Workspace } from '../../types/operations';
import { CustomerProposals } from './CustomerProposals';
import { crmRequest, toClient } from '../../lib/crm-client';

type Row = Record<string, any>;
type Field = { key: string; label: string; required?: boolean; type?: string };
const fields: Record<string, Field[]> = {
  customers: [{ key: 'name', label: 'Company / customer name', required: true }, { key: 'relationship_type', label: 'Classification', type: 'classification' }, { key: 'contact', label: 'Primary contact' }, { key: 'email', label: 'Primary email', type: 'email' }, { key: 'phone', label: 'Phone' }, { key: 'billing_address', label: 'Billing address', type: 'textarea' }, { key: 'price_book', label: 'Pricing agreement', type: 'books' }, { key: 'notes', label: 'Notes', type: 'textarea' }],
  contacts: [{ key: 'name', label: 'Contact name', required: true }, { key: 'email', label: 'Email', required: true, type: 'email' }, { key: 'phone', label: 'Phone' }, { key: 'notes', label: 'Notes', type: 'textarea' }],
  sites: [{ key: 'name', label: 'Site name', required: true }, { key: 'address', label: 'Service address', required: true }, { key: 'notes', label: 'Notes', type: 'textarea' }],
  equipment: [{ key: 'name', label: 'Equipment label', required: true }, { key: 'site_id', label: 'Installed at', required: true, type: 'sites' }, { key: 'model', label: 'Model' }, { key: 'serial_number', label: 'Serial number' }, { key: 'battery_configuration', label: 'Battery configuration' }, { key: 'source', label: 'Source / evidence reference' }, { key: 'confirmed_on', label: 'Last confirmed', type: 'date' }, { key: 'notes', label: 'Notes', type: 'textarea' }],
  purchases: [{ key: 'name', label: 'Purchased items / completed order', required: true }, { key: 'equipment_id', label: 'Related equipment', type: 'equipment' }, { key: 'occurred_on', label: 'Purchase date', required: true, type: 'date' }, { key: 'amount', label: 'Total CAD (optional)', type: 'number' }, { key: 'source', label: 'Invoice / completed order reference', required: true }, { key: 'notes', label: 'Notes', type: 'textarea' }],
  services: [{ key: 'name', label: 'Service performed', required: true }, { key: 'equipment_id', label: 'Related equipment', type: 'equipment' }, { key: 'occurred_on', label: 'Service date', required: true, type: 'date' }, { key: 'source', label: 'Service report / confirmation reference', required: true }, { key: 'notes', label: 'Notes', type: 'textarea' }],
};
const labels: Record<string, string> = { contacts: 'Contacts', sites: 'Sites', equipment: 'Equipment', purchases: 'Purchases', services: 'Service history' };
export function CustomerHub({ preview, onLoaded, onQuote, focusId, data, renderQuotes, quoteFocus, onCreateAgreement, onDeleteAgreement }: { preview: boolean; onLoaded: (clients: Client[]) => void; onQuote: (id: string) => void; focusId?: string; data: Workspace; renderQuotes: (id: string) => ReactNode; quoteFocus?: string; onCreateAgreement:(name:string,sourceId:string)=>Promise<string>; onDeleteAgreement:(id:string)=>Promise<void> }) {
  const api = (query: string, options?: RequestInit) => crmRequest(query, options, preview ? data : undefined);
  const [customers, setCustomers] = useState<Row[]>([]);
  const [selected, setSelected] = useState(focusId && !['new','proposal','quotation'].includes(focusId) ? focusId : '');
  const [tab, setTab] = useState(quoteFocus ? 'calculator' : 'contacts');
  const [history, setHistory] = useState<Record<string, Row[]>>({});
  const [search, setSearch] = useState('');
  const [trash,setTrash]=useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [edit, setEdit] = useState<{ entity: string; row: Row } | null>(focusId === 'new' ? { entity: 'customers', row: {} } : null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(''); setHistory({});
    (async () => {
      try {
        const { records } = await api(`entity=customers&trash=${trash}`);
        const entries = selected ? await Promise.all(Object.keys(labels).map(async entity => [entity, (await api(`entity=${entity}&customer_id=${encodeURIComponent(selected)}`)).records])) : [];
        if (cancelled) return;
        setCustomers(records); setHistory(Object.fromEntries(entries));
        onLoaded((trash ? (await api('entity=customers')).records : records).map(toClient));
      } catch (e) { if (!cancelled) setError((e as Error).message); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [selected, revision, preview, trash]);
  function open(entity: string, row?: Row) { setSaveError(''); setEdit({ entity, row: row ? { ...row } : { customer_id: selected } }); }
  async function save(e: React.FormEvent) {
    e.preventDefault(); if (!edit || saving) return;
    setSaving(true); setSaveError('');
    try {
      const row=edit.entity==='customers'?{...edit.row,price_book:edit.row.price_book||data.books[0]?.id}:edit.row;
      const result = await api(`entity=${edit.entity}`, { method: edit.row.id ? 'PATCH' : 'POST', body: JSON.stringify(row) });
      if (edit.entity === 'customers') setSelected(result.record.id);
      setEdit(null); setRevision(r => r + 1); setMessage('Saved.');
    } catch (e) { setSaveError((e as Error).message); }
    finally { setSaving(false); }
  }
  // One dialog for removing a customer: it counts their quotations and lets the owner choose to move the
  // customer to Deleted customers (restorable, everything kept) or delete permanently, keeping or deleting quotations.
  type Choice='trash'|'keep'|'delete';
  const [removal,setRemoval]=useState<{row:Row;quotations:number|null;choice:Choice}|null>(null);
  async function openRemoval(row:Row){
    setRemoval({row,quotations:null,choice:trash?'keep':'trash'});
    try{const [active,trashed]=await Promise.all(['false','true'].map(t=>api(`action=quotations&customer_id=${encodeURIComponent(row.id)}&trash=${t}`)));setRemoval(p=>p&&p.row.id===row.id?{...p,quotations:active.records.length+trashed.records.length}:p);}
    catch{setRemoval(p=>p&&p.row.id===row.id?{...p,quotations:-1}:p);}
  }
  async function restoreCustomer(row: Row) {
    if(saving)return;
    setSaving(true);setError('');
    try { await api('entity=customers&action=restore-customer',{method:'POST',body:JSON.stringify({id:row.id,updated_at:row.updated_at})});setMessage(`${row.name} was restored with its quotations and history.`);setSelected('');setRevision(r=>r+1); }catch(e){setError((e as Error).message);}finally{setSaving(false);}
  }
  async function confirmRemoval(){
    if(!removal||saving)return;
    const {row,choice}=removal;
    setSaving(true);setError('');
    try{
      if(choice==='trash'){await api('entity=customers',{method:'DELETE',body:JSON.stringify({id:row.id,updated_at:row.updated_at})});setMessage(`${row.name} moved to Deleted customers. Restore it any time; its quotations stay with it.`);}
      else{const result=await api('action=purge-customer',{method:'POST',body:JSON.stringify({id:row.id,updated_at:row.updated_at,keep_records:choice==='keep'})});setMessage(`${row.name} was deleted permanently.${result.quotations?choice==='keep'?` ${result.quotations} quotation${result.quotations===1?' was':'s were'} kept under Quotations › Archived quotations.`:` ${result.quotations} quotation${result.quotations===1?' was':'s were'} deleted.`:''}`);}
      setRemoval(null);setSelected('');setRevision(r=>r+1);
    }catch(e){setError((e as Error).message);setRemoval(null);}finally{setSaving(false);}
  }
  const customer = customers.find(c => c.id === selected);
  const rows = history[tab] || [];
  return <div className="customer-hub">
    {removal && <div className="modal-backdrop"><section className="detail-modal purge-dialog" role="dialog" aria-modal="true" aria-label={`Delete ${removal.row.name}`}>
      <div className="panel-heading"><h2>Delete {removal.row.name}?</h2></div>
      <p><strong>{removal.quotations===null?'Checking quotations…':removal.quotations<0?'Quotations could not be counted.':removal.quotations?`This customer has ${removal.quotations} quotation${removal.quotations===1?'':'s'}.`:'This customer has no quotations.'}</strong></p>
      {!trash && <label className="purge-choice"><input type="radio" name="customer-removal" checked={removal.choice==='trash'} onChange={()=>setRemoval({...removal,choice:'trash'})}/> <span><b>Move to Deleted customers</b> (recommended). Hidden from your lists, but you can restore it any time with its contacts, history and quotations.</span></label>}
      <label className="purge-choice"><input type="radio" name="customer-removal" checked={removal.choice==='keep'} onChange={()=>setRemoval({...removal,choice:'keep'})}/> <span><b>Delete permanently, keep the quotations.</b> The customer and its contacts, sites, equipment and history are removed for good. Quotations move to Quotations › Archived quotations under the customer's name until you delete them.</span></label>
      <label className="purge-choice"><input type="radio" name="customer-removal" checked={removal.choice==='delete'} onChange={()=>setRemoval({...removal,choice:'delete'})}/> <span><b>Delete permanently, including the quotations.</b> Nothing about this customer is kept. Email conversations stay in the mailbox.</span></label>
      <div className="button-row"><button className="secondary" disabled={saving} onClick={()=>setRemoval(null)}>Cancel</button><button className={`primary${removal.choice==='trash'?'':' danger'}`} disabled={saving||removal.quotations===null} onClick={()=>void confirmRemoval()}>{saving?'Working…':removal.choice==='trash'?'Move to Deleted customers':'Delete permanently'}</button></div>
    </section></div>}
    <div className="page-heading"><div><h1>{customer?.name || 'Customers'}</h1><p>{customer ? 'Contact details and service history.' : 'Find and manage your customers.'}</p></div></div>
    <>
      <div className="toolbar"><button className="secondary" onClick={()=>{setSelected('');setTrash(v=>!v);}}>{trash ? 'Active customers' : 'Deleted customers'}</button>{selected ? <button className="secondary" onClick={() => { setSelected(''); setMessage(''); }}><ArrowLeft size={15} /> All customers</button> : <><button className="secondary" disabled={loading || saving} onClick={() => { setRevision(r => r + 1); }}><RefreshCw size={15} /> Refresh</button><button className="primary" disabled={loading || !!error} onClick={() => open('customers')}><Plus size={15} /> Add customer</button></>}</div>
      {error && <div role="alert" className="notice amber">{error} Your unsaved form stays open if a save fails.</div>}
      {message && <p role="status" className="notice">{message}</p>}
      {loading ? <p role="status">Loading customer records…</p> : !error && <>
        {!customer ? <><div className="search-field"><Search size={15} /><input aria-label="Search customer companies" placeholder="Search customers, contacts or email" value={search} onChange={e => setSearch(e.target.value)} /></div><div className="customer-grid crm-cards">{customers.filter(c => `${c.name} ${c.contact || ''} ${c.email || ''} ${c.notes}`.toLowerCase().includes(search.toLowerCase())).map(c => <section className="panel crm-customer" key={c.id}><h2>{c.name}</h2><p>{c.contact || c.email || c.phone || 'Add contact details'}</p><p>{c.notes || 'Open profile to add contacts and history.'}</p><button className="text-button" onClick={() => { setSelected(c.id); setMessage(''); }}>View customer</button><span className="pill">{c.relationship_type || 'customer'}</span>{trash ? <><button className="text-button" disabled={saving} onClick={()=>void restoreCustomer(c)}>Restore</button><button className="text-button danger-text" disabled={saving} onClick={()=>void openRemoval(c)}>Delete permanently</button></> : <button className="text-button" disabled={saving} onClick={()=>void openRemoval(c)}>Delete customer</button>}</section>)}</div>{!customers.length && <div className="empty-state"><h2>No customers yet</h2><p>Add a customer, then their contacts and sites.</p></div>}</> : <>
          <section className="panel customer-profile"><div className="panel-heading"><div><span className={`pill ${customer.price_book === 'bgis' ? 'purple' : 'neutral'}`}>{data.books.find(b => b.id === customer.price_book)?.name || 'Standard'} pricing</span><h2>{customer.contact || 'Primary contact to add'}</h2></div><div className="button-row"><button className="secondary" disabled={trash} onClick={() => open('customers', customer)}>Edit customer</button>{trash ? <><button className="secondary" disabled={saving} onClick={()=>void restoreCustomer(customer)}>Restore customer</button><button className="secondary danger-text" disabled={saving} onClick={()=>void openRemoval(customer)}>Delete permanently</button></> : <button className="secondary" disabled={saving} onClick={()=>void openRemoval(customer)}>Delete customer</button>}</div></div><div className="profile-contact-grid"><div><small>EMAIL</small><p>{customer.email || 'Not recorded'}</p></div><div><small>PHONE</small><p>{customer.phone || 'Not recorded'}</p></div><div><small>BILLING ADDRESS</small><p className="pre-line">{customer.billing_address || 'Not recorded'}</p></div></div>{customer.notes && <p className="profile-notes">{customer.notes}</p>}{customer.price_book === 'bgis' && <p className="notice amber">BGIS has a separate rate book. Example rates require review before a quotation can be approved.</p>}<p className="small muted">{history.sites?.length || 0} sites · {history.equipment?.length || 0} equipment records</p></section>
          <label className="customer-section-picker">Customer records <select aria-label="Customer records section" value={tab} onChange={event => setTab(event.target.value)}><option value="contacts">Contacts ({history.contacts?.length || 0})</option><option value="sites">Sites ({history.sites?.length || 0})</option><option value="equipment">Equipment ({history.equipment?.length || 0})</option><option value="purchases">Purchases ({history.purchases?.length || 0})</option><option value="services">Service history ({history.services?.length || 0})</option><option value="calculator">Earlier calculator quotes ({data.quotes.filter(q => q.customerId === customer.id).length})</option><option value="proposals">Earlier proposals</option></select></label>
          {tab === 'calculator' ? renderQuotes(customer.id) : tab === 'proposals' ? <CustomerProposals key={customer.id} customer={customer} preview={preview} createNow={false} onCreated={()=>{}}/> : <section className="panel"><div className="panel-heading"><h2>{labels[tab]}</h2><button className="secondary" disabled={tab === 'equipment' && !history.sites?.length} onClick={() => open(tab)}><Plus size={14} /> Add record</button></div>{tab === 'equipment' && !history.sites?.length && <p>Add a site before recording installed equipment.</p>}{tab === 'purchases' && <p className="small muted">Record completed purchases with an invoice or order reference. An offered quotation does not confirm a purchase.</p>}{!rows.length && <p className="muted">No records yet.</p>}{rows.map(row => <article className="crm-record" key={row.id}><div><h3>{row.name}</h3>{fields[tab].filter(f => f.key !== 'name' && row[f.key] !== null && row[f.key] !== '').map(f => <p key={f.key}><strong>{f.label}: </strong>{f.type === 'sites' || f.type === 'equipment' ? history[f.type]?.find(r => r.id === row[f.key])?.name || 'Unresolved record' : String(row[f.key] ?? '')}</p>)}</div><button className="secondary compact" onClick={() => open(tab, row)}>Edit</button></article>)}</section>}
        </>}

      </>}
    </>
    {edit && <div className="modal-backdrop"><form className="detail-modal" role="dialog" aria-modal="true" aria-label="Customer record editor" onSubmit={save}><div className="panel-heading"><h2>{edit.row.id ? 'Edit' : 'Add'} {edit.entity === 'customers' ? 'customer' : labels[edit.entity].toLowerCase()}</h2><button className="text-button" type="button" disabled={saving} onClick={() => setEdit(null)}>Close</button></div>
      <div className="form-grid">{fields[edit.entity].map(f => {
        const set = (value: string) => setEdit({ ...edit, row: { ...edit.row, [f.key]: value } });
        if(f.type==='books')return <fieldset className="customer-agreement-field" key={f.key}><legend>{f.label}</legend><PricingAgreementPicker books={data.books} value={edit.row[f.key]||data.books[0]?.id||''} onChange={set} onCreate={onCreateAgreement} onDelete={onDeleteAgreement} disabled={saving}/></fieldset>;
        return <label className={f.type === 'textarea' ? 'span-2' : ''} key={f.key}>{f.label}{f.required ? ' *' : ''}{f.type === 'classification' ? <select value={edit.row[f.key] || 'customer'} onChange={e=>set(e.target.value)}>{['employee','customer','lead','supplier','wholesale_partner'].map(role=><option key={role} value={role}>{role.replace(/_/g,' ')}</option>)}</select> : f.type === 'textarea' ? <textarea disabled={saving} maxLength={10000} rows={3} value={edit.row[f.key] || ''} onChange={e => set(e.target.value)} /> : ['sites','equipment','books'].includes(f.type || '') ? <select disabled={saving} required={f.required} value={edit.row[f.key] || (f.type === 'books' ? 'standard' : '')} onChange={e => set(e.target.value)}>{f.type !== 'books' && <option value="">Select {f.required ? 'a record' : '(optional)'}</option>}{(f.type === 'books' ? data.books : history[f.type!] || []).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select> : <input disabled={saving} required={f.required} maxLength={1000} type={f.type || 'text'} min={f.type === 'number' ? 0 : undefined} max={f.type === 'number' ? 999999999 : undefined} step={f.type === 'number' ? '0.01' : undefined} value={edit.row[f.key] ?? ''} onChange={e => set(e.target.value)} />}</label>;
      })}</div>{saveError && <p className="form-error" role="alert">{saveError}</p>}<button className="primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button></form></div>}
  </div>;
}
