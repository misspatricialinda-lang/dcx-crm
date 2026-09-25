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
