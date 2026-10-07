import test from 'node:test'; import assert from 'node:assert/strict'; import { PGlite } from '@electric-sql/pglite'; import { readFile, readdir } from 'node:fs/promises';

async function database() {
  const pg = new PGlite(); await pg.exec('create role anon;create role authenticated;create role service_role;');
  for (const f of (await readdir('supabase/migrations')).filter(f => f.endsWith('.sql') && !f.includes('knowledge_foundation') && f < '202610050001').sort()) await pg.exec(await readFile('supabase/migrations/' + f, 'utf8'));
  for (const f of ['202610060001_email_classifications', '202610060005_ai_email_classification', '202610060008_preserve_known_lead_relationship', '202610070004_followups']) await pg.exec(await readFile(`supabase/migrations/${f}.sql`, 'utf8'));
  return pg;
}

test('business days land at 9:00 Toronto and skip weekends', async t => {
  const pg = await database(); t.after(() => pg.close());
  const due = async (from, days) => (await pg.query("select to_char(crm_business_due($1, $2) at time zone 'America/Toronto', 'Dy YYYY-MM-DD HH24:MI') d", [from, days])).rows[0].d;
  assert.equal(await due('2026-10-09T15:00:00-04:00', 3), 'Wed 2026-10-14 09:00'); // Friday + 3 business days
  assert.equal(await due('2026-10-07T23:30:00-04:00', 1), 'Thu 2026-10-08 09:00');
});

test('follow-ups start when DCX replies, stop when the customer answers, and stop after two reminders', async t => {
  const pg = await database(); t.after(() => pg.close());
  const mb = (await pg.query("insert into email_mailboxes(provider,address) values('microsoft','owner@outlook.com') returning id")).rows[0].id;
  const thread = async (key, topic) => (await pg.query('insert into email_threads(mailbox_id,provider_thread_key,subject,topic) values($1,$2,$3,$4) returning id', [mb, key, 'Batteries', topic])).rows[0].id;
  let n = 0;
  const mail = (th, direction, who, at, body = 'Thanks') => pg.query(
    "insert into email_messages(thread_id,mailbox_id,provider_key,provider_ref,direction,sender,to_addresses,subject,body_text,occurred_at) values($1,$2,$3,$3,$4,$5,$6,'Batteries',$7,$8)",
    [th, mb, 'k' + (++n), direction, direction === 'incoming' ? who : 'owner@outlook.com', JSON.stringify([direction === 'incoming' ? 'owner@outlook.com' : who]), body, at]);
  const state = async th => (await pg.query("select followup_reason reason, followup_stage stage, to_char(followup_at at time zone 'America/Toronto','YYYY-MM-DD HH24:MI') due from email_threads where id=$1", [th])).rows[0];

  const quote = await thread('q', 'quotation');
  await mail(quote, 'incoming', 'buyer@example.com', '2026-10-05T14:00:00Z', 'Price for 4 batteries?');
  await pg.query("update email_threads set topic='quotation' where id=$1", [quote]); // the AI classifies the request
  assert.equal((await state(quote)).due, null, 'customer spoke last: nothing to chase');
  await mail(quote, 'outgoing', 'buyer@example.com', '2026-10-05T16:00:00Z', 'Please find the quotation attached.\n\nThank you,');
  await mail(quote, 'outgoing', 'buyer@example.com', '2026-10-05T16:00:01Z', 'Please find the quotation attached.'); // Outlook sync copy of the same send
  assert.deepEqual(await state(quote), { reason: 'quote', stage: 1, due: '2026-10-08 09:00' });
  await mail(quote, 'outgoing', 'buyer@example.com', '2026-10-08T14:00:00Z', 'Just checking in on the quotation.');
  assert.deepEqual(await state(quote), { reason: 'quote', stage: 2, due: '2026-10-14 09:00' }, 'second reminder 7 business days after the quote');
  await mail(quote, 'outgoing', 'buyer@example.com', '2026-10-14T14:00:00Z', 'Following up once more.');
  assert.deepEqual(await state(quote), { reason: 'gone_quiet', stage: 3, due: null });
  await mail(quote, 'incoming', 'buyer@example.com', '2026-10-15T14:00:00Z', 'Sorry for the delay, approved.');
  assert.deepEqual(await state(quote), { reason: null, stage: 0, due: null }, 'a customer reply clears the follow-up');

  const question = await thread('a', 'support');
  await mail(question, 'incoming', 'client@example.com', '2026-10-05T14:00:00Z', 'UPS alarm');
  await mail(question, 'outgoing', 'client@example.com', '2026-10-05T15:00:00Z', 'Which model is it?\n\nOn Mon, Client wrote:\n> is it ok?');
  assert.equal((await state(question)).reason, 'awaiting_answer');
  const statement = await thread('s', 'support');
  await mail(statement, 'incoming', 'client2@example.com', '2026-10-05T14:00:00Z', 'Thanks for fixing it');
  await mail(statement, 'outgoing', 'client2@example.com', '2026-10-05T15:00:00Z', 'Glad it is working.\n\nFrom: Client\nAny questions?');
  assert.equal((await state(statement)).due, null, 'a question only in the quoted history does not count');

  const staff = await thread('e', 'quotation');
  await mail(staff, 'incoming', 'tech@dcx-tech.com', '2026-10-05T14:00:00Z', 'Need the quote');
  await pg.query("update email_threads set topic='quotation' where id=$1", [staff]);
  await mail(staff, 'outgoing', 'tech@dcx-tech.com', '2026-10-05T15:00:00Z', 'Here is the quote?');
  assert.equal((await state(staff)).due, null, 'no reminders for staff');

  const self = await thread('o', 'quotation');
  await mail(self, 'incoming', 'owner@outlook.com', '2026-10-05T14:00:00Z', 'Note to self');
  await mail(self, 'outgoing', 'owner@outlook.com', '2026-10-05T15:00:00Z', 'Any update?');
  assert.equal((await state(self)).due, null, 'no reminders for our own mailbox');

  const set = (th, action, until) => pg.query("select crm_set_followup($1,$2,$3,'owner@example.com') r", [th, action, until]);
  await set(question, 'snooze', '2026-12-01T14:00:00Z');
  assert.equal((await state(question)).reason, 'awaiting_answer', 'snooze keeps the reason');
  await set(question, 'done', null);
  assert.deepEqual(await state(question), { reason: 'done', stage: 1, due: null });
  await set(statement, 'remind', '2026-12-01T14:00:00Z');
  await mail(statement, 'incoming', 'client2@example.com', '2026-10-06T14:00:00Z', 'One more thing');
  assert.equal((await state(statement)).reason, 'manual', 'a personal reminder survives new mail');
  await assert.rejects(set(statement, 'snooze', '2020-01-01T00:00:00Z'), /next year/);
  const list = (await pg.query('select crm_followups(400) x')).rows[0].x;
  assert.deepEqual(list.map(r => r.reason).sort(), ['manual']);
});
