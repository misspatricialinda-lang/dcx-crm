import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { memoryAddresses, retrieveEmailMemory } from '../server/email-memory.js';

test('identity uses the latest inbound address, excludes drafts and other participants', async () => {
  const mail = address => ({ from: { emailAddress: { address } } });
  const messages = [mail('old@example.com'), mail('DES@example.com'), mail('owner@example.com'), { ...mail('wrong@example.com'), isDraft: true }];
  assert.deepEqual(memoryAddresses(messages, 'owner@example.com'), ['des@example.com']);
  const result = await retrieveEmailMemory({ rpc: async () => ({ error: { code: 'PGRST202' } }) }, messages, 'owner@example.com');
  assert.equal(result.status, 'not_configured');
});

test('SQL memory retrieves relevant older exchanges, isolates addresses and keeps attachment links', async t => {
  const pg = new PGlite(); t.after(() => pg.close());
  await pg.exec('create role anon; create role authenticated; create role service_role;');
  for (const migration of ['202609160001_customer_crm.sql', '202609230001_manageable_workspace.sql', '202609230002_email_tracking.sql', '202610040001_email_memory.sql']) {
    await pg.exec(await readFile(new URL('../supabase/migrations/' + migration, import.meta.url), 'utf8'));
  }
  for (const [key, sender, body, date] of [
    ['old-des', 'des@example.com', 'Battery replacement requested', '2026-03-01'],
    ['other-des', 'someoneelse@example.com', 'Battery replacement requested by Des', '2026-03-01'],
    ['recent-des', 'des@example.com', 'Hello again', '2026-10-01'],
  ]) {
    await pg.query(`insert into crm_email_archive(source_key,archive_id,source_id,folder,thread_key,sender_email,participant_emails,body_text,sent_at,attachments)
      values($1,'backup',$1,'Inbox',$1,$2,array[$2],$3,$4,'[{"name":"quote.pdf","storage_path":null}]')`, [key, sender, body, date]);
  }
  await pg.exec(`update crm_email_archive set internet_message_id='<original@example.com>' where source_key='old-des';
    insert into crm_email_archive(source_key,archive_id,source_id,folder,thread_key,sender_email,participant_emails,body_text,sent_at,internet_message_id)
    select 'old-des-copy',archive_id,'copy','Archive',thread_key,sender_email,participant_emails,body_text,sent_at,internet_message_id
    from crm_email_archive where source_key='old-des'`);
  const { rows } = await pg.query("select crm_email_memory(array['DES@example.com'],'battery',12) result");
  const result = rows[0].result;
  assert.equal(result.matching_messages, 2);
  assert.equal(result.messages[0].id, 'old-des');
  assert.ok(!result.messages.some(m => m.id === 'other-des'));
  assert.equal(result.messages[0].attachments[0].name, 'quote.pdf');
  assert.equal(result.messages[0].attachments[0].storage_path, null);
  assert.equal((await pg.query("select crm_email_memory(array['des@example.com'],'battery',1) result")).rows[0].result.messages.length, 1);
  await pg.exec('set role authenticated');
  await assert.rejects(() => pg.query("select crm_email_memory(array['des@example.com'],'',12)"), /permission denied/);
});
