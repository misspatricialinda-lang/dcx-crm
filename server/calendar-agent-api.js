import { getSession, configuration } from './auth-core.js';
import { parseCalendarResponse } from './calendar-response.js';

const WEBHOOK = 'https://dcx-tech.app.n8n.cloud/webhook/bca2dd48-ecb0-49b9-b60a-bb87d9824cdc/chat';
function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}
async function readBody(req) {
  if (req.body !== undefined) return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 8192) throw new Error('Request too large'); }
  return JSON.parse(raw || '{}');
}

export async function calendarAgentHandler(req, res, env = process.env) {
  res.setHeader('Cache-Control', 'no-store');
  if (!getSession(req, configuration(env))) return send(res, 401, { error: 'Sign in to use Calendar Agent.' });
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed.' });
  const protocol = env.NODE_ENV === 'production' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  if (req.headers.origin !== `${protocol}://${req.headers.host}` || req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, { error: 'Request origin is not allowed.' });
  let body;
  try { body = await readBody(req); } catch { return send(res, 400, { error: 'Invalid request.' }); }
  const { message, sessionId } = body || {};
  if (typeof message !== 'string' || !message.trim() || message.length > 4000 || typeof sessionId !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(sessionId)) return send(res, 400, { error: 'Invalid message or session.' });
  try {
    const upstream = await fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'sendMessage', chatInput: message.trim(), sessionId }), signal: AbortSignal.timeout(90000) });
    const raw = await upstream.text();
    if (!upstream.ok) return send(res, 502, { error: 'Calendar Agent is unavailable. Check that the n8n workflow is active.' });
    const answer = parseCalendarResponse(raw);
    if (answer === null) return send(res, 502, { error: 'Calendar Agent returned an unexpected response.' });
    return send(res, 200, { answer });
  } catch { return send(res, 502, { error: 'Could not reach Calendar Agent. Please try again.' }); }
}
