import { createClient } from '@supabase/supabase-js';
import { configuration, getSession } from './auth-core.js';
import { n8nConfig } from './n8n-config.js';
import { cleanSignatureFields, signatureHtml } from './email-signature.js';
import { sendAiDraft } from './draft-send.js';
import { delegatedGraphClient } from './microsoft-oauth.js';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value);
const actionable = draft => draft && !draft.deleted_at && !['sent', 'sending', 'submitted', 'uncertain'].includes(draft.status) && !!draft.original_ai_body;
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
    if(req.method==='GET' && url.searchParams.get('action')==='signature') {
      const row=await checked(db.from('crm_email_signature').select('fields,enabled,banner_base64,banner_content_type,updated_at,updated_by').eq('id',1).maybeSingle());
      if(!row)return reply(res,200,{signature:null});
      const banner=row.banner_base64?`data:${row.banner_content_type};base64,${row.banner_base64}`:'';
      return reply(res,200,{signature:{fields:row.fields,enabled:row.enabled,has_banner:!!banner,preview_html:signatureHtml(row.fields,{banner:!!banner,bannerSrc:banner}),updated_at:row.updated_at,updated_by:row.updated_by}});
    }
    if(req.method==='GET' && url.searchParams.get('action')==='location') {
      const id=url.searchParams.get('id');if(!uuid(id))return reply(res,400,{error:'Invalid conversation.'});
      const thread=await checked(db.from('email_threads').select('id,provider_thread_key').eq('id',id).maybeSingle());
      if(!thread)return reply(res,404,{error:'Conversation not found.'});
      const drafts=await checked(db.from('email_drafts').select('id,status,original_ai_body,deleted_at').eq('thread_id',id).is('deleted_at',null).limit(10));
      return reply(res,200,{conversation:thread.provider_thread_key,ai_draft:!!drafts.find(actionable)});
    }
    if(req.method==='GET' && url.searchParams.get('action')==='for-message') {
      const internetId=url.searchParams.get('internet_message_id');
      if(!internetId || internetId.length>1000)return reply(res,400,{error:'Message identity is required.'});
      const messages=await checked(db.from('email_messages').select('thread_id').eq('internet_message_id',internetId).limit(10));
      const ids=[...new Set(messages.map(m=>m.thread_id))];
      if(!ids.length)return reply(res,200,{draft:null});
      const drafts=await checked(db.from('email_drafts').select('id,thread_id,current_body,to_addresses,status,original_ai_body,updated_at,deleted_at').in('thread_id',ids).is('deleted_at',null).order('updated_at',{ascending:false}).limit(10));
      return reply(res,200,{draft:drafts.find(actionable)||null});
    }
    if (req.method === 'GET' && url.searchParams.get('action') === 'queue') {
      // The draft is the source of truth; a thread may have a stale status after an AI rewrite.
      const trash = url.searchParams.get('trash') === 'true';
      let draftQuery=db.from('email_drafts').select('id,thread_id,status,original_ai_body,updated_at,deleted_at').not('original_ai_body', 'is', null);
      draftQuery=trash?draftQuery.not('deleted_at','is',null):draftQuery.is('deleted_at',null).neq('status','sent').neq('status','sending').neq('status','submitted').neq('status','uncertain');
      const drafts = await checked(draftQuery.order('updated_at', { ascending: false }).limit(500));
      const current = drafts.filter(d => trash ? !!d.deleted_at : actionable(d)).filter((d,i,a)=>a.findIndex(other=>other.thread_id===d.thread_id)===i);
      if (!current.length) return reply(res, 200, { records: [] });
      const threads = await checked(db.from('email_threads').select('id,subject,status,priority,customer_id,last_message_at,mailbox_id,provider_thread_key').in('id', current.map(d => d.thread_id)));
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
      const thread = await checked(db.from('email_threads').select('id,subject,status,priority,customer_id,last_message_at,mailbox_id').eq('id', id).maybeSingle());
      if (!thread) return reply(res, 404, { error: 'Conversation not found.' });
      let draftQuery = db.from('email_drafts').select('id,thread_id,current_body,original_ai_body,to_addresses,subject,status,updated_at,deleted_at').eq('thread_id', id).neq('status', 'sent');
      draftQuery = url.searchParams.get('trash') === 'true' ? draftQuery.not('deleted_at','is',null) : draftQuery.is('deleted_at',null);
      const draft = await checked(draftQuery.order('updated_at', { ascending: false }).limit(1).maybeSingle());
      if (!draft || (!draft.deleted_at && !actionable(draft))) return reply(res, 404, { error: 'This conversation has no current AI reply draft.' });
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
    if (input?.action === 'signature') {
      let fields;
      try { fields = cleanSignatureFields(input.fields); } catch (error) { return reply(res, 400, { error: error.message }); }
      const current = await checked(db.from('crm_email_signature').select('banner_base64').eq('id', 1).maybeSingle());
      if (!current) return reply(res, 404, { error: 'No signature is set up yet. Run the signature seed first.' });
      await checked(db.from('crm_email_signature').update({ fields, html: signatureHtml(fields, { banner: !!current.banner_base64 }), enabled: input.enabled !== false, updated_at: new Date().toISOString(), updated_by: session.email }).eq('id', 1));
      return reply(res, 200, { success: true });
    }
    if (['delete','restore'].includes(input?.action)) {
      if(!uuid(input.draft_id)||!Number.isFinite(Date.parse(input.updated_at))) return reply(res,400,{error:'Reload the draft before changing it.'});
      const result=await checked(db.rpc('crm_draft_trash',{p_id:input.draft_id,p_updated_at:input.updated_at,p_restore:input.action==='restore',p_actor:session.email}));
      return reply(res,200,{success:true,...result});
    }
    if (!input || typeof input !== 'object' || !['rewrite', 'regenerate', 'save', 'send'].includes(input.action) || !uuid(input.thread_id) || !uuid(input.draft_id)) return reply(res, 400, { error: 'Invalid AI reply request.' });
    const draft = await checked(db.from('email_drafts').select('id,thread_id,status,original_ai_body,deleted_at').eq('id', input.draft_id).eq('thread_id', input.thread_id).maybeSingle());
    if (!actionable(draft) && !(input.action==='regenerate' && draft && !draft.deleted_at && draft.status==='editing' && !draft.original_ai_body)) return reply(res, 409, { error: 'The AI draft is no longer ready for review.' });
    if (input.action === 'rewrite' && (typeof input.instruction !== 'string' || !input.instruction.trim() || input.instruction.length > 4000)) return reply(res, 400, { error: 'Enter an instruction for the AI.' });
    if (input.action === 'save' && (typeof input.body_text !== 'string' || !input.body_text.trim() || input.body_text.length > 50000)) return reply(res, 400, { error: 'Draft body is missing or too long.' });
    if (input.action === 'send') {
      if (!Array.isArray(input.attachments) || input.attachments.length > 5 || input.attachments.some(file => !file || typeof file.name !== 'string' || !file.name.trim() || file.name.length > 200 || typeof file.content_type !== 'string' || typeof file.content_base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.content_base64) || file.content_base64.length > 4 * 1024 * 1024) || input.attachments.reduce((size, file) => size + file.content_base64.length, 0) > 4 * 1024 * 1024) return reply(res, 400, { error: 'Attach up to five files, with a combined size under 3 MB.' });
    }
    // Sending runs here through Microsoft Graph; n8n is used only to write and rewrite drafts.
    if (input.action === 'send') {
      if (typeof input.updated_at !== 'string' || !Number.isFinite(Date.parse(input.updated_at))) return reply(res, 400, { error: 'Reload the draft before sending.' });
      const connected = injected.graph ? { graph: injected.graph, connection: { email_address: injected.mailbox } } : await delegatedGraphClient(env);
      if (!connected) return reply(res, 503, { error: 'Connect the Outlook mailbox before sending.' });
      const result = await sendAiDraft({ db, graph: connected.graph, mailbox: connected.connection.email_address, draftId: draft.id, updatedAt: input.updated_at, attachments: input.attachments, actor: session.email });
      return reply(res, result.status, result.body);
    }
    const config = n8nConfig(env);
    if (!config.emailAssistantWebhook) return reply(res, 503, { error: 'AI email workflow URL is not configured.' });
    const payload = { action: input.action, thread_id: draft.thread_id, draft_id: draft.id, actor: session.email, request_id: uuid(input.request_id) ? input.request_id : crypto.randomUUID() };
    if (input.action === 'rewrite') payload.instruction = input.instruction.trim();
    if (input.action === 'save') { payload.body_text = input.body_text; payload.body_html = typeof input.body_html === 'string' ? input.body_html.slice(0, 100000) : ''; }
    const upstream = await (injected.fetch || fetch)(config.emailAssistantWebhook, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(config.crmWebhookSecret ? { [config.crmSecretHeader]: config.crmWebhookSecret } : {}) }, body: JSON.stringify(payload), signal: AbortSignal.timeout(90000) });
    const raw = await upstream.text();
    let result;
    try { result = JSON.parse(raw); } catch { return reply(res, 502, { error: 'AI email workflow returned an invalid response. Your draft is preserved.' }); }
    if (!upstream.ok || !result?.success) return reply(res, 502, { error: String(result?.error || result?.message || 'AI email workflow failed. Your draft is preserved.').slice(0, 500) });
    if(input.action==='regenerate' && !draft.original_ai_body){
      const generated=await checked(db.from('email_drafts').select('current_body,deleted_at,status').eq('id',draft.id).single());
      if(!generated.current_body || generated.deleted_at || generated.status!=='editing')return reply(res,409,{error:'The draft changed during generation. Reload it.'});
      await checked(db.from('email_drafts').update({original_ai_body:generated.current_body}).eq('id',draft.id).is('original_ai_body',null).is('deleted_at',null).eq('status','editing'));
    }
    return reply(res, 200, result);
  } catch (error) {
    return reply(res, 500, { error: error?.message || 'AI email request failed.' });
  }
}
