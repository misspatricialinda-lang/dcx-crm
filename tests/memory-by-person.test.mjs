import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const migration=name=>readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
const vectorless=sql=>sql.replace('create extension if not exists vector with schema extensions;','').replaceAll('extensions.vector(1536)','real[]');
async function setup(t){
 const pg=new PGlite();t.after(()=>pg.close());
 await pg.exec('create role anon;create role authenticated;create role service_role;create schema extensions;');
 for(const f of (await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')&&!f.includes('knowledge_foundation')&&f<'20261005').sort())await pg.exec(await migration(f));
 await pg.exec(`create function extensions.test_cosine(a real[],b real[]) returns double precision language sql immutable as $$ select 1-sum(a[i]*b[i])/nullif(sqrt(sum(a[i]*a[i]))*sqrt(sum(b[i]*b[i])),0) from generate_subscripts(a,1) i $$;
 create operator extensions.<=> (leftarg=real[],rightarg=real[],function=extensions.test_cosine);`);
 await pg.exec(vectorless(await migration('202610050001_semantic_email_memory.sql')));
 await pg.exec(vectorless(await migration('202610130001_memory_by_person.sql')));
 return pg;
}
const CUSTOMER='alex@example.com';
async function archived(pg,key,sender,participants,subject,body,date,{imid=null,irt=null}={}){
 await pg.query(`insert into crm_email_archive(source_key,archive_id,source_id,folder,thread_key,sender_email,participant_emails,subject,body_text,sent_at,internet_message_id,in_reply_to)
 values($1,'pst',$1,'Inbox',$1,$2,$3,$4,$5,$6,$7,$8)`,[key,sender,participants,subject,body,date,imid,irt]);
}
async function mailbox(pg,address){return (await pg.query("insert into email_mailboxes(provider,address) values('microsoft',$1) returning id",[address])).rows[0].id;}
let n=0;
async function conversation(pg,box,subject,turns){
 const thread=(await pg.query('insert into email_threads(mailbox_id,provider_thread_key,subject) values($1,$2,$3) returning id',[box,'conv-'+(++n),subject])).rows[0].id;
 for(const [direction,body,date] of turns){
  const sender=direction==='incoming'?CUSTOMER:'owner@dcx.example';
  const to=direction==='incoming'?['owner@dcx.example']:[CUSTOMER];
  await pg.query(`insert into email_messages(thread_id,mailbox_id,provider_key,provider_ref,direction,sender,to_addresses,subject,body_text,body_loaded,occurred_at)
  values($1,$2,$3,$3,$4,$5,$6::jsonb,$7,$8,true,$9)`,[thread,box,'m-'+(++n),direction,sender,JSON.stringify(to),subject,body,date]);
 }
 return thread;
}
const ids=result=>result.messages.map(m=>m.id);
const subjects=result=>result.messages.map(m=>m.subject);

test('internal forwards that only list the address are not that person\'s memory',async t=>{
 const pg=await setup(t);
 await archived(pg,'own','alex@example.com',['alex@example.com','raza@dcx.example'],'Hospital UPS','Ten rooms, Eaton 93PX','2026-05-01',{imid:'<a1>'});
 await archived(pg,'reply','raza@dcx.example',['raza@dcx.example','alex@example.com'],'Re: Hospital UPS','Please send the nameplate','2026-05-02',{imid:'<r1>',irt:'<a1>'});
 await archived(pg,'answered','raza@dcx.example',['raza@dcx.example','alex@example.com'],'Testing','Testing','2026-05-03',{imid:'<r2>'});
 await archived(pg,'answer','alex@example.com',['alex@example.com','raza@dcx.example'],'Re: Testing','Received','2026-05-04',{imid:'<a2>',irt:'<r2>'});
 await archived(pg,'forward','raza@dcx.example',['raza@dcx.example','alex@example.com'],'Fwd: Morgan Stanley UPS quote','Private pricing for another client','2026-05-05',{imid:'<r3>'});
 const result=(await pg.query("select crm_email_memory(array['alex@example.com'],'hi',12) r")).rows[0].r;
 assert.deepEqual(ids(result).sort(),['answer','answered','own','reply']);
 assert.equal(result.matching_messages,4);
 const owned=(await pg.query("select source_id from crm_memory_owned_sources('ALEX@example.com') order by 1")).rows.map(r=>r.source_id);
 assert.deepEqual(owned,['answer','answered','own','reply']);
});

test('history follows the person across DCX mailboxes and leaves out the conversation being answered',async t=>{
 const pg=await setup(t);
 const oldBox=await mailbox(pg,'old@outlook.example'),newBox=await mailbox(pg,'new@outlook.example');
 const before=await conversation(pg,oldBox,'quotation',[['incoming','I have a hospital, 2 floors, 10 rooms. Eaton 93PX battery price?','2026-10-03T18:35Z'],['outgoing','Please send the nameplate photo.','2026-10-03T18:38Z']]);
 const current=await conversation(pg,newBox,'hi',[['incoming','hi','2026-10-12T19:03Z'],['outgoing','How can we help?','2026-10-12T19:05Z'],['incoming','where our last conversation end up?','2026-10-12T19:06Z']]);
 const hybrid=(await pg.query("select crm_email_memory_hybrid(array[$1],'where our last conversation end up?',array[1,0]::real[],'new@outlook.example',$2) r",[CUSTOMER,'conv-'+(n-3)])).rows[0].r;
 assert.equal(hybrid.status,'available');
 assert.ok(subjects(hybrid).every(s=>s==='quotation'),'only the earlier conversation is memory');
 assert.equal(hybrid.messages.length,2);
 const brain=(await pg.query('select crm_ai_context_hybrid($1,$2::jsonb) r',[current,'[]'])).rows[0].r;
 assert.deepEqual([...new Set(brain.history.messages.map(m=>m.thread_key))],[before]);
 assert.equal(brain.history.excludes_current_conversation,true);
 const unknownBox=(await pg.query("select crm_email_memory_hybrid(array[$1],'hi',array[1,0]::real[],'not-registered@example.com') r",[CUSTOMER])).rows[0].r;
 assert.equal(unknownBox.status,'available');assert.equal(unknownBox.messages.length,5);
});

test('a vague email still brings back older conversations instead of only the newest chain',async t=>{
 const pg=await setup(t);
 const box=await mailbox(pg,'owner@outlook.example');
 await conversation(pg,box,'Calgary batteries',[['incoming','I need 12 UPS batteries delivered to Calgary.','2026-09-01T10:00Z'],['outgoing','Which UPS model are they for?','2026-09-01T11:00Z']]);
 const busy=[];for(let i=0;i<8;i++)busy.push(['incoming','ok '+i,`2026-10-10T10:0${i}Z`]);
 await conversation(pg,box,'chatty',busy);
 const result=(await pg.query("select crm_email_memory(array[$1],'any update?',12) r",[CUSTOMER])).rows[0].r;
 assert.ok(subjects(result).includes('Calgary batteries'));
 assert.equal(subjects(result).filter(s=>s==='chatty').length,2,'one long chain is capped');
 const topical=(await pg.query("select crm_email_memory(array[$1],'battery price for calgary',1) r",[CUSTOMER])).rows[0].r;
 assert.equal(topical.messages[0].subject,'Calgary batteries','any matching word ranks the older request first');
});
