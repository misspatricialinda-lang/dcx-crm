// Loads Raza's Outlook signature (recovered from backup.pst Sent Items) as the company signature.
// Usage: node scripts/seed-email-signature.mjs [--force]   (reads DATABASE_URL from .env)
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { signatureHtml } from '../server/email-signature.js';

const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]; }));
const fields = {
  name: 'Raza Iqbal',
  title: 'Field Service Specialist',
  direct_phone: '647-890-3396',
  email: 'Raza.Iqbal@dcx-tech.com',
  support_label: 'For 24/7 Technical Support:',
  support_phone: '1-844 329 6999',
  support_email: 'emergency@dcx-tech.com',
};
const banner = readFileSync(new URL('../supabase/seed/dcx-signature-banner.jpg', import.meta.url)).toString('base64');
const db = new pg.Client({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
try {
  const result = await db.query(
    `insert into public.crm_email_signature (id, fields, html, banner_base64, banner_content_type, source, updated_by)
     values (1, $1, $2, $3, 'image/jpeg', 'backup.pst Sent Items, Raza Iqbal reply signature (Sep 2026)', 'seed')
     on conflict (id) do ${process.argv.includes('--force') ? "update set fields=excluded.fields, html=excluded.html, banner_base64=excluded.banner_base64, source=excluded.source, updated_by='seed', updated_at=now()" : 'nothing'}
     returning id`,
    [fields, signatureHtml(fields), banner]);
  console.log(result.rowCount ? 'Signature saved.' : 'A signature already exists; use --force to replace it.');
} finally { await db.end(); }
