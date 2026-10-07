import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createSession } from '../server/auth-core.js';
import { calendarAgentHandler } from '../server/calendar-agent-api.js';

const config = { APP_LOGIN_EMAIL: 'owner@example.com', APP_LOGIN_PASSWORD: 'long-password-for-test', APP_SESSION_SECRET: '0123456789abcdef0123456789abcdef' };
function request(url, cookie = '') {
  return { method: 'GET', url, headers: { cookie, host: 'localhost:3000' } };
}
function response() {
  return { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(value) { this.body = JSON.parse(value); } };
}

test('Calendar Agent searches the database only for a signed-in user', async () => {
  const calls = [];
  const db = { rpc: async (name, args) => { calls.push([name, args]); return { data: [{ email: 'alex@example.com' }], error: null }; } };
  const denied = response();
  await calendarAgentHandler(request('/?action=emails&q=alex'), denied, config, db);
  assert.equal(denied.statusCode, 401);
  assert.equal(calls.length, 0);

  const allowed = response();
  await calendarAgentHandler(request('/?action=emails&q=alex', `dcx_session=${createSession({ email: config.APP_LOGIN_EMAIL, password: config.APP_LOGIN_PASSWORD, secret: config.APP_SESSION_SECRET })}`), allowed, config, db);
  assert.equal(allowed.statusCode, 200);
  assert.deepEqual(allowed.body, { emails: ['alex@example.com'] });
  assert.deepEqual(calls, [['calendar_email_suggestions', { p_query: 'alex', p_limit: 8 }]]);
});

test('Calendar Agent authenticates the upstream webhook and fails closed without its secret', async () => {
  const cookie = `dcx_session=${createSession({ email: config.APP_LOGIN_EMAIL, password: config.APP_LOGIN_PASSWORD, secret: config.APP_SESSION_SECRET })}`;
  const req = { method: 'POST', headers: { cookie, host: 'localhost:3000', origin: 'http://localhost:3000' }, body: { message: 'Read my calendar', sessionId: 'test-calendar-session' } };
  const env = { ...config, N8N_CALENDAR_WEBHOOK_URL: 'https://example.com/webhook/calendar', N8N_CRM_WEBHOOK_SECRET: 'private-calendar-test-secret' };
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, env.N8N_CALENDAR_WEBHOOK_URL);
    assert.equal(options.headers['x-webhook-secret'], env.N8N_CRM_WEBHOOK_SECRET);
    return new Response(JSON.stringify({ output: 'No events today' }));
  };
  try {
    const allowed = response();
    await calendarAgentHandler(req, allowed, env);
    assert.equal(allowed.statusCode, 200);
    assert.deepEqual(allowed.body, { answer: 'No events today' });
    const blocked = response();
    await calendarAgentHandler(req, blocked, { ...env, N8N_CRM_WEBHOOK_SECRET: '' });
    assert.equal(blocked.statusCode, 503);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
