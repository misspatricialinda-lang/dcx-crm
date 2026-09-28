import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('quotation numbers, totals, edits, issue lock, and deletion stay consistent in Postgres', async t => {
  const pg = new PGlite(); t.after(() => pg.close());
  await pg.exec('create role anon; create role authenticated; create role service_role;');
  for (const name of ['202609160001_customer_crm.sql','202609230001_manageable_workspace.sql','202609270001_customer_quotations.sql']) {
    await pg.exec(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'));
  }
  const customer = (await pg.query("insert into crm_customers(name,email,billing_address) values('Acme','acme@example.com','123 Main St') returning id")).rows[0];
  const save = (id, version, items, issue = false) => pg.query('select crm_save_quotation($1,$2,$3,$4,$5::jsonb,$6) id', [customer.id,id,version,'123 Main St',JSON.stringify(items),issue]);
  const item = (name, quantity, price) => ({product_service:name,description:'Test item',quantity,unit_price:price});
  const first = (await save(null,null,[item('Battery',4,'365.40'),item('Shipping',1,'600.00')])).rows[0].id;
  const second = (await save(null,null,[item('Labour',1,'100.00')])).rows[0].id;
  let q = (await pg.query('select * from crm_quotations where id=$1',[first])).rows[0];
  assert.equal(Number(q.estimate_number),6538);
  assert.equal(Number((await pg.query('select estimate_number from crm_quotations where id=$1',[second])).rows[0].estimate_number),6539);
  assert.equal(Number(q.subtotal),2061.60); assert.equal(Number(q.tax_total),268.01); assert.equal(Number(q.grand_total),2329.61);
  assert.equal((await pg.query('select count(*)::int count from crm_quotation_items where quotation_id=$1',[first])).rows[0].count,2);
  await save(first,1,[item('Replacement',2,'200.00')],true);
  q = (await pg.query('select * from crm_quotations where id=$1',[first])).rows[0];
  assert.equal(q.status,'issued'); assert.equal(Number(q.grand_total),452);
  await assert.rejects(save(first,2,[item('Changed',1,'1.00')]),/Quotation changed/);
  assert.equal((await pg.query('select crm_delete_quotation($1,$2,$3) deleted',[customer.id,first,2])).rows[0].deleted,true);
  assert.equal((await pg.query('select crm_delete_quotation($1,$2,$3) deleted',[customer.id,first,2])).rows[0].deleted,false);
  assert.equal(Number((await pg.query('select estimate_number from crm_quotations where id=$1',[first])).rows[0].estimate_number),6538);
  const third = (await save(null,null,[item('New',1,'1.00')])).rows[0].id;
  assert.equal(Number((await pg.query('select estimate_number from crm_quotations where id=$1',[third])).rows[0].estimate_number),6540);
});
