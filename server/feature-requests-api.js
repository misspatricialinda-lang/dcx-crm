import { createClient } from '@supabase/supabase-js';
import { configuration, getSession } from './auth-core.js';

const areas = new Set(['general','inbox','customers','quotations','calendar','reporting','other']);
const priorities = new Set(['low','normal','high']);
const statuses = new Set(['new','reviewing','planned','in_progress','completed','declined']);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const respond = (res, status, body) => { res.statusCode = status; res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(body)); };
const checked = async query => { const { data, error } = await query; if (error) throw error; return data; };

async function readBody(req) {
  let raw = req.body === undefined ? '' : typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  if (req.body === undefined) for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 16000) throw new Error('Request is too large.');
  }
  if (Buffer.byteLength(raw) > 16000) throw new Error('Request is too large.');
  const value = JSON.parse(raw || '{}');
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Invalid request.');
  return value;
}

export async function featureRequestsHandler(req, res, env = process.env, injectedDb) {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  const session = getSession(req, configuration(env));
  if (!session) return respond(res,401,{error:'Sign in to manage feature requests.'});
  if (!['GET','POST','PATCH'].includes(req.method)) return respond(res,405,{error:'Method not allowed.'});
  if (req.method !== 'GET') {
    const protocol = env.NODE_ENV === 'production' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    if (req.headers.origin !== `${protocol}://${req.headers.host}` || req.headers['sec-fetch-site'] === 'cross-site') return respond(res,403,{error:'Request origin is not allowed.'});
  }
  if (!injectedDb && (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY)) return respond(res,503,{error:'Supabase is not configured.'});
  const db = injectedDb || createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth:{ persistSession:false, autoRefreshToken:false } });
  try {
    if (req.method === 'GET') {
      const records = await checked(db.from('crm_feature_requests').select('*').order('created_at',{ascending:false}).limit(500));
      return respond(res,200,{records});
    }
    let input;
    try { input = await readBody(req); } catch (error) { return respond(res,400,{error:error.message}); }
    if (req.method === 'POST') {
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      const description = typeof input.description === 'string' ? input.description.trim() : '';
      if (title.length < 3 || title.length > 160 || description.length < 10 || description.length > 5000 || !areas.has(input.area) || !priorities.has(input.priority))
        return respond(res,400,{error:'Enter a title, description, area and priority.'});
      const record = await checked(db.from('crm_feature_requests').insert({title,description,area:input.area,priority:input.priority,created_by:session.email}).select('*').single());
      return respond(res,201,{record});
    }
    if (!uuid(input.id) || !Number.isSafeInteger(input.version) || input.version < 1 || !statuses.has(input.status) || !priorities.has(input.priority) || typeof input.owner_notes !== 'string' || input.owner_notes.length > 3000)
      return respond(res,400,{error:'Reload the request and enter a valid status, priority and note.'});
    const record = await checked(db.from('crm_feature_requests').update({status:input.status,priority:input.priority,owner_notes:input.owner_notes.trim(),version:input.version+1,updated_at:new Date().toISOString()}).eq('id',input.id).eq('version',input.version).select('*').maybeSingle());
    if (!record) return respond(res,409,{error:'This request changed elsewhere. Reload it before saving.'});
    return respond(res,200,{record});
  } catch (error) {
    return respond(res,503,{error:error.message || 'Feature requests are unavailable.'});
  }
}
