import { loadEnv } from 'vite';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import fs from 'node:fs';
const env=loadEnv('development',process.cwd(),'');
if(!env.SUPABASE_URL||!env.SUPABASE_SECRET_KEY||!env.OPENAI_API_KEY)throw new Error('Server database and embedding credentials are required.');
const db=createClient(env.SUPABASE_URL,env.SUPABASE_SECRET_KEY,{auth:{persistSession:false},global:{fetch:(url,opts)=>fetch(url,{...opts,signal:AbortSignal.timeout(60000)})}});
const checked=async q=>{let result;for(let attempt=0;attempt<3;attempt++){result=await q;if(!result.error)return result.data;if(!/fetch failed|timeout|ECONN|503|502/i.test(result.error.message||''))break;await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1)));}throw new Error(`${result.error.code||'database'}: ${result.error.message}`);};
const maxBatches=Number(process.argv.find(x=>x.startsWith('--batches='))?.split('=')[1]||1000);
const backfillLimit=Number(process.argv.find(x=>x.startsWith('--backfill='))?.split('=')[1]||10);
let direct;
if(env.DATABASE_URL){
 direct=new pg.Client({connectionString:env.DATABASE_URL,connectionTimeoutMillis:15000,query_timeout:120000,ssl:{rejectUnauthorized:true,ca:fs.readFileSync(env.DATABASE_CA_FILE||'prod-ca-2021.crt','utf8')}});
 await direct.connect();await direct.query("set statement_timeout='120s'");
}
const embeddingFetch=async(url,options)=>{for(let attempt=0;attempt<3;attempt++){try{return await fetch(url,{...options,signal:AbortSignal.timeout(90000)});}catch(error){if(attempt===2)throw error;await new Promise(resolve=>setTimeout(resolve,2000*(attempt+1)));}}};
let tokens=0,indexed=0;
const claim=async()=>direct?(await direct.query('select * from public.crm_claim_email_embeddings(64)')).rows:checked(db.rpc('crm_claim_email_embeddings',{p_limit:32}));
const finish=async(refs,error=null)=>direct?(await direct.query('select public.crm_finish_email_embeddings($1::jsonb,$2::text) n',[JSON.stringify(refs),error])).rows[0].n:checked(db.rpc('crm_finish_email_embeddings',{p_claims:refs,p_error:error}));
try {
for(let batch=0;batch<maxBatches;batch++){
 let claims=await claim();
 if(!claims.length&&backfillLimit>0){
  if(direct)await direct.query('select public.crm_queue_email_backfill($1)',[backfillLimit]);
  else await checked(db.rpc('crm_queue_email_backfill',{p_limit:backfillLimit}));
  claims=await claim();
 }
 if(!claims.length)break;
 const refs=claims.map(({id,lease_token,source_version})=>({id,lease_token,source_version}));
 try{
  const response=await embeddingFetch('https://api.openai.com/v1/embeddings',{method:'POST',headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:'text-embedding-3-small',dimensions:1536,input:claims.map(x=>x.content)}),signal:AbortSignal.timeout(90000)});
  const result=await response.json();
  if(!response.ok)throw new Error(`Embedding provider failed (${response.status}).`);
  if(result.data?.length!==claims.length)throw new Error('Incomplete embedding batch.');
  const rows=result.data.map(item=>{const c=claims[item.index];if(!c||item.embedding?.length!==1536||!item.embedding.every(Number.isFinite))throw new Error('Invalid embedding.');return {id:c.id,content:c.content,embedding:item.embedding,metadata:{queue_id:c.id,source_version:c.source_version,model:'text-embedding-3-small'}};});
  if(direct)await direct.query('insert into public.crm_email_vectors(id,content,metadata,embedding) select id,content,metadata,embedding::text::extensions.vector from jsonb_to_recordset($1::jsonb) as x(id uuid,content text,metadata jsonb,embedding jsonb) on conflict(id) do update set content=excluded.content,metadata=excluded.metadata,embedding=excluded.embedding',[JSON.stringify(rows)]);
  else await checked(db.from('crm_email_vectors').upsert(rows,{onConflict:'id'}));
  indexed+=await finish(refs);
  tokens+=result.usage?.total_tokens||0;
  console.log(JSON.stringify({batch:batch+1,indexed_chunks:indexed,embedding_tokens:tokens}));
 }catch(error){await finish(refs,'Embedding batch failed; retry needed.');throw error;}
}
console.log(JSON.stringify({status:direct?(await direct.query('select public.crm_email_index_status() status')).rows[0].status:await checked(db.rpc('crm_email_index_status')),embedding_tokens:tokens}));
} finally {if(direct)await direct.end();}
