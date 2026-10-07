const email=value=>typeof value==='string'&&value.length<=320&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const roles=['employee','customer','lead','supplier','wholesale_partner'];
const topics=['support','upgrade','quotation','billing','meeting','incomplete_inquiry'];
const checked=async query=>{const {data,error}=await query;if(error)throw error;return data;};

// Called inside crmHandler after owner authentication and origin verification.
export async function emailBrainRequest(db,req,url,input) {
  if(req.method==='GET') {
    const [categories,routes,requests,learning]=await Promise.all([
      checked(db.rpc('crm_email_categories')),
      checked(db.from('product_supplier_routes').select('*').order('product_name').limit(500)),
      checked(db.from('supplier_price_requests').select('*').order('created_at',{ascending:false}).limit(100)),
      checked(db.from('email_learning_examples').select('draft_id,thread_id,recipient_emails,confirmed_at,enabled').order('confirmed_at',{ascending:false}).limit(100)),
    ]);
    return {categories,routes,requests,learning};
  }
  if(req.method!=='POST')throw new Error('Use POST to update email classifications.');
  switch(input.operation) {
    case 'role': {
      const address=String(input.email||'').trim().toLowerCase();
      if(!email(address)||!roles.includes(input.role)||String(input.company||'').length>200)throw new Error('Choose a valid email and classification.');
      if(address.split('@')[1]==='dcx-tech.com')throw new Error('DCX domain addresses are classified as employees automatically.');
      await checked(db.from('email_correspondent_roles').upsert({email:address,role:input.role,company:String(input.company||'').trim(),updated_at:new Date().toISOString()}));break;
    }
    case 'topic': {
      if(!topics.includes(input.topic)||!/^[-0-9a-f]{36}$/i.test(input.thread_id||''))throw new Error('Select a conversation and category.');
      await checked(db.from('email_threads').update({topic:input.topic,topic_source:'owner',updated_at:new Date().toISOString()}).eq('id',input.thread_id));break;
    }
    case 'route': {
      const address=String(input.supplier_email||'').trim().toLowerCase(),sku=String(input.sku||'').trim(),name=String(input.product_name||'').trim();
      if(!email(address)||!sku||sku.length>100||!name||name.length>200||typeof input.auto_request!=='boolean')throw new Error('Enter a SKU, product name and supplier email.');
      if(address.split('@')[1]==='dcx-tech.com')throw new Error('Choose the supplier email, rather than a staff address.');
      const row={sku,product_name:name,supplier_email:address,auto_request:input.auto_request,updated_at:new Date().toISOString()};
      if(input.id){
        if(!Number.isFinite(Date.parse(input.updated_at)))throw new Error('Reload the supplier route first.');
        const result=await checked(db.from('product_supplier_routes').update(row).eq('id',input.id).eq('updated_at',input.updated_at).select().maybeSingle());
        if(!result)throw new Error('Supplier route changed. Reload it.');
      }else await checked(db.from('product_supplier_routes').insert(row));break;
    }
    case 'delete-route': {
      if(!input.id||!Number.isFinite(Date.parse(input.updated_at)))throw new Error('Reload the supplier route first.');
      await checked(db.from('product_supplier_routes').delete().eq('id',input.id).eq('updated_at',input.updated_at));break;
    }
    case 'request': {
      if(!/^[-0-9a-f]{36}$/i.test(input.thread_id||'')||typeof input.sku!=='string'||!input.sku.trim()||input.sku.length>100)throw new Error('Select a conversation and enter its exact SKU.');
      const quantity=input.quantity===null?null:Number(input.quantity);
      if(quantity!==null&&(!Number.isFinite(quantity)||quantity<=0||quantity>1000000))throw new Error('Enter a valid quantity or leave it unconfirmed.');
      const m=await checked(db.from('email_messages').select('id').eq('thread_id',input.thread_id).eq('direction','incoming').order('occurred_at',{ascending:false}).limit(1).single());
      return {success:true,request:await checked(db.rpc('crm_supplier_request',{p_message_id:m.id,p_sku:input.sku.trim(),p_quantity:quantity}))};
    }
    case 'learning': {
      if(!input.draft_id||typeof input.enabled!=='boolean')throw new Error('Choose a learning example.');
      await checked(db.from('email_learning_examples').update({enabled:input.enabled}).eq('draft_id',input.draft_id));break;
    }
    case 'resolve-request': {
      const quantity=input.quantity===null?null:Number(input.quantity);
      if(!/^[-0-9a-f]{36}$/i.test(input.id||'')||typeof input.approve!=='boolean'||(quantity!==null&&(!Number.isFinite(quantity)||quantity<=0||quantity>1000000)))throw new Error('Choose a request and a valid quantity.');
      return {success:true,request:await checked(db.rpc('crm_resolve_supplier_request',{p_id:input.id,p_quantity:quantity,p_approve:input.approve}))};
    }
    case 'cancel-request': {
      if(!input.id)throw new Error('Choose a price request.');
      const result=await checked(db.from('supplier_price_requests').update({status:'cancelled',updated_at:new Date().toISOString()}).eq('id',input.id).in('status',['queued','needs_details','needs_supplier','awaiting_approval']).select().maybeSingle());
      if(!result)throw new Error('This request has already been dispatched or changed.');break;
    }
    default:throw new Error('Unknown email brain operation.');
  }
  return {success:true};
}
