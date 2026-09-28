import { loadEnv } from 'vite';
import { createClient } from '@supabase/supabase-js';
import { readFile, readdir } from 'node:fs/promises';

// Read-only live verification. Never logs connection keys, addresses or mail bodies.
const env = { ...loadEnv('development', process.cwd(), ''), ...process.env };
if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
  console.error('Missing server SUPABASE_URL or SUPABASE_SECRET_KEY.');
  process.exit(1);
}
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(20000) }) },
});
let failed = false;
const check = (name, error, detail = '') => {
  if (error) failed = true;
  console.log(`${error ? 'FAIL' : 'OK'} ${name}${error ? ` (${error.code || 'request failed'})` : detail ? `: ${detail}` : ''}`);
};
// Derive required tables from the migrations used by the running app.
const migrations = (await readdir('supabase/migrations')).filter(name => name.endsWith('.sql') && !name.includes('knowledge_foundation')).sort();
const tables = new Set();
for (const migration of migrations) {
  const sql = await readFile(`supabase/migrations/${migration}`, 'utf8');
  for (const match of sql.matchAll(/create table(?: if not exists)? public\.(\w+)/gi)) tables.add(match[1]);
}
for (const table of tables) {
  // GET (not HEAD) reliably surfaces missing-table errors and checks access.
  const { error, count } = await db.from(table).select('*', { count: 'exact' }).limit(0);
  check(table, error, `${count ?? 0} rows`);
}
const response = await fetch(`${env.SUPABASE_URL}/rest/v1/`, {
  headers: { apikey: env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}` },
  signal: AbortSignal.timeout(20000),
});
const schema = await response.json();
for (const rpc of ['email_command', 'email_worker', 'email_sync', 'email_report']) {
  check(`RPC ${rpc}`, schema.paths?.[`/rpc/${rpc}`] ? null : { code: 'MISSING_RPC' });
}
const { data: boxes, error } = await db.from('email_mailboxes').select('id,provider,last_synced_at');
check('Mailbox connection', error);
for (const [table, fields] of [
  ['email_messages', 'id,email_threads(id),email_mailboxes(id)'],
  ['email_threads', 'id,crm_customers(id),email_mailboxes(id)'],
  ['email_drafts', 'id,email_threads(id),email_messages(id)'],
  ['email_attachments', 'id,email_messages(id)'],
]) {
  const { error } = await db.from(table).select(fields).limit(1);
  check(`${table} relationships`, error);
}
for (const box of boxes || []) {
  const { data, error } = await db.rpc('email_report', { p_mailbox: box.id, p_days: 7, p_timezone: 'UTC' });
  check(`${box.provider} reporting`, error, `${data?.received ?? 0} received / ${data?.sent ?? 0} sent in 7 days`);
  console.log(`  Last sync: ${box.last_synced_at || 'never'}; folder checkpoints: ${data?.folders?.length || 0}`);
}
console.log(`Scheduled draft worker: ${(env.EMAIL_TRACKING_TOKEN || '').length >= 32 ? 'token configured (n8n execution not verified)' : 'not configured'}`);
process.exitCode = failed ? 1 : 0;
