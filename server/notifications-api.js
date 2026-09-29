import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';
import { createHash, timingSafeEqual } from 'node:crypto';
import { configuration, getSession } from './auth-core.js';

const reply = (res, status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
const same = (a, b) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
const checked = async query => { const { data, error } = await query; if (error) throw error; return data; };
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
async function readBody(req) {
  if (req.body !== undefined) return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 12000) throw new Error('Request too large.'); }
  return JSON.parse(raw || '{}');
}
export async function notificationsHandler(req, res, env = process.env, injected = {}) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const action = new URL(req.url || '/', 'http://localhost').searchParams.get('action') || 'list';
  const dispatchToken = String(env.PUSH_DISPATCH_TOKEN || '');
  const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
  const worker = action === 'dispatch' && dispatchToken.length >= 32 && same(token, dispatchToken);
  const session = getSession(req, configuration(env));
  if (!session && !worker) return reply(res, 401, { error: 'Sign in to view notifications.' });
  if (worker && req.method !== 'POST') return reply(res, 405, { error: 'Method not allowed.' });
  if (!worker && req.method === 'POST') {
    const protocol = env.NODE_ENV === 'production' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    if (req.headers.origin !== `${protocol}://${req.headers.host}` || req.headers['sec-fetch-site'] === 'cross-site') return reply(res, 403, { error: 'Request origin is not allowed.' });
  }
  if (!injected.db && (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY)) return reply(res, 503, { error: 'Notifications are not configured yet.' });
  const db = injected.db || createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    if (action === 'config' && req.method === 'GET') return reply(res, 200, { publicKey: env.WEB_PUSH_VAPID_PUBLIC_KEY || '', available: !!(env.WEB_PUSH_VAPID_PUBLIC_KEY && env.WEB_PUSH_VAPID_PRIVATE_KEY) });
    if (action === 'list' && req.method === 'GET') {
      const [records, unreadResult] = await Promise.all([
        checked(db.from('crm_notifications').select('id,thread_id,sender,subject,preview,occurred_at,created_at,read_at').order('created_at', { ascending: false }).limit(80)),
        db.from('crm_notifications').select('id', { count: 'exact', head: true }).is('read_at', null)
      ]);
      if (unreadResult.error) throw unreadResult.error;
      return reply(res, 200, { records, unread: unreadResult.count || 0 });
    }
    if (req.method !== 'POST') return reply(res, 405, { error: 'Method not allowed.' });
    if (action === 'dispatch') {
      if (!worker) return reply(res, 403, { error: 'Dispatch access denied.' });
      if (!env.WEB_PUSH_VAPID_PUBLIC_KEY || !env.WEB_PUSH_VAPID_PRIVATE_KEY) return reply(res, 503, { error: 'Phone notifications are not configured.' });
      const subscriptions = await checked(db.from('crm_push_subscriptions').select('id,subscription,created_at'));
      if (!subscriptions.length) return reply(res, 200, { sent: 0, reason: 'No subscribed devices.' });
      webpush.setVapidDetails(`mailto:${env.APP_LOGIN_EMAIL}`, env.WEB_PUSH_VAPID_PUBLIC_KEY, env.WEB_PUSH_VAPID_PRIVATE_KEY);
      const notifications = await checked(db.rpc('crm_claim_push_notifications', { p_limit: 20 }));
      let sent = 0;
      for (const item of notifications) {
        const deliveries = await checked(db.from('crm_push_deliveries').select('subscription_id').eq('notification_id', item.id));
        const deliveredIds = new Set(deliveries.map(delivery => delivery.subscription_id));
        const payload = JSON.stringify({ title: item.sender || 'New email', body: item.subject || 'Open the CRM to review', url: '/#notifications', tag: item.message_id });
        const results = await Promise.allSettled(subscriptions.filter(device => new Date(device.created_at).getTime() <= new Date(item.created_at).getTime() && !deliveredIds.has(device.id)).map(async device => {
          try {
            await webpush.sendNotification(device.subscription, payload, { TTL: 3600 });
            await checked(db.from('crm_push_deliveries').upsert({ notification_id: item.id, subscription_id: device.id }, { onConflict: 'notification_id,subscription_id' }));
            return true;
          }
          catch (error) {
            if ([404, 410].includes(error.statusCode)) await checked(db.from('crm_push_subscriptions').delete().eq('id', device.id));
            throw error;
          }
        }));
        const delivered = results.some(result => result.status === 'fulfilled');
        const error = results.filter(result => result.status === 'rejected').map(result => String(result.reason?.message || result.reason)).join('; ').slice(0, 500);
        await checked(db.from('crm_notifications').update({ push_sent_at: delivered ? new Date().toISOString() : null, push_claimed_at: null, push_last_error: error || null }).eq('id', item.id));
        if (delivered) sent++;
      }
      return reply(res, 200, { sent });
    }
    const body = await readBody(req);
    if (action === 'read') {
      if (!uuid(body.id)) return reply(res, 400, { error: 'Invalid notification.' });
      await checked(db.from('crm_notifications').update({ read_at: new Date().toISOString() }).eq('id', body.id));
      return reply(res, 200, { ok: true });
    }
    if (action === 'read-all') {
      await checked(db.from('crm_notifications').update({ read_at: new Date().toISOString() }).is('read_at', null));
      return reply(res, 200, { ok: true });
    }
    if (action === 'subscribe') {
      const subscription = body.subscription;
      if (!subscription || typeof subscription.endpoint !== 'string' || !subscription.endpoint.startsWith('https://') || subscription.endpoint.length > 2000 || typeof subscription.keys?.p256dh !== 'string' || typeof subscription.keys?.auth !== 'string') return reply(res, 400, { error: 'Invalid phone subscription.' });
      await checked(db.from('crm_push_subscriptions').upsert({ endpoint: subscription.endpoint, subscription, user_agent: String(req.headers['user-agent'] || '').slice(0, 300), updated_at: new Date().toISOString() }, { onConflict: 'endpoint' }));
      return reply(res, 200, { ok: true });
    }
    if (action === 'unsubscribe') {
      if (typeof body.endpoint !== 'string' || body.endpoint.length > 2000) return reply(res, 400, { error: 'Invalid phone subscription.' });
      await checked(db.from('crm_push_subscriptions').delete().eq('endpoint', body.endpoint));
      return reply(res, 200, { ok: true });
    }
    return reply(res, 400, { error: 'Unknown notification action.' });
  } catch (error) { return reply(res, 503, { error: error.message || 'Notifications are unavailable.' }); }
}
