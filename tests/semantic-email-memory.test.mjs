import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {retrieveEmailMemory} from '../server/email-memory.js';

async function setup(t){
 const pg=new PGlite();t.after(()=>pg.close());
 await pg.exec('create role anon;create role authenticated;create role service_role;create schema extensions;');
 for(const f of (await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')&&!f.includes('knowledge_foundation')&&f<'20261005').sort())await pg.exec(await readFile(new URL('../supabase/migrations/'+f,import.meta.url),'utf8'));
 // PGlite has no pgvector binary. Exercise real PostgreSQL queue/scope SQL with
 // equivalent cosine arithmetic; the deployed 1536-vector RPC is checked live.
 await pg.exec(`create function extensions.test_cosine(a real[],b real[]) returns double precision language sql immutable as $$ select 1-sum(a[i]*b[i])/nullif(sqrt(sum(a[i]*a[i]))*sqrt(sum(b[i]*b[i])),0) from generate_subscripts(a,1) i $$;
 create operator extensions.<=> (leftarg=real[],rightarg=real[],function=extensions.test_cosine);`);
 let sql=await readFile(new URL('../supabase/migrations/202610050001_semantic_email_memory.sql',import.meta.url),'utf8');
 await pg.exec(sql.replace('create extension if not exists vector with schema extensions;','').replaceAll('extensions.vector(1536)','real[]'));
 await pg.exec(await readFile(new URL('../supabase/migrations/202610060002_email_backfill_performance.sql',import.meta.url),'utf8'));
 return pg;
}
async function archived(pg,id,address,body,date='2026-03-01'){
 await pg.query(`insert into crm_email_archive(source_key,archive_id,source_id,folder,thread_key,sender_email,participant_emails,subject,body_text,sent_at)
 values($1,'test',$1,'Inbox',$1,$2,array[$2],'Request',$3,$4)`,[id,address,body,date]);
}
async function store(pg,claim,embedding){
 await pg.query('insert into crm_email_vectors(content,metadata,embedding) values($1,$2::jsonb,$3::real[])',[claim.content,JSON.stringify({queue_id:claim.id,source_version:claim.source_version}),embedding]);
}
test('hybrid retrieval finds a paraphrased old request, isolates address/mailbox and rejects stale/deleted evidence',async t=>{
 const pg=await setup(t);
 const box=(await pg.query("insert into email_mailboxes(provider,address) values('microsoft','owner@example.com') returning id")).rows[0].id;
 await archived(pg,'old','customer@example.com','Replace the worn power cells.');
 await archived(pg,'recent','customer@example.com','Hello again','2026-10-05');
 await archived(pg,'private','other@example.com','Replace worn power cells.');
 const claims=(await pg.query('select * from crm_claim_email_embeddings(32)')).rows;
 for(const c of claims)await store(pg,c,c.source_id==='recent'?[0,1]:[1,0]);
 const filter={address:'customer@example.com',mailbox_id:box,query:'battery renewal'};
 const query=()=>pg.query('select * from match_email_memory_chunks($1::real[],1,$2::jsonb)',[[1,0],JSON.stringify(filter)]);
 const found=(await query()).rows;assert.equal(found.length,1);assert.equal(found[0].metadata.id,'old');
 assert.equal((await pg.query("select * from match_email_memory_chunks(array[1,0]::real[],10,'{}')")).rows.length,0);
 await pg.query("update crm_email_archive set body_text='Different request' where source_key='old'");
 assert.equal((await query()).rows.length,0,'old vector must be excluded immediately after a source change');
 await pg.query("delete from crm_email_archive where source_key='private'");
 assert.equal((await pg.query("select * from crm_email_embedding_queue where source_id='private'")).rows.length,0);
 await pg.exec('set role authenticated');await assert.rejects(pg.query('select * from crm_email_vectors'),/permission denied/);
 await assert.rejects(pg.query("select crm_email_index_status()"),/permission denied/);
});
test('index queue is incremental, bounded and rejects stale lease completion',async t=>{
 const pg=await setup(t);await archived(pg,'long','customer@example.com','x'.repeat(8000));
 assert.equal((await pg.query('select count(*) n from crm_email_embedding_queue')).rows[0].n,3);
 assert.equal((await pg.query('select crm_queue_email_backfill(200) n')).rows[0].n,0);
 const claim=(await pg.query('select * from crm_claim_email_embeddings(1)')).rows[0];
 await store(pg,claim,[1,0]);
 await pg.query("update crm_email_archive set body_text='Changed' where source_key='long'");
 const done=await pg.query('select crm_finish_email_embeddings($1::jsonb) n',[JSON.stringify([claim])]);
 assert.equal(done.rows[0].n,0);assert.equal((await pg.query('select count(*) n from crm_email_embedding_queue')).rows[0].n,1);
});
test('customer facts distinguish purchases from quotations and stop ambiguous customer association',async t=>{
 const pg=await setup(t);
 const id=(await pg.query("insert into crm_customers(name,email) values('Customer','customer@example.com') returning id")).rows[0].id;
 await pg.query("insert into crm_purchases(customer_id,name,occurred_on,amount,source) values($1,'Verified batteries','2026-02-01',100,'Synthetic verified test')",[id]);
 const result=(await pg.query("select crm_customer_memory('customer@example.com') r")).rows[0].r;
 assert.equal(result.status,'matched');assert.equal(result.purchases.length,1);assert.equal(result.quotations.length,0);
 await pg.query("insert into crm_customers(name,email) values('Different customer','customer@example.com')");
 const ambiguous=(await pg.query("select crm_customer_memory('customer@example.com') r")).rows[0].r;
 assert.equal(ambiguous.status,'needs_review');assert.equal(ambiguous.purchases,undefined);
});
test('application lookup passes the exact mailbox/address to hybrid search and reports missing semantic setup',async()=>{
 const messages=[{from:{emailAddress:{address:'customer@example.com'}},subject:'Previous requirement',body:{content:'Please revisit our old request'}}];
 const calls=[];const db={rpc:async(name,args)=>{calls.push({name,args});return name==='crm_email_memory_hybrid'?{error:{code:'PGRST202'}}:{data:{messages:[],matching_messages:0}};}};
 const result=await retrieveEmailMemory(db,messages,'owner@example.com',Array(1536).fill(0.1));
 assert.equal(calls[0].args.p_mailbox_address,'owner@example.com');assert.deepEqual(calls[0].args.p_addresses,['customer@example.com']);
 assert.equal(result.semantic_status,'not_configured');assert.equal(result.retrieval,'keyword_and_recent');
});

