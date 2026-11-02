import test from 'node:test'; import assert from 'node:assert/strict'; import { PGlite } from '@electric-sql/pglite'; import { readFile, readdir } from 'node:fs/promises';
import { trackingDb } from './helpers/tracking-db.mjs'; import { emailBrainRequest } from '../server/email-brain-api.js';

// Current production chain, including the employee guard (0003) and the approval rule (0004) that the older workspace test skips.
async function database() {
  const pg = new PGlite(); await pg.exec('create role anon;create role authenticated;create role service_role;');
  for (const f of (await readdir('supabase/migrations')).filter(f => f.endsWith('.sql') && !f.includes('knowledge_foundation') && f < '202610050001').sort()) await pg.exec(await readFile('supabase/migrations/' + f, 'utf8'));
  for (const f of ['202610060001_email_classifications', '202610060003_employee_supplier_guard', '202610060004_supplier_dispatch_approval', '202610060005_ai_email_classification', '202610060008_preserve_known_lead_relationship']) await pg.exec(await readFile(`supabase/migrations/${f}.sql`, 'utf8'));
  return pg;
}

async function mailbox(pg) {
  const box = (await pg.query("insert into email_mailboxes(provider,address) values('microsoft','owner@outlook.com') returning id")).rows[0].id;
  let n = 0;
  const thread = async () => (await pg.query("insert into email_threads(mailbox_id,provider_thread_key,subject) values($1,$2,'Battery pricing') returning id", [box, 't' + (++n)])).rows[0].id;
  const mail = async (th, sender, subject, body) => (await pg.query(
    "insert into email_messages(thread_id,mailbox_id,provider_key,provider_ref,sender,subject,direction,body_text,occurred_at) values($1,$2,$3,$3,$4,$5,'incoming',$6,now()) returning id",
    [th, box, 'm' + (++n), sender, subject, body])).rows[0].id;
  return { thread, mail };
}
const request = async (pg, th) => (await pg.query('select * from supplier_price_requests where thread_id=$1', [th])).rows[0];
const claim = async pg => (await pg.query('select crm_claim_supplier_request() r')).rows[0].r;
const resolve = (pg, id, quantity, approve) => emailBrainRequest(trackingDb(pg), { method: 'POST' }, null, { operation: 'resolve-request', id, quantity, approve });

test('customer pricing email → supplier request → owner approval → workflow 4 send → supplier reply reaches the customer draft', async t => {
  const pg = await database(); t.after(() => pg.close());
  const { thread, mail } = await mailbox(pg);
  await pg.exec("insert into product_supplier_routes(sku,product_name,supplier_email,auto_request) values('BAT-01','12V 9Ah UPS battery','sales@supplier.example',false)");

  // 1. Customer asks for pricing with an explicit SKU and quantity: a request is prepared, nothing is sent yet.
  const th = await thread();
  await mail(th, 'buyer@customer.example', 'Price request', 'Hi, what is your price? SKU: BAT-01 Qty: 4');
  let r = await request(pg, th);
  assert.equal(r.status, 'awaiting_approval');
  assert.equal(Number(r.quantity), 4);
  assert.equal(r.supplier_email, 'sales@supplier.example');
  assert.match(r.request_subject, /^Price request \[DCX-PR-[0-9a-f-]{36}\]$/);
  assert.match(r.request_body, /12V 9Ah UPS battery \(SKU: BAT-01\), quantity 4/);
  assert.doesNotMatch(r.request_body, /buyer@customer\.example|what is your price/, 'customer correspondence is never forwarded to the supplier');
  assert.equal((await claim(pg)).claimed, false, 'unapproved requests are not dispatched');

  // 2. Owner approves: the request is queued.
  r = (await resolve(pg, r.id, 4, true)).request;
  assert.equal(r.status, 'queued'); assert.ok(r.approved_at);

  // 3. Workflow 4 claims it exactly once, then records the draft and the send.
  const claimed = await claim(pg);
  assert.equal(claimed.claimed, true); assert.equal(claimed.id, r.id);
  assert.equal((await claim(pg)).claimed, false, 'a claimed request is never sent twice');
  await pg.query("update supplier_price_requests set provider_draft_id='draft-1' where id=$1 and status='dispatching'", [r.id]);
  await pg.query("update supplier_price_requests set status='sent',error=null where id=$1 and status='dispatching'", [r.id]);
  assert.equal((await request(pg, th)).status, 'sent');

  // 4. A reply quoting the reference from a different sender is ignored.
  await mail(th, 'someone@else.example', 'RE: ' + r.request_subject, 'Unit price $1');
  assert.equal((await request(pg, th)).status, 'sent');

  // 5. The mapped supplier replies with the reference: request answered, customer conversation flagged.
  const replyId = await mail(th, 'Sales@Supplier.example', 'RE: ' + r.request_subject, 'Unit price CAD 48.50, 3 days lead time, valid 30 days.');
  r = await request(pg, th);
  assert.equal(r.status, 'answered'); assert.equal(r.supplier_reply_id, replyId);
  const flagged = (await pg.query('select status,next_action from email_threads where id=$1', [th])).rows[0];
  assert.equal(flagged.status, 'needs_attention');
  assert.match(flagged.next_action, /Supplier pricing received/);

  // 6. The AI drafting context for that conversation carries the supplier's answer as evidence, with the cost-is-not-price rule.
  const context = (await pg.query('select crm_ai_context($1) r', [th])).rows[0].r;
  assert.match(context.supplier_price_requests[0].supplier_reply, /CAD 48\.50/);
  assert.match(context.rules, /Supplier cost is not an approved customer selling price/);
});

test('auto-request routes still need approval since the dispatch-approval migration', async t => {
  const pg = await database(); t.after(() => pg.close());
  const { thread, mail } = await mailbox(pg);
  await pg.exec("insert into product_supplier_routes(sku,product_name,supplier_email,auto_request) values('BAT-02','UPS battery','sales@supplier.example',true)");
  const th = await thread();
  await mail(th, 'buyer@customer.example', 'Pricing', 'Pricing please. SKU: BAT-02 Quantity: 10');
  const r = await request(pg, th);
  assert.equal(r.status, 'queued');
  assert.equal((await claim(pg)).claimed, false, 'queued by an auto route, but not approved');
  await resolve(pg, r.id, 10, true);
  assert.equal((await claim(pg)).claimed, true);
});

test('incomplete or ineligible pricing emails wait for the owner instead of guessing', async t => {
  const pg = await database(); t.after(() => pg.close());
  const { thread, mail } = await mailbox(pg);
  await pg.exec("insert into product_supplier_routes(sku,product_name,supplier_email,auto_request) values('BAT-01','UPS battery','sales@supplier.example',false)");

  const noQty = await thread();
  await mail(noQty, 'buyer@customer.example', 'Pricing', 'What is the price for SKU: BAT-01');
  let r = await request(pg, noQty);
  assert.equal(r.status, 'needs_details');
  r = (await resolve(pg, r.id, 6, false)).request;
  assert.equal(r.status, 'awaiting_approval', 'adding the quantity without approving keeps it waiting');
  assert.match(r.request_body, /quantity 6/);

  const unknown = await thread();
  await mail(unknown, 'buyer@customer.example', 'Pricing', 'Price please. SKU: XYZ-9 Qty: 2');
  assert.equal((await request(pg, unknown)).status, 'needs_supplier');

  const freeform = await thread();
  await mail(freeform, 'buyer@customer.example', 'Pricing', 'How much for four replacement batteries for our APC unit?');
  assert.equal(await request(pg, freeform), undefined, 'no SKU, no supplier request');

  const staff = await thread();
  await mail(staff, 'raza@dcx-tech.com', 'Pricing', 'Price check SKU: BAT-01 Qty: 1');
  assert.equal(await request(pg, staff), undefined, 'staff emails never create supplier requests');

  const supplier = await thread();
  await mail(supplier, 'sales@supplier.example', 'Pricing', 'Our new price list. SKU: BAT-01 Qty: 1');
  assert.equal(await request(pg, supplier), undefined, 'supplier emails never create supplier requests');

  await pg.exec("update supplier_price_requests set status='cancelled'");
  await assert.rejects(resolve(pg, r.id, 6, true), /already dispatched or changed/);
});
