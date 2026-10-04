// Recover missing SMTP identities from explicit stored headers/properties only.
import { PSTFile } from 'pst-extractor';
import { PSTUtil } from 'pst-extractor/dist/PSTUtil.class.js';
import Long from 'long';
import { createReadStream, createWriteStream, readFileSync, renameSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { resolve } from 'node:path';

const output = resolve('.tools/email-archive');
const manifest = JSON.parse(readFileSync(resolve(output, 'direct-source.json'), 'utf8'));
const pst = new PSTFile(manifest.path);
const cache = resolve(output, 'messages.jsonl');
const pending = resolve(output, 'messages.enriched.jsonl');
const out = createWriteStream(pending, { encoding: 'utf8' });
let total = 0, resolved = 0, missing = 0, errors = 0;
const smtp = value => {
  const text = String(value || '').trim().toLowerCase();
  return /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(text) ? text : '';
};
try {
  for await (const line of createInterface({ input: createReadStream(cache, { encoding: 'utf8' }), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const record = JSON.parse(line); total++;
    if (!record.sender_email) {
      try {
        const mail = PSTUtil.detectAndLoadPSTObject(pst, Long.fromString(record.source_id));
        const headers = String(mail.transportMessageHeaders || '').replace(/\r?\n[ \t]+/g, ' ');
        const from = headers.match(/^From:\s*(.+)$/im)?.[1] || '';
        const addresses = [...from.matchAll(/[\w.!#$%&'*+/=?^`{|}~-]+@[\w.-]+\.[A-Za-z]{2,}/g)].map(m => smtp(m[0])).filter(Boolean);
        const headerEmail = addresses.length === 1 ? addresses[0] : '';
        const storedEmail = smtp(mail.getStringItem(0x5d02)) || smtp(mail.sentRepresentingEmailAddress);
        if (headerEmail || storedEmail) {
          record.sender_email = headerEmail || storedEmail;
          record.sender_address_source = headerEmail ? 'stored_from_header' : 'stored_representing_smtp';
          resolved++;
        }
      } catch { errors++; }
    }
    if (!record.sender_email) missing++;
    if (!out.write(JSON.stringify(record) + '\n')) await once(out, 'drain');
  }
  out.end(); await once(out, 'finish');
  renameSync(pending, cache);
} finally { pst.close(); }
console.log(JSON.stringify({ messages: total, recovered_sender_addresses: resolved, unresolved_sender_addresses: missing, errors }));
