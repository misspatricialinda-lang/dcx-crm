// Resolve legacy Exchange addresses only through explicit, unique stored links.
import { PSTFile } from 'pst-extractor';
import { PSTUtil } from 'pst-extractor/dist/PSTUtil.class.js';
import Long from 'long';
import { createReadStream, createWriteStream, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { resolve } from 'node:path';

const directory = resolve('.tools/email-archive');
const cache = resolve(directory, 'messages.jsonl');
const pending = resolve(directory, 'messages.addresses.jsonl');
const manifest = JSON.parse(readFileSync(resolve(directory, 'direct-source.json'), 'utf8'));
const pst = new PSTFile(manifest.path);
const mappings = new Map(), rawSenders = new Map();
let errors = 0, resolved = 0, unresolved = 0;
const map = (raw, email) => {
  raw = String(raw || '').trim().toLowerCase();
  email = String(email || '').trim().toLowerCase();
  if (!raw.startsWith('/o=') || !email.includes('@')) return;
  if (!mappings.has(raw)) mappings.set(raw, new Set());
  mappings.get(raw).add(email);
};
try {
  for await (const line of createInterface({ input: createReadStream(cache, { encoding: 'utf8' }), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    try {
      const mail = PSTUtil.detectAndLoadPSTObject(pst, Long.fromString(record.source_id));
      const raw = String(mail.senderEmailAddress || '').trim().toLowerCase();
      rawSenders.set(record.source_key, raw);
      map(raw, record.sender_email);
      for (let i = 0; i < mail.numberOfRecipients; i++) {
        const recipient = mail.getRecipient(i);
        if (recipient) map(recipient.emailAddress, recipient.smtpAddress);
      }
    } catch { errors++; }
  }
} finally { pst.close(); }
const out = createWriteStream(pending, { encoding: 'utf8' });
for await (const line of createInterface({ input: createReadStream(cache, { encoding: 'utf8' }), crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  const record = JSON.parse(line);
  const raw = rawSenders.get(record.source_key);
  record.raw_sender_address = raw || '';
  const candidates = mappings.get(raw);
  if (!record.sender_email && candidates?.size === 1) {
    record.sender_email = [...candidates][0];
    record.sender_address_source = 'exact_mapi_address_mapping';
    resolved++;
  }
  if (!record.sender_email) unresolved++;
  if (!out.write(JSON.stringify(record) + '\n')) await once(out, 'drain');
}
out.end(); await once(out, 'finish');
renameSync(pending, cache);
const report = { exact_mapi_links: mappings.size, ambiguous_mapi_links: [...mappings.values()].filter(v => v.size > 1).length, recovered_sender_addresses: resolved, unresolved_sender_addresses: unresolved, errors };
writeFileSync(resolve(directory, 'address-resolution.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
