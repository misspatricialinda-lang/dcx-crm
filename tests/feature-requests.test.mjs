import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, configuration } from '../server/auth-core.js';
import { featureRequestsHandler } from '../server/feature-requests-api.js';

const env = {
  APP_LOGIN_EMAIL: 'owner@example.com',
  APP_LOGIN_PASSWORD: 'a-long-local-password',
  APP_SESSION_SECRET: 'this-is-a-long-session-secret-for-tests',
};
const headers = { host: 'localhost:3000', origin: 'http://localhost:3000', cookie: `dcx_session=${createSession(configuration(env))}` };
const response = () => ({ statusCode: 0, body: null, setHeader() {}, end(value) { this.body = JSON.parse(value); } });
function db() {
  let record;
  return { from(table) {
    assert.equal(table, 'crm_feature_requests');
    return {
      select() { return this; }, order() { return this; }, limit: async () => ({ data: record ? [record] : [], error: null }),
      insert(value) { record = { id: '11111111-1111-4111-8111-111111111111', version: 1, status: 'new', owner_notes: '', ...value }; return this; },
      single: async () => ({ data: record, error: null }),
      update(value) { this.changes = value; this.matched = true; return this; },
      eq(key, value) { if (record?.[key] !== value) this.matched = false; return this; },
      maybeSingle: async function () { if (this.matched) record = { ...record, ...this.changes }; return { data: this.matched ? record : null, error: null }; },
    };
  } };
}

test('feature requests require the owner session', async () => {
  const res = response();
  await featureRequestsHandler({ method: 'GET', url: '/', headers: {} }, res, env, db());
  assert.equal(res.statusCode, 401);
});

test('feature requests validate input and use version checks for updates', async () => {
  const store = db();
  const bad = response();
  await featureRequestsHandler({ method: 'POST', url: '/', headers, body: { title: 'Hi', description: 'Short', area: 'general', priority: 'normal' } }, bad, env, store);
  assert.equal(bad.statusCode, 400);
  const added = response();
  await featureRequestsHandler({ method: 'POST', url: '/', headers, body: { title: 'Show overdue quotes', description: 'Show overdue quotations on the dashboard.', area: 'quotations', priority: 'high' } }, added, env, store);
  assert.equal(added.statusCode, 201);
  assert.equal(added.body.record.created_by, env.APP_LOGIN_EMAIL);
  const listed = response();
  await featureRequestsHandler({ method: 'GET', url: '/', headers }, listed, env, store);
  assert.equal(listed.body.records.length, 1);
  const changed = response();
  await featureRequestsHandler({ method: 'PATCH', url: '/', headers, body: { id: added.body.record.id, version: 1, status: 'planned', priority: 'high', owner_notes: 'Review next sprint.' } }, changed, env, store);
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.body.record.version, 2);
  const stale = response();
  await featureRequestsHandler({ method: 'PATCH', url: '/', headers, body: { id: added.body.record.id, version: 1, status: 'completed', priority: 'high', owner_notes: '' } }, stale, env, store);
  assert.equal(stale.statusCode, 409);
});
