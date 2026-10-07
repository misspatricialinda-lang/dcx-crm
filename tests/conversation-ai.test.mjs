import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createSession } from '../server/auth-core.js';
import { conversationAiHandler } from '../server/conversation-ai-api.js';

const env = { APP_LOGIN_EMAIL: 'owner@example.com', APP_LOGIN_PASSWORD: 'test-password-long', APP_SESSION_SECRET: 's'.repeat(40), OPENAI_API_KEY: 'test-key' };
const cookie = `dcx_session=${createSession({ email: env.APP_LOGIN_EMAIL, password: env.APP_LOGIN_PASSWORD, secret: env.APP_SESSION_SECRET })}`;
async function fixture(t, injected, config = env) {
  const server = createServer((req, res) => conversationAiHandler(req, res, config, injected));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, post: (body, headers = {}) => fetch(base, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }) };
}
test('conversation AI requires the owner session and server OpenAI key', async t => {
  const f = await fixture(t, {});
  assert.equal((await fetch(f.base, { method: 'POST', headers: { Origin: f.base } })).status, 401);
  assert.equal((await f.post({ conversationId: 'c1' }, { Origin: 'https://evil.example' })).status, 403);
  const noKey = await fixture(t, {}, { ...env, OPENAI_API_KEY: '' });
  assert.equal((await noKey.post({ conversationId: 'c1' })).status, 503);
});
test('conversation AI reads the chain and supported attachments, retrieves knowledge and prepares an unsent draft', async t => {
  const calls = [];
  const graph = async (path, options = {}) => {
    calls.push({ path, options });
    if (path.startsWith('/messages?')) return { value: [
      { id: 'incoming', conversationId: 'c1', subject: 'UPS service', receivedDateTime: '2026-09-29T10:00:00Z', from: { emailAddress: { address: 'customer@example.com' } }, toRecipients: [{ emailAddress: { address: 'owner@example.com' } }], body: { content: 'Please review the attached requirements and quote the work.' }, hasAttachments: true },
      { id: 'outgoing', conversationId: 'c1', subject: 'UPS service', sentDateTime: '2026-09-29T11:00:00Z', from: { emailAddress: { address: 'owner@example.com' } }, body: { content: 'We will review it.' }, hasAttachments: false },
    ] };
    if (path.includes('/attachments?')) return { value: [{ id: 'file1', name: 'scope.pdf', size: 20, isInline: false }, { id: 'file2', name: 'archive.zip', size: 10, isInline: false }] };
    if (path.includes('/$value')) return { arrayBuffer: async () => Buffer.from('%PDF-test') };
    throw new Error(`Unexpected Graph path ${path}`);
  };
  const db = { rpc(name, params) {
    if (name === 'crm_email_memory_hybrid') {
      assert.equal(params.p_mailbox_address, 'owner@example.com');
      assert.equal(params.p_embedding.length,1536);
      assert.deepEqual(params.p_addresses, ['customer@example.com']);
      return Promise.resolve({ data: { matching_messages: 1, messages: [{ source: 'pst', id: 'historical-1', occurred_at: '2026-03-01T10:00:00Z', subject: 'Old request', body_text: 'Six months ago we asked for battery service.' }] }, error: null });
    }
    assert.equal(name, 'match_documents'); assert.equal(params.query_embedding.length, 1536); return Promise.resolve({ data: [{ content: 'DCX provides UPS maintenance.', similarity: .8 }], error: null });
  } };
  const transport = async (url, init) => {
    const request = JSON.parse(init.body);
    if (url.endsWith('/embeddings')) return { ok: true, json: async () => ({ data: [{ embedding: Array(1536).fill(.1) }] }) };
    assert.equal(request.store, false);
    assert.equal(request.model, 'gpt-5.1');
    assert.match(request.instructions, /Supabase knowledge passages/);
    assert.match(request.input[0].content[0].text, /DCX provides UPS maintenance/);
    assert.match(request.input[0].content[0].text, /Please review the attached requirements/);
    assert.match(request.input[0].content[0].text, /Six months ago we asked for battery service/);
    assert.equal(request.input[0].content[1].type, 'input_file');
    return { ok: true, json: async () => ({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({ summary: 'Customer requested a quote.', customer_request: 'Review scope and quote.', next_steps: ['Check scope'], reply_needed: true, draft_reply: 'Thanks, we will review the scope.', uncertainties: ['Pricing needed'] }) }] }] }) };
  };
  const f = await fixture(t, { graph, mailbox: 'owner@example.com', db, fetch: transport });
  const response = await f.post({ conversationId: 'c1' });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.reply_to_message_id, 'incoming');
  assert.equal(result.analysis.draft_reply, 'Thanks, we will review the scope.');
  assert.equal(result.email_memory.matching_messages, 1);
  assert.deepEqual(result.attachments.map(item => item.status), ['read', 'unsupported']);
  assert.ok(calls.every(call => !call.options.method || call.options.method === 'GET'));
});
