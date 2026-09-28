import { createClient } from '@supabase/supabase-js';
import { configuration, getSession } from './auth-core.js';
import { n8nConfig } from './n8n-config.js';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value);
const actionable = draft => draft && !['sent', 'sending', 'submitted', 'uncertain'].includes(draft.status) && !!draft.original_ai_body;
const reply = (res, status, value) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
const checked = async query => { const { data, error } = await query; if (error) throw error; return data; };

async function bodyOf(req) {
  let raw = '';
  if (req.body !== undefined) raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  else for await (const chunk of req) { raw += chunk; if (raw.length > 4200000) throw new Error('Request is too large.'); }
  if (raw.length > 4200000) throw new Error('Request is too large.');
  return JSON.parse(raw || '{}');
}

export async function emailAssistantHandler(req, res, env = process.env, injected = {}) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const session = getSession(req, configuration(env));
  if (!session) return reply(res, 401, { error: 'Sign in to use AI replies.' });
  if (!['GET', 'POST'].includes(req.method)) return reply(res, 405, { error: 'Method not allowed.' });
  const protocol = env.NODE_ENV === 'production' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  if (req.method === 'POST' && (req.headers.origin !== `${protocol}://${req.headers.host}` || req.headers['sec-fetch-site'] === 'cross-site')) return reply(res, 403, { error: 'Request origin is not allowed.' });
  if (!injected.db && (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY)) return reply(res, 503, { error: 'Email database is not configured.' });
  const db = injected.db || createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const url = new URL(req.url || '/', 'http://localhost');
  try {
    if (req.method === 'GET' && url.searchParams.get('action') === 'queue') {
      // The draft is the source of truth; a thread may have a stale status after an AI rewrite.
      const drafts = await checked(db.from('email_drafts').select('id,thread_id,status,original_ai_body,updated_at').not('original_ai_body', 'is', null).order('updated_at', { ascending: false }).limit(500));
      const current = [...new Map(drafts.filter(actionable).map(d => [d.thread_id, d])).values()];
      if (!current.length) return reply(res, 200, { records: [] });
      const threads = await checked(db.from('email_threads').select('id,subject,status,priority,customer_id,last_message_at,mailbox_id').in('id', current.map(d => d.thread_id)));
      const queueMessages = await checked(db.from('email_messages').select('thread_id,direction,sender,body_text,has_attachments,occurred_at').in('thread_id', current.map(d => d.thread_id)).order('occurred_at', { ascending: false }).limit(1000));
      const attached = new Set(queueMessages.filter(m => m.has_attachments).map(m => m.thread_id));
      const latestInbound = new Map();
      for (const message of queueMessages) if (message.direction === 'incoming' && !latestInbound.has(message.thread_id)) latestInbound.set(message.thread_id, message);
      const records = threads.map(t => ({ ...t, has_attachments: attached.has(t.id), sender: latestInbound.get(t.id)?.sender || '', preview: latestInbound.get(t.id)?.body_text?.slice(0, 160) || '', draft: current.find(d => d.thread_id === t.id) })).sort((a, b) => b.last_message_at.localeCompare(a.last_message_at));
      return reply(res, 200, { records });
    }
    if (req.method === 'GET' && url.searchParams.get('action') === 'thread') {
      const id = url.searchParams.get('id');
      if (!uuid(id)) return reply(res, 400, { error: 'Invalid conversation.' });
      const thread = await checked(db.from('email_threads').select('id,subject,status,priority,last_message_at,mailbox_id').eq('id', id).maybeSingle());
      if (!thread) return reply(res, 404, { error: 'Conversation not found.' });
      const draft = await checked(db.from('email_drafts').select('id,thread_id,current_body,original_ai_body,to_addresses,subject,status,updated_at').eq('thread_id', id).neq('status', 'sent').order('updated_at', { ascending: false }).limit(1).maybeSingle());
      if (!actionable(draft)) return reply(res, 404, { error: 'This conversation has no current AI reply draft.' });
      const messages = [];
      for (let from = 0; from < 1000; from += 200) {
        const page = await checked(db.from('email_messages').select('id,thread_id,sender,to_addresses,cc_addresses,subject,body_text,body_html,body_loaded,direction,has_attachments,occurred_at').eq('thread_id', id).order('occurred_at', { ascending: true }).order('id', { ascending: true }).range(from, from + 199));
        messages.push(...page);
        if (page.length < 200) break;
      }
      const attachments = [];
      for (let from = 0; from < messages.length; from += 200) {
        const ids = messages.slice(from, from + 200).map(m => m.id);
        attachments.push(...await checked(db.from('email_attachments').select('id,message_id,name,content_type,size_bytes').in('message_id', ids)));
      }
      return reply(res, 200, { thread, draft, messages, attachments });
    }
    if (req.method !== 'POST') return reply(res, 400, { error: 'Unknown AI reply request.' });
    const input = await bodyOf(req);
    if (!input || typeof input !== 'object' || !['rewrite', 'regenerate', 'save', 'send'].includes(input.action) || !uuid(input.thread_id) || !uuid(input.draft_id)) return reply(res, 400, { error: 'Invalid AI reply request.' });
    const draft = await checked(db.from('email_drafts').select('id,thread_id,status,original_ai_body').eq('id', input.draft_id).eq('thread_id', input.thread_id).maybeSingle());
    if (!actionable(draft)) return reply(res, 409, { error: 'The AI draft is no longer ready for review.' });
    if (input.action === 'rewrite' && (typeof input.instruction !== 'string' || !input.instruction.trim() || input.instruction.length > 4000)) return reply(res, 400, { error: 'Enter an instruction for the AI.' });
    if (input.action === 'save' && (typeof input.body_text !== 'string' || !input.body_text.trim() || input.body_text.length > 50000)) return reply(res, 400, { error: 'Draft body is missing or too long.' });
    if (input.action === 'send') {
      if (!Array.isArray(input.attachments) || input.attachments.length > 5 || input.attachments.some(file => !file || typeof file.name !== 'string' || !file.name.trim() || file.name.length > 200 || typeof file.content_type !== 'string' || typeof file.content_base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.content_base64) || file.content_base64.length > 4 * 1024 * 1024) || input.attachments.reduce((size, file) => size + file.content_base64.length, 0) > 4 * 1024 * 1024) return reply(res, 400, { error: 'Attach up to five files, with a combined size under 3 MB.' });
    }
    const config = n8nConfig(env);
    if (!config.emailAssistantWebhook) return reply(res, 503, { error: 'AI email workflow URL is not configured.' });
    const payload = { action: input.action, thread_id: draft.thread_id, draft_id: draft.id, actor: session.email, request_id: uuid(input.request_id) ? input.request_id : crypto.randomUUID() };
    if (input.action === 'rewrite') payload.instruction = input.instruction.trim();
    if (input.action === 'save') { payload.body_text = input.body_text; payload.body_html = typeof input.body_html === 'string' ? input.body_html.slice(0, 100000) : ''; }
    if (input.action === 'send') payload.attachments = input.attachments;
    const upstream = await (injected.fetch || fetch)(config.emailAssistantWebhook, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(config.crmWebhookSecret ? { [config.crmSecretHeader]: config.crmWebhookSecret } : {}) }, body: JSON.stringify(payload), signal: AbortSignal.timeout(90000) });
    const raw = await upstream.text();
    let result;
    try { result = JSON.parse(raw); } catch { return reply(res, 502, { error: 'AI email workflow returned an invalid response. Your draft is preserved.' }); }
    if (!upstream.ok || !result?.success) return reply(res, 502, { error: String(result?.error || result?.message || 'AI email workflow failed. Your draft is preserved.').slice(0, 500) });
    return reply(res, 200, result);
  } catch (error) {
    return reply(res, 500, { error: error?.message || 'AI email request failed.' });
  }
}
