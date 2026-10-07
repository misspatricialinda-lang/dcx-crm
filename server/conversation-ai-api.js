import { createClient } from '@supabase/supabase-js';
import { configuration, getSession } from './auth-core.js';
import { delegatedGraphClient } from './microsoft-oauth.js';
import { CONVERSATION_AI_SYSTEM_PROMPT } from './conversation-ai-prompt.js';
import { retrieveEmailMemory } from './email-memory.js';

const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0/me/';
const MAX_MESSAGES = 100;
const MAX_FILES = 20;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const documentTypes = new Set(['pdf', 'txt', 'md', 'json', 'html', 'xml', 'csv', 'tsv', 'doc', 'docx', 'rtf', 'odt', 'ppt', 'pptx', 'xls', 'xlsx', 'eml', 'ics', 'vcf', 'log']);
const imageTypes = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const mimeByExtension = { pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json', html: 'text/html', xml: 'application/xml', csv: 'text/csv', tsv: 'text/tab-separated-values', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', rtf: 'application/rtf', odt: 'application/vnd.oasis.opendocument.text', ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', eml: 'message/rfc822', ics: 'text/calendar', vcf: 'text/x-vcard', log: 'text/plain', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const respond = (res, status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
const checked = async query => { const { data, error } = await query; if (error) throw error; return data; };
const outputText = response => (response.output || []).flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('');

async function readBody(req) {
  let raw = '';
  if (req.body !== undefined) raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  else for await (const chunk of req) { raw += chunk; if (raw.length > 10000) throw new Error('Request is too large.'); }
  if (raw.length > 10000) throw new Error('Request is too large.');
  return JSON.parse(raw || '{}');
}
async function openai(path, body, env, transport) {
  const response = await transport(`https://api.openai.com/v1/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`OpenAI ${path} request failed (${response.status}): ${String(data.error?.message || 'Try again.').slice(0, 180)}`);
  return data;
}
async function conversationMessages(graph, id) {
  const fields = 'id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isDraft,body,hasAttachments';
  let path = `/messages?${new URLSearchParams({ '$filter': `conversationId eq '${id.replaceAll("'", "''")}'`, '$top': '50', '$select': fields })}`;
  const records = [];
  let truncated = false;
  while (path) {
    const page = await graph(path, { text: true });
    records.push(...(page.value || []));
    const next = page['@odata.nextLink'];
    if (records.length >= MAX_MESSAGES) { truncated = !!next || records.length > MAX_MESSAGES; break; }
    if (next && !next.startsWith(GRAPH_ROOT)) throw new Error('Microsoft returned an invalid conversation page.');
    path = next || null;
  }
  return { messages: records.slice(0, MAX_MESSAGES).sort((a, b) => Date.parse(a.receivedDateTime || a.sentDateTime || 0) - Date.parse(b.receivedDateTime || b.sentDateTime || 0)), truncated };
}
async function attachmentInputs(graph, messages) {
  const attachments = [], inputs = [];
  let total = 0, seen = 0;
  for (const message of messages.filter(item => item.hasAttachments)) {
    let path = `/messages/${encodeURIComponent(message.id)}/attachments?$select=id,name,contentType,size,isInline&$top=100`;
    while (path) {
      const page = await graph(path);
      for (const item of page.value || []) {
        if (item.isInline) continue;
        const name = String(item.name || 'attachment').slice(0, 200);
        const extension = name.split('.').pop()?.toLowerCase() || '';
        const info = { message_id: message.id, name, status: 'read' };
        attachments.push(info);
        seen++;
        if (!documentTypes.has(extension) && !imageTypes.has(extension)) { info.status = 'unsupported'; continue; }
        if (seen > MAX_FILES || item.size > MAX_FILE_BYTES || total + item.size > MAX_TOTAL_BYTES) { info.status = 'too_large_or_many'; continue; }
        try {
          const response = await graph(`/messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(item.id)}/$value`, { raw: true });
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.length > MAX_FILE_BYTES || total + bytes.length > MAX_TOTAL_BYTES) { info.status = 'too_large_or_many'; continue; }
          total += bytes.length;
          const type = mimeByExtension[extension];
          const data = `data:${type};base64,${bytes.toString('base64')}`;
          inputs.push(imageTypes.has(extension) ? { type: 'input_image', image_url: data } : { type: 'input_file', filename: name, file_data: data });
        } catch { info.status = 'unreadable'; }
      }
      const next = page['@odata.nextLink'];
      if (next && !next.startsWith(GRAPH_ROOT)) throw new Error('Microsoft returned an invalid attachment page.');
      path = next || null;
    }
  }
  return { attachments, inputs };
}

export async function conversationAiHandler(req, res, env = process.env, injected = {}) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!getSession(req, configuration(env))) return respond(res, 401, { error: 'Sign in to analyze conversations.' });
  if (req.method !== 'POST') return respond(res, 405, { error: 'Method not allowed.' });
  const protocol = env.NODE_ENV === 'production' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  if (req.headers.origin !== `${protocol}://${req.headers.host}` || req.headers['sec-fetch-site'] === 'cross-site') return respond(res, 403, { error: 'Request origin is not allowed.' });
  if (!env.OPENAI_API_KEY) return respond(res, 503, { error: 'Configure OPENAI_API_KEY on the server to enable conversation AI.' });
  if (!injected.db && (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY)) return respond(res, 503, { error: 'Supabase knowledge base is not configured.' });
  try {
    const input = await readBody(req);
    const id = input.conversationId;
    if (typeof id !== 'string' || !id || id.length > 2048) return respond(res, 400, { error: 'Select a conversation.' });
    const delegated = injected.graph ? null : await delegatedGraphClient(env);
    const graph = injected.graph || delegated?.graph;
    if (!graph) return respond(res, 503, { error: 'Connect a Microsoft mailbox to analyze conversations.' });
    const mailbox = (injected.mailbox || delegated?.connection.email_address || env.MICROSOFT_MAILBOX || '').toLowerCase();
    const { messages, truncated } = await conversationMessages(graph, id);
    if (!messages.length) return respond(res, 404, { error: 'Conversation not found in the connected mailbox.' });
    const { attachments, inputs } = await attachmentInputs(graph, messages);
    const latestInbound = mailbox ? [...messages].reverse().find(message => !message.isDraft && message.from?.emailAddress?.address?.toLowerCase() !== mailbox) : null;
    const transcript = messages.map((message, index) => `[${index + 1}] ${message.sentDateTime || message.receivedDateTime || ''} From: ${message.from?.emailAddress?.address || 'unknown'} To: ${(message.toRecipients || []).map(item => item.emailAddress?.address).join(', ')} Subject: ${message.subject || ''}\n${String(message.body?.content || '').slice(0, 25000)}`).join('\n\n');
    const db = injected.db || createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const transport = injected.fetch || fetch;
    const embedding = await openai('embeddings', { model: env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small', input: transcript.slice(-10000) }, env, transport);
    const vector = embedding.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length !== 1536) throw new Error('Knowledge search embedding must have 1536 dimensions. Check OPENAI_EMBEDDING_MODEL.');
    const memory = await retrieveEmailMemory(db, messages, mailbox, vector);
    const matches = await checked(db.rpc('match_documents', { query_embedding: vector, match_count: 6, filter: {} }));
    const knowledge = (matches || []).map((row, index) => ({ id: `K${index + 1}`, text: String(row.content || '').slice(0, 3000), similarity: row.similarity }));
    const attachmentNote = attachments.length ? attachments.map(item => `${item.name}: ${item.status}`).join('; ') : 'No non-inline attachments.';
    const schema = { type: 'object', additionalProperties: false, required: ['summary', 'customer_request', 'next_steps', 'reply_needed', 'draft_reply', 'uncertainties'], properties: { summary: { type: 'string' }, customer_request: { type: 'string' }, next_steps: { type: 'array', items: { type: 'string' } }, reply_needed: { type: 'boolean' }, draft_reply: { type: 'string' }, uncertainties: { type: 'array', items: { type: 'string' } } } };
    const response = await openai('responses', { model: env.OPENAI_CONVERSATION_MODEL || 'gpt-5.1', store: false, max_output_tokens: 1800, text: { format: { type: 'json_schema', name: 'conversation_analysis', strict: true, schema } }, instructions: CONVERSATION_AI_SYSTEM_PROMPT, input: [{ role: 'user', content: [{ type: 'input_text', text: `Connected mailbox: ${mailbox}\nLatest inbound message ID: ${latestInbound?.id || 'none'}\nConversation truncated: ${truncated}\nAttachment read status: ${attachmentNote}\n\nEmail chain (oldest first):\n${transcript.slice(-100000)}\n\nHistorical email memory (private evidence; attachment references are not file contents):\n${JSON.stringify(memory)}\n\nRelevant knowledge base passages:\n${knowledge.map(item => `[${item.id}] ${item.text}`).join('\n\n') || 'No matching passages.'}` }, ...inputs] }] }, env, transport);
    const analysis = JSON.parse(outputText(response));
    if (!analysis || typeof analysis.summary !== 'string' || typeof analysis.customer_request !== 'string' || !Array.isArray(analysis.next_steps) || typeof analysis.reply_needed !== 'boolean' || typeof analysis.draft_reply !== 'string' || !Array.isArray(analysis.uncertainties)) throw new Error('AI returned an incomplete conversation analysis.');
    return respond(res, 200, { analysis, attachments, truncated, message_count: messages.length, knowledge_sources: knowledge.map(({ id, similarity }) => ({ id, similarity })), email_memory: { status: memory.status, retrieval: memory.retrieval, semantic_records: memory.semantic_records || 0, index_status: memory.index_status, matching_messages: memory.matching_messages || 0, sources: (memory.messages || []).map(({ source, id, occurred_at, subject }) => ({ source, id, occurred_at, subject })) }, reply_to_message_id: latestInbound?.id || null });
  } catch (error) {
    return respond(res, error.status || 502, { error: error.message || 'Conversation analysis failed.' });
  }
}
