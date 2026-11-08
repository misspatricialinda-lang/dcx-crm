import test from 'node:test'; import assert from 'node:assert/strict'; import { PGlite } from '@electric-sql/pglite'; import { readFile, readdir } from 'node:fs/promises';
import { trackingDb } from './helpers/tracking-db.mjs'; import { supplierLinks, supplierQuotesRequest, supplierThread } from '../server/supplier-quotes-api.js';

async function database() {
  const pg = new PGlite(); await pg.exec('create role anon;create role authenticated;create role service_role;');
  for (const f of (await readdir('supabase/migrations')).filter(f => f.endsWith('.sql') && !f.includes('knowledge_foundation') && f < '202610050001').sort()) await pg.exec(await readFile('supabase/migrations/' + f, 'utf8'));
  for (const f of ['202610060001_email_classifications', '202610060005_ai_email_classification', '202610060008_preserve_known_lead_relationship', '202610070002_email_signature', '202611020001_supplier_quotes', '202611020002_no_ai_drafts_for_suppliers']) await pg.exec(await readFile(`supabase/migrations/${f}.sql`, 'utf8'));
  return pg;
}
async function mailbox(pg) {
  const box = (await pg.query("insert into email_mailboxes(provider,address) values('microsoft','owner@outlook.com') returning id")).rows[0].id;
  let n = 0;
  const thread = async (key = 'conv-' + (++n)) => (await pg.query("insert into email_threads(mailbox_id,provider_thread_key,subject) values($1,$2,'Batteries') returning id", [box, key])).rows[0].id;
  const mail = async (th, { direction = 'incoming', sender, to = ['owner@outlook.com'], subject, body = '', internetId = null }) => (await pg.query(
    "insert into email_messages(thread_id,mailbox_id,provider_key,provider_ref,internet_message_id,direction,sender,to_addresses,subject,body_text,occurred_at) values($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,now()) returning id",
    [th, box, 'm' + (++n), internetId, direction, sender, JSON.stringify(to), subject, body])).rows[0].id;
  return { thread, mail };
}
const recipients = async pg => (await pg.query('select * from supplier_rfq_recipients order by supplier_name')).rows;

test('supplier replies link to the right request only from the exact supplier, by reference or conversation', async t => {
  const pg = await database(); t.after(() => pg.close());
  const { thread, mail } = await mailbox(pg);
  const customerThread = await thread();
  const rfq = (await pg.query(`select crm_create_supplier_rfq($1) r`, [{ thread_id: customerThread, customer_label: 'Acme', title: '4 batteries', recipients: [
    { supplier_name: 'Atlas', supplier_email: 'Atlas@Supplier.example', subject: 'Price request [{REF}]', body: 'Ref {REF}' },
    { supplier_name: 'Birch', supplier_email: 'birch@supplier.example', subject: 'Price request [{REF}]', body: 'Ref {REF}' }] }])).rows[0].r;
  assert.equal(rfq.number, 1001);
  let [atlas, birch] = await recipients(pg);
  assert.equal(atlas.subject, 'Price request [DCX-RFQ-1001]'); assert.equal(atlas.supplier_email, 'atlas@supplier.example'); assert.equal(birch.body, 'Ref DCX-RFQ-1001');
  await pg.query("update supplier_rfq_recipients set status='sent',sent_at=now(),provider_conversation_id='conv-birch' where true");

  // Our own sent copy, synced from Sent Items, links Atlas's conversation.
  const atlasThread = await thread('conv-atlas');
  await mail(atlasThread, { direction: 'outgoing', sender: 'owner@outlook.com', to: ['atlas@supplier.example'], subject: atlas.subject });
  assert.equal((await recipients(pg))[0].supplier_thread_id, atlasThread);

  // Someone else quoting the reference is ignored.
  await mail(atlasThread, { sender: 'intruder@else.example', subject: 'RE: ' + atlas.subject, body: '$1' });
  assert.equal((await recipients(pg))[0].status, 'sent');

  // Atlas replies in the same conversation without the reference in the subject.
  const reply = await mail(atlasThread, { sender: 'atlas@supplier.example', subject: 'Your request', body: 'CAD 48.50 each' });
  [atlas, birch] = await recipients(pg);
  assert.equal(atlas.status, 'replied'); assert.equal(atlas.reply_message_id, reply); assert.ok(atlas.replied_at);
  assert.equal(birch.status, 'sent');
  assert.match((await pg.query('select next_action from email_threads where id=$1', [customerThread])).rows[0].next_action, /Atlas replied to supplier request DCX-RFQ-1001/);

  // Birch replies from a new conversation but quotes the reference.
  await mail(await thread(), { sender: 'birch@supplier.example', subject: 'RE: Price request [DCX-RFQ-1001]', body: 'USD 40' });
  assert.equal((await recipients(pg))[1].status, 'replied');
  // A reference to a different request does not match Atlas's request.
  await mail(await thread(), { sender: 'atlas@supplier.example', subject: 'RE: [DCX-RFQ-9999]', body: 'other' });
  assert.equal((await recipients(pg))[0].reply_message_id, reply);
});

test('ask suppliers: AI drafts per supplier, owner edits, each email sent once, reply read for price', async t => {
  const pg = await database(); t.after(() => pg.close());
  const db = trackingDb(pg); const { thread, mail } = await mailbox(pg);
  for (const [name, email, contact] of [['Atlas Power (demo)', 'atlas@supplier.example', 'Sam Lee'], ['Birch Batteries (demo)', 'birch@supplier.example', ''], ['Cedar UPS (demo)', 'cedar@supplier.example', '']])
    await pg.query("insert into crm_customers(name,email,contact,relationship_type) values($1,$2,$3,'supplier')", [name, email, contact]);
  await pg.query("insert into crm_customers(name,email,relationship_type) values('Not a supplier','buyer@customer.example','customer')");
  const customerThread = await thread();
  await mail(customerThread, { sender: 'buyer@customer.example', subject: 'Battery quote', internetId: '<abc@customer>', body: 'Hi, can you quote 4 x 12V 9Ah batteries for our APC SRT3000? Thanks, Jane at Acme Hospital' });

  const ai = [];
  const transport = async (_url, init) => {
    const request = JSON.parse(init.body); ai.push(request);
    const result = request.text.format.name === 'supplier_request'
      ? { title: '4 × 12V 9Ah UPS batteries', body: 'Could you send your best price for:\n- 4 × 12V 9Ah sealed lead-acid batteries (for APC SRT3000)\n\nPlease include unit price in CAD, availability, lead time, shipping to Toronto and validity.' }
      : { price: 'CAD 48.50 each', lead_time: 'In stock, 2 days', notes: 'Shipping CAD 25, valid 30 days' };
    return new Response(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: JSON.stringify(result) }] }] }), { status: 200 });
  };
  const sent = []; let n = 0; const drafts = new Map();
  const graph = async (path, { method = 'GET', body } = {}) => {
    if (method === 'POST' && path === '/messages') { const id = 'msg-' + (++n); drafts.set(id, body); return { id, conversationId: 'conv-out-' + n }; }
    const id = decodeURIComponent(path.split('/')[2]?.split('?')[0] || '');
    if (method === 'POST' && path.endsWith('/send')) { if (drafts.get(id).toRecipients[0].emailAddress.address.startsWith('cedar')) throw new Error('timeout'); sent.push(drafts.get(id)); return null; }
    if (method === 'GET' && path.includes('uniqueBody')) {
      const stored = (await pg.query('select sender,body_text from email_messages where provider_ref=$1', [id])).rows[0];
      return { uniqueBody: { content: stored.sender.startsWith('atlas') ? 'Hi, CAD 48.50 each, in stock.\n\nOn Mon, DCX wrote:\n> old' : stored.body_text } };
    }
    if (method === 'GET') return { id, isDraft: true, conversationId: 'conv-out-' + id.split('-')[1], toRecipients: drafts.get(id).toRecipients, ccRecipients: [], bccRecipients: [] };
    return null;
  };
  const call = (input, method = 'POST') => supplierQuotesRequest({ db, env: { OPENAI_API_KEY: 'test' }, session: { email: 'owner@dcx.example' }, method, url: new URL('http://x/?action=rfq-list'), input, transport, connect: async () => ({ graph }) });

  let list = (await call(undefined, 'GET')).body;
  assert.deepEqual(list.suppliers.map(s => s.name), ['Atlas Power (demo)', 'Birch Batteries (demo)', 'Cedar UPS (demo)']);
  const created = await call({ action: 'rfq-create', internet_message_id: '<abc@customer>', request: '', supplier_ids: list.suppliers.map(s => s.id) });
  assert.equal(created.status, 200);
  assert.match(ai[0].input[0].content[0].text, /12V 9Ah/);
  let rows = await recipients(pg);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].subject, 'Price request: 4 × 12V 9Ah UPS batteries [DCX-RFQ-1001]');
  assert.match(rows[0].body, /^Hi Sam,\n\nCould you send/); assert.match(rows[1].body, /^Hi,\n/);
  assert.match(rows[0].body, /Ref: DCX-RFQ-1001\n\nThank you,$/);
  // The request prompt follows Raza's style and does not ask for a currency, lead time or validity checklist.
  assert.match(ai[0].instructions, /Do NOT ask about currency/);
  for (const row of rows) assert.doesNotMatch(row.body + row.subject, /Acme|Jane|buyer@customer/);
  const rfq = (await pg.query('select * from supplier_rfqs')).rows[0];
  assert.equal(rfq.thread_id, customerThread); assert.equal(rfq.customer_label, 'buyer@customer.example'); assert.equal(rfq.status, 'draft');

  // Owner edits Atlas's email, drops Birch, then sends.
  assert.equal((await call({ action: 'rfq-save', id: rows[0].id, subject: rows[0].subject, body: rows[0].body.replace('Could you', 'Could you please') })).status, 200);
  assert.equal((await call({ action: 'rfq-remove', id: rows[1].id })).status, 200);
  const result = (await call({ action: 'rfq-send', rfq_id: rfq.id })).body;
  assert.deepEqual(result.results.map(r => [r.supplier, r.outcome]), [['Atlas Power (demo)', 'sent'], ['Cedar UPS (demo)', 'uncertain']]);
  assert.equal(sent.length, 1); assert.match(sent[0].body.content, /Could you please/); assert.equal(sent[0].toRecipients.length, 1);
  rows = await recipients(pg);
  assert.equal(rows[0].status, 'sent'); assert.equal(rows[0].provider_conversation_id, 'conv-out-1'); assert.ok(rows[0].sent_at);
  assert.equal(rows[1].status, 'uncertain'); assert.match(rows[1].error, /Check Sent Items/);
  assert.equal((await pg.query('select status from supplier_rfqs')).rows[0].status, 'open');
  assert.equal((await call({ action: 'rfq-send', rfq_id: rfq.id })).status, 409, 'nothing is sent twice');
  assert.equal((await call({ action: 'rfq-save', id: rows[0].id, subject: 'x', body: 'y' })).status, 409, 'sent emails cannot be edited');

  // Atlas answers in the conversation we started; the AI reads the new part for price and lead time.
  await mail(await thread('conv-out-1'), { sender: 'atlas@supplier.example', subject: 'RE: Price request', body: 'see below' });
  rows = await recipients(pg); assert.equal(rows[0].status, 'replied'); assert.equal(rows[0].reply_read_at, null);
  assert.equal((await call({ action: 'rfq-nudge', id: rows[0].id, body: 'Reminder' })).status, 409, 'no reminders after a reply');
  const read = (await call({ action: 'rfq-read-reply', id: rows[0].id })).body;
  assert.equal(read.price, 'CAD 48.50 each'); assert.equal(read.reply_text, 'Hi, CAD 48.50 each, in stock.');
  assert.equal(ai.at(-1).input[0].content[0].text, 'Hi, CAD 48.50 each, in stock.');
  assert.equal((await call({ action: 'rfq-correct', id: rows[0].id, price: 'CAD 47 each', lead_time: '2 days', notes: '' })).status, 200);

  list = (await call(undefined, 'GET')).body;
  const shown = list.rfqs[0];
  assert.equal(shown.reference, 'DCX-RFQ-1001');
  assert.deepEqual(shown.recipients.map(r => [r.supplier_name, r.status, r.price]), [['Atlas Power (demo)', 'replied', 'CAD 47 each'], ['Cedar UPS (demo)', 'uncertain', '']]);
});

test('reminders go once per click to suppliers who have not answered', async t => {
  const pg = await database(); t.after(() => pg.close());
  const db = trackingDb(pg);
  await pg.query(`select crm_create_supplier_rfq($1)`, [{ title: 'Batteries', recipients: [{ supplier_name: 'Atlas', supplier_email: 'atlas@supplier.example', subject: 'Price request [{REF}]', body: 'Hi' }] }]);
  const row = (await recipients(pg))[0];
  await pg.query("update supplier_rfq_recipients set status='sent',sent_at=now()");
  const sent = [];
  const graph = async (path, { method = 'GET', body } = {}) => method === 'POST' && path === '/messages' ? (sent.push(body), { id: 'r1', conversationId: 'c' }) : method === 'GET' ? { id: 'r1', isDraft: true, toRecipients: sent.at(-1).toRecipients, ccRecipients: [], bccRecipients: [] } : null;
  const call = input => supplierQuotesRequest({ db, env: {}, session: { email: 'owner' }, method: 'POST', url: new URL('http://x/'), input, connect: async () => ({ graph }) });
  assert.equal((await call({ action: 'rfq-nudge', id: row.id, body: 'Just following up.' })).status, 200);
  assert.equal(sent[0].subject, 'RE: Price request [DCX-RFQ-1001]');
  const after = (await recipients(pg))[0];
  assert.equal(after.nudge_count, 1); assert.ok(after.last_nudged_at); assert.equal(after.status, 'sent');
  assert.equal((await call({ action: 'rfq-create', supplier_ids: [], request: 'x' })).status, 400);
});

test('no AI drafts on supplier conversations, by supplier type or request thread; manual drafts still allowed', async t => {
  const pg = await database(); t.after(() => pg.close());
  const { thread, mail } = await mailbox(pg);
  await pg.query("insert into crm_customers(name,email,relationship_type) values('Atlas (demo)','atlas@supplier.example','supplier'),('Acme','buyer@customer.example','customer')");
  const aiDraft = (th, msg, body = 'AI reply') => pg.query("insert into email_drafts(thread_id,reply_to_message_id,current_body,original_ai_body,to_addresses,subject,source_message_version) values($1,$2,$3,$3,'[]','RE',1) returning id", [th, msg, body]);
  const count = async th => Number((await pg.query('select count(*) n from email_drafts where thread_id=$1 and deleted_at is null', [th])).rows[0].n);

  const customer = await thread(); const fromCustomer = await mail(customer, { sender: 'buyer@customer.example', subject: 'Quote', body: 'Price please' });
  await aiDraft(customer, fromCustomer); assert.equal(await count(customer), 1, 'customers still get AI drafts');

  const supplier = await thread(); const fromSupplier = await mail(supplier, { sender: 'Atlas@Supplier.example', subject: 'Hello', body: 'New price list' });
  await aiDraft(supplier, fromSupplier); assert.equal(await count(supplier), 0, 'a saved supplier never gets an AI draft');
  await pg.query("insert into email_drafts(thread_id,reply_to_message_id,current_body,to_addresses,subject,source_message_version) values($1,$2,'My own reply','[]','RE',1)", [supplier, fromSupplier]);
  assert.equal(await count(supplier), 1, 'the owner can still write their own reply');

  // A request thread is a supplier conversation even when the address is no longer saved as a supplier.
  await pg.query(`select crm_create_supplier_rfq($1)`, [{ title: 'Batteries', recipients: [{ supplier_name: 'Old', supplier_email: 'old@supplier.example', subject: 'Price request [{REF}]', body: 'Hi' }] }]);
  await pg.query("update supplier_rfq_recipients set status='sent',sent_at=now()");
  const rfqThread = await thread('conv-rfq'); const answer = await mail(rfqThread, { sender: 'old@supplier.example', subject: 'RE: Price request [DCX-RFQ-1001]', body: 'CAD 10' });
  await aiDraft(rfqThread, answer); assert.equal(await count(rfqThread), 0);

  // Inbox links: suppliers by address, and the request behind a conversation.
  const links = await supplierLinks(trackingDb(pg));
  assert.deepEqual(links.suppliers, [{ name: 'Atlas (demo)', email: 'atlas@supplier.example' }]);
  assert.equal(links.conversations['conv-rfq'].reference, 'DCX-RFQ-1001');

  // The chain shows our request (before Sent Items syncs) and then the reply.
  const row = (await recipients(pg))[0];
  const chain = await supplierThread(trackingDb(pg), row.id);
  assert.deepEqual(chain.messages.map(m => [m.direction, m.text]), [['outgoing', 'Hi'], ['incoming', 'CAD 10']]);
  // A synced sent copy holding only the 255-character preview shows the full request text instead.
  await mail(rfqThread, { direction: 'outgoing', sender: 'owner@outlook.com', to: ['old@supplier.example'], subject: row.subject, body: 'H' });
  const synced = await supplierThread(trackingDb(pg), row.id);
  assert.deepEqual(synced.messages.map(m => m.text), ['CAD 10', 'Hi']);
  assert.equal(chain.can_reply, true);
});

test('replying to a supplier from Supplier quotes stays in their conversation and goes only to them', async t => {
  const pg = await database(); t.after(() => pg.close());
  const db = trackingDb(pg); const { thread, mail } = await mailbox(pg);
  await pg.query(`select crm_create_supplier_rfq($1)`, [{ title: 'Batteries', recipients: [{ supplier_name: 'Atlas', supplier_email: 'atlas@supplier.example', subject: 'Price request [{REF}]', body: 'Hi' }] }]);
  await pg.query("update supplier_rfq_recipients set status='sent',sent_at=now()");
  const th = await thread(); await mail(th, { sender: 'atlas@supplier.example', subject: 'RE: Price request [DCX-RFQ-1001]', body: 'About 100 dollars' });
  const row = (await recipients(pg))[0];
  const ref = (await pg.query('select provider_ref from email_messages where id=$1', [row.reply_message_id])).rows[0].provider_ref;
  const calls = [];
  const graph = async (path, { method = 'GET', body } = {}) => {
    calls.push([method, path, body]);
    if (path.endsWith('/createReply')) return { id: 'reply-1', body: { content: '<p>quoted</p>' } };
    if (method === 'GET') return { id: 'reply-1', isDraft: true, subject: 'RE: Price request [DCX-RFQ-1001]', toRecipients: [{ emailAddress: { address: 'atlas@supplier.example' } }], ccRecipients: [], bccRecipients: [] };
    return null;
  };
  const result = await supplierQuotesRequest({ db, env: {}, session: { email: 'owner' }, method: 'POST', url: new URL('http://x/'), input: { action: 'rfq-reply', id: row.id, body: 'Please confirm in CAD.' }, connect: async () => ({ graph, connection: { email_address: 'owner@outlook.com' } }) });
  assert.equal(result.status, 200);
  assert.equal(calls[0][1], `/messages/${ref}/createReply`);
  assert.match(calls[1][2].body.content, /Please confirm in CAD\.[\s\S]*quoted/);
  assert.deepEqual(calls[1][2].toRecipients, [{ emailAddress: { address: 'atlas@supplier.example' } }]);
  assert.ok(calls.some(([method, path]) => method === 'POST' && path === '/messages/reply-1/send'));
  const chain = await supplierThread(db, row.id);
  assert.equal(chain.messages.at(-1).direction, 'outgoing'); assert.equal(chain.messages.at(-1).text, 'Please confirm in CAD.');
});

test('suppliers can be added and removed from Supplier quotes, saved as Customers of type Supplier', async t => {
  const pg = await database(); t.after(() => pg.close());
  const db = trackingDb(pg);
  const call = input => supplierQuotesRequest({ db, env: {}, session: { email: 'owner@dcx.example' }, method: 'POST', url: new URL('http://x/'), input });
  let result = await call({ action: 'rfq-supplier-add', name: 'Atlas Batteries', contact: 'Sam', email: ' Sales_Team@Atlas.example ' });
  assert.equal(result.status, 200);
  const id = result.body.supplier.id;
  assert.deepEqual((await pg.query('select name,contact,email,relationship_type from crm_customers where id=$1', [id])).rows[0], { name: 'Atlas Batteries', contact: 'Sam', email: 'sales_team@atlas.example', relationship_type: 'supplier' });
  // "_" is a literal character, not a wildcard, when checking for duplicates.
  assert.equal((await call({ action: 'rfq-supplier-add', email: 'salesXteam@atlas.example' })).status, 200);
  assert.equal((await call({ action: 'rfq-supplier-add', email: 'SALES_TEAM@atlas.example' })).status, 409);
  await pg.query("insert into crm_customers(name,email,relationship_type) values('Acme Hospital','buyer@acme.example','customer')");
  result = await call({ action: 'rfq-supplier-add', email: 'buyer@acme.example' });
  assert.equal(result.status, 409); assert.match(result.body.error, /Acme Hospital/);
  assert.equal((await call({ action: 'rfq-supplier-add', email: 'not-an-email' })).status, 400);

  assert.equal((await call({ action: 'rfq-supplier-remove', id })).status, 200);
  assert.ok((await pg.query('select deleted_at from crm_customers where id=$1', [id])).rows[0].deleted_at);
  // Adding the address again restores the same record instead of creating a duplicate.
  result = await call({ action: 'rfq-supplier-add', email: 'sales_team@atlas.example' });
  assert.equal(result.body.supplier.id, id);
  assert.equal((await pg.query("select count(*)::int n from crm_customers where email='sales_team@atlas.example'")).rows[0].n, 1);
  // Customers are never removed through Supplier quotes.
  const customer = (await pg.query("select id from crm_customers where email='buyer@acme.example'")).rows[0].id;
  assert.equal((await call({ action: 'rfq-supplier-remove', id: customer })).status, 404);
});

test('Tell AI what to change rewrites every unsent email in the request; only an explicit learn request saves a rule', async t => {
  const pg = await database(); t.after(() => pg.close());
  await pg.exec("create table ai_owner_rules(id uuid primary key default gen_random_uuid(), rule text not null, active boolean not null default true, created_by text not null, source text not null default 'learn', scope text not null default 'customer', created_at timestamptz not null default now())");
  await pg.query("insert into ai_owner_rules(rule,created_by,scope) values('Keep emails short.','owner@dcx.example','supplier'),('Ask customers for their city.','owner@dcx.example','customer')");
  const db = trackingDb(pg);
  const rfq = (await pg.query(`select crm_create_supplier_rfq($1) r`, [{ title: 'Eaton 93PX batteries', recipients: [
    { supplier_name: 'Atlas', supplier_email: 'atlas@supplier.example', subject: 'Price request [{REF}]', body: 'Hi Sam,\n\nPlease quote Eaton 93PX batteries.\nUnit price in CAD, lead time and validity please.\n\nRef: {REF}\n\nThank you,' },
    { supplier_name: 'Birch', supplier_email: 'birch@supplier.example', subject: 'Price request [{REF}]', body: 'Hi,\n\nPlease quote Eaton 93PX batteries.\nUnit price in CAD, lead time and validity please.\n\nRef: {REF}\n\nThank you,' }] }])).rows[0].r;
  const ai = [];
  const transport = async (_url, init) => { const request = JSON.parse(init.body); ai.push(request);
    return new Response(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({ body: 'Can you please quote me batteries for an Eaton 93PX UPS?', rule: "In price requests to suppliers, don't ask for currency, lead time or how long the price is valid." }) }] }] }), { status: 200 }); };
  const call = input => supplierQuotesRequest({ db, env: { OPENAI_API_KEY: 'test' }, session: { email: 'owner@dcx.example' }, method: 'POST', url: new URL('http://x/'), input, transport });
  const [atlas] = await recipients(pg);
  const result = await call({ action: 'rfq-rewrite', id: atlas.id, instruction: 'why ask CAD and lead time and validity, dont' });
  assert.equal(result.status, 200); assert.equal(result.body.changed, 2);
  assert.match(ai[0].instructions, /^OWNER RULES FOR SUPPLIER EMAILS[\s\S]*1\. Keep emails short\./);
  // Inbox (customer) rules never reach the supplier AI.
  assert.doesNotMatch(ai[0].instructions, /Ask customers for their city/);
  assert.match(ai[0].input[0].content[0].text, /^CURRENT EMAIL\nPlease quote Eaton 93PX batteries\./);
  const [a, b] = await recipients(pg);
  assert.equal(a.body, `Hi Sam,\n\nCan you please quote me batteries for an Eaton 93PX UPS?\n\nRef: DCX-RFQ-${rfq.number}\n\nThank you,`);
  assert.equal(b.body, `Hi,\n\nCan you please quote me batteries for an Eaton 93PX UPS?\n\nRef: DCX-RFQ-${rfq.number}\n\nThank you,`);
  // A plain correction changes this request only; nothing goes into AI memory.
  assert.equal(result.body.rule, '');
  assert.equal((await pg.query('select count(*)::int n from ai_owner_rules')).rows[0].n, 2);
  // Only when the owner asks it to learn is the rule saved, tagged Supplier.
  const learned = await call({ action: 'rfq-rewrite', id: atlas.id, instruction: "don't ask for CAD or lead time, learn this" });
  assert.equal(learned.body.rule, "In price requests to suppliers, don't ask for currency, lead time or how long the price is valid.");
  const saved = (await pg.query("select rule,source,scope from ai_owner_rules order by created_at desc limit 1")).rows[0];
  assert.deepEqual(saved, { rule: "In price requests to suppliers, don't ask for currency, lead time or how long the price is valid.", source: 'chat', scope: 'supplier' });
  // Sent emails are never rewritten.
  await pg.query("update supplier_rfq_recipients set status='sent' where id=$1", [atlas.id]);
  assert.equal((await call({ action: 'rfq-rewrite', id: atlas.id, instruction: 'shorter' })).status, 409);
});
