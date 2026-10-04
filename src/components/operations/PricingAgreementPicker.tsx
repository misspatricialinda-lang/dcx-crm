import {useState} from 'react';
import type {PriceBook} from '../../types/operations';

export function PricingAgreementPicker({books,value,onChange,onCreate,onDelete,disabled=false}:{books:PriceBook[];value:string;onChange:(id:string)=>void;onCreate:(name:string,sourceId:string)=>Promise<string>;onDelete:(id:string)=>Promise<void>;disabled?:boolean}){
  const [adding,setAdding]=useState(false),[name,setName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const selected=books.find(b=>b.id===value)||books[0];
  async function create(){
    if(!name.trim()||!selected||busy)return;
    setBusy(true);setError('');
    try{const id=await onCreate(name.trim(),selected.id);onChange(id);setAdding(false);setName('');}catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  async function remove(){
    if(!selected||busy||books.length<2||!window.confirm(`Remove ${selected.name} pricing agreement? Saved quotation history will be retained.`))return;
    setBusy(true);setError('');
    try{await onDelete(selected.id);onChange(books.find(b=>b.id!==selected.id)!.id);}catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <div className="pricing-agreement-picker">
    <select aria-label="Pricing agreement" disabled={disabled||busy} value={selected?.id||''} onChange={e=>{onChange(e.target.value);setError('');}}>{books.map(b=><option key={b.id} value={b.id}>{b.name} · v{b.version}</option>)}</select>
    <div className="button-row"><button type="button" className="secondary compact" disabled={disabled||busy} onClick={()=>setAdding(!adding)}>Add agreement</button><button type="button" className="secondary compact" disabled={disabled||busy||books.length<2} onClick={()=>void remove()}>Remove agreement</button></div>
    {adding&&<div className="agreement-create"><input aria-label="New customer pricing agreement name" placeholder="New customer / agreement name" maxLength={120} value={name} disabled={busy||disabled} onChange={e=>setName(e.target.value)}/><p className="field-help">Starts with {selected?.name}'s rates. Edit the new rates in the cost calculator.</p><button type="button" className="secondary compact" disabled={busy||disabled||!name.trim()} onClick={()=>void create()}>{busy?'Creating…':'Create agreement'}</button></div>}
    {error&&<p className="form-error" role="alert">{error}</p>}
  </div>;
}
