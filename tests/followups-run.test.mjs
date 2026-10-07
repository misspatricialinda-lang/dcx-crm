import test from 'node:test';
import assert from 'node:assert/strict';
import { runFollowups } from '../server/followups-api.js';

const item = { thread_id: 't1', provider_thread_key: 'conv-1', subject: 'Battery quote', followup_at: '2026-10-08T13:00:00Z', reason: 'quote', stage: 1, notified_at: null, due: true, contact: 'buyer@example.com', last_sent_at: '2026-10-05T16:00:00Z' };
const messages = [
  { id: 'm2', direction: 'outgoing', sender: 'owner@outlook.com', body_text: 'Please find the quotation attached.', occurred_at: '2026-10-05T16:00:00Z' },
  { id: 'm1', direction: 'incoming', sender: 'buyer@example.com', body_text: 'Price for 4 batteries?', occurred_at: '2026-10-05T14:00:00Z' },
];

// A small stand-in for the Supabase client: records every write and answers reads per table.
function fakeDb({ waitingDraft = false, items = [item] } = {}) {
  const writes = [];
  const query = table => {
    const state = { table, op: 'select', payload: null };
    const builder = {
      select() { return builder; }, eq() { return builder; }, is() { return builder; }, neq() { return builder; }, order() { return builder; }, limit() { return builder; },
      insert(payload) { state.op = 'insert'; state.payload = payload; writes.push({ ...state }); return builder; },
      update(payload) { state.op = 'update'; state.payload = payload; writes.push({ ...state }); return builder; },
      maybeSingle() { return builder; }, single() { return builder; },
      then(resolve, reject) {
        const data = state.op === 'select' ? {
          crm_followup_settings: { enabled: true }, email_messages: messages, email_drafts: waitingDraft ? [{ id: 'old' }] : [],
          email_threads: { subject: 'Battery quote', message_version: 4 },
        }[table] : table === 'email_drafts' ? { id: 'd1', revision: 1, to_addresses: ['buyer@example.com'], subject: 'RE: Battery quote' } : null;
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return builder;
  };
  return { writes, from: query, rpc: async (name, args) => { writes.push({ table: name, op: 'rpc', payload: args }); return { data: name === 'crm_followups' ? items : {}, error: null }; } };
}
const ai = body => async (url, options) => {
  ai.calls.push(JSON.parse(options.body));
  return { ok: true, json: async () => ({ output: [{ content: [{ type: 'output_text', text: JSON.stringify(body) }] }] }) };
};
ai.calls = [];
const env = { OPENAI_API_KEY: 'test' };

test('a due follow-up gets an AI draft, a notification and a needs-attention status', async () => {
  const db = fakeDb();
  const summary = await runFollowups(db, env, { transport: ai({ needed: true, reason: 'quote unanswered', body: 'Hi,\n\nDid you have a chance to review the quotation?\n\nThank you,' }) });
  assert.deepEqual({ drafted: summary.drafted, notified: summary.notified, errors: summary.errors }, { drafted: 1, notified: 1, errors: [] });
  const draft = db.writes.find(w => w.table === 'email_drafts' && w.op === 'insert').payload;
  assert.equal(draft.reply_to_message_id, 'm1', 'replies to the customer email so it threads and goes to them');
  assert.deepEqual(draft.to_addresses, ['buyer@example.com']);
  assert.equal(draft.current_body, draft.original_ai_body);
  assert.equal(draft.subject, 'RE: Battery quote');
  const note = db.writes.find(w => w.table === 'crm_notifications').payload;
  assert.equal(note.kind, 'followup'); assert.match(note.subject, /^Follow up: /); assert.match(note.preview, /draft is ready/);
  assert.deepEqual(db.writes.find(w => w.table === 'email_threads' && w.op === 'update').payload.status, 'needs_attention');
});

test('when the AI judges no follow-up is needed it is marked done without a notification', async () => {
  const db = fakeDb();
  const summary = await runFollowups(db, env, { transport: ai({ needed: false, reason: 'Customer said they will reply next month.', body: '' }) });
  assert.equal(summary.skipped, 1);
  assert.ok(db.writes.some(w => w.table === 'crm_set_followup' && w.payload.p_action === 'done'));
  assert.ok(!db.writes.some(w => w.table === 'crm_notifications'));
  assert.ok(!db.writes.some(w => w.table === 'email_drafts' && w.op === 'insert'));
});

test('a conversation that already has a reply waiting is reminded without a second draft', async () => {
  const db = fakeDb({ waitingDraft: true });
  ai.calls.length = 0;
  const summary = await runFollowups(db, env, { transport: ai({ needed: true, reason: '', body: 'x' }) });
  assert.equal(ai.calls.length, 0);
  assert.equal(summary.notified, 1);
  assert.ok(!db.writes.some(w => w.table === 'email_drafts' && w.op === 'insert'));
});

test('already-notified follow-ups are not repeated', async () => {
  const db = fakeDb({ items: [{ ...item, notified_at: '2026-10-08T13:05:00Z' }] });
  assert.equal((await runFollowups(db, env, { transport: ai({ needed: true, reason: '', body: 'x' }) })).due, 0);
});

test('only n8n, with the shared secret, can start the follow-up run', async () => {
  const { followupsHandler } = await import('../server/followups-api.js');
  const env = { N8N_CRM_WEBHOOK_SECRET: 'shared-secret-for-n8n-calls', APP_SESSION_SECRET: 'this-is-a-long-session-secret-for-tests', APP_LOGIN_EMAIL: 'owner@example.com', APP_LOGIN_PASSWORD: 'a-long-local-password' };
  const call = async headers => { const res = { statusCode: 0, setHeader() {}, end(value) { this.body = JSON.parse(value); } }; await followupsHandler({ method: 'POST', url: '/api/followups?action=run', headers: { host: 'crm.example.com', ...headers }, body: {} }, res, env, { db: fakeDb({ items: [] }) }); return res; };
  assert.equal((await call({ 'x-webhook-secret': 'shared-secret-for-n8n-calls' })).statusCode, 200);
  assert.equal((await call({ 'x-webhook-secret': 'wrong-secret-for-n8n-calls!' })).statusCode, 401);
  assert.equal((await call({})).statusCode, 401);
});

test('reminder times are 9:00 AM Toronto whatever the computer timezone is', async () => {
  const { torontoNineAm, businessDaysAhead } = await import('../server/followups-api.js');
  assert.equal(torontoNineAm('2026-10-08').toISOString(), '2026-10-08T13:00:00.000Z', 'summer time (EDT)');
  assert.equal(torontoNineAm('2026-12-01').toISOString(), '2026-12-01T14:00:00.000Z', 'winter time (EST)');
  // Clicked "Tomorrow" at 5:21 PM Pakistan time on Wednesday Oct 7: Thursday 9 AM Toronto, not midnight.
  assert.equal(businessDaysAhead(1, new Date('2026-10-07T12:21:00Z')).toISOString(), '2026-10-08T13:00:00.000Z');
  assert.equal(businessDaysAhead(1, new Date('2026-10-09T15:00:00Z')).toISOString(), '2026-10-12T13:00:00.000Z', 'Friday → Monday');
  assert.equal(businessDaysAhead(1, new Date('2026-10-08T02:00:00Z')).toISOString(), '2026-10-08T13:00:00.000Z', '10 PM Wednesday in Toronto counts from Wednesday');
});
