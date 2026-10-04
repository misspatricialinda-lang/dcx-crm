// Private local export -> server-only Supabase history. No drafting/sending jobs.
import { createReadStream } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { createInterface } from 'node:readline';
import { loadEnv } from 'vite';
import { createClient } from '@supabase/supabase-js';

const env = { ...loadEnv('development', process.cwd(), ''), ...process.env };
const dryRun = process.argv.includes('--dry-run');
const file = process.argv.find(arg => arg.startsWith('--file='))?.slice(7) || '.tools/email-archive/messages.jsonl';
if (!dryRun && (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY)) throw new Error('Missing server Supabase configuration');
const db = dryRun ? null : createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(120000) }) } });
const existing = new Set();
if (db) {
  const { error } = await db.from('crm_email_archive').select('source_key').limit(0);
  if (error) throw new Error(`Apply 202610040001_email_memory.sql before import (${error.code}).`);
  for(let offset=0;;offset+=1000){
    const {data,error}=await db.from('crm_email_archive').select('source_key').order('source_key').range(offset,offset+999);
    if(error)throw new Error(`Could not check imported source keys (${error.code}).`);
    for(const record of data)existing.add(record.source_key);
    if(data.length<1000)break;
  }
  console.log(`Resume: ${existing.size} existing source keys will be preserved.`);
}
let batch = [], total = 0, attachments = 0, batchCharacters = 0, lastProgress = 0;
async function flush() {
  if (!batch.length) return;
  if (db) {
    // Preserve future attachment storage links on repeat imports.
    let error;
    for(let attempt=0;attempt<3;attempt++){
      ({error}=await db.from('crm_email_archive').upsert(batch,{onConflict:'source_key',ignoreDuplicates:true}));
      if(!error)break;
      if(error.code && !['57014','53300','PGRST000','PGRST001','PGRST002'].includes(error.code))break;
      console.log(`Retrying batch after a transient import failure (attempt ${attempt+1}).`);
      await delay(1000*(attempt+1));
    }
    if (error) throw new Error(`Import failed after ${total} rows (${error.code || 'transport error'}); safe to rerun.`);
  }
  total += batch.length;
  batch = [];
  batchCharacters = 0;
  if (total - lastProgress >= 500) {
    console.log(`${dryRun ? 'Validated' : 'Imported'} ${total} messages`);
    lastProgress = total;
  }
}
for await (const line of createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  const record = JSON.parse(line);
  const { archive_id, source_id, source_key, folder, internet_message_id, in_reply_to, conversation_id, thread_key, sender_name, sender_email, recipients, subject, sent_at, received_at, body_text, is_draft } = record;
  if (!source_key || !source_id || !archive_id || !thread_key || !Array.isArray(recipients) || typeof body_text !== 'string') throw new Error(`Invalid record after ${total + batch.length} messages`);
  if(existing.has(source_key))continue;
  const participant_emails = [...new Set([sender_email, ...recipients.map(r => r.email)].filter(v => typeof v === 'string' && v.includes('@')).map(v => v.trim().toLowerCase()))];
  attachments += record.attachments.length;
  batchCharacters += line.length;
  batch.push({ archive_id, source_id, source_key, source_id_type: record.source_id_type || 'outlook_entry_id', folder, internet_message_id, in_reply_to, conversation_id, thread_key, sender_name, sender_email, recipients, participant_emails, subject, sent_at, received_at, body_text, body_html: record.body_html || '', is_draft, attachments: record.attachments });
  if (batch.length >= 25 || batchCharacters >= 2_000_000) await flush();
}
await flush();
console.log(JSON.stringify({ messages: total, existing_messages:existing.size, attachment_references: attachments, dry_run: dryRun }));
