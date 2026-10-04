// Offline PST reader: no Outlook, network, AI calls or attachment content reads.
import { PSTFile } from 'pst-extractor';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync, openSync, writeSync, closeSync, writeFileSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

const file = resolve(process.argv.find(a => a.startsWith('--pst='))?.slice(6) || 'backup.pst');
const output = resolve(process.argv.find(a => a.startsWith('--output='))?.slice(9) || '.tools/email-archive');
mkdirSync(output, { recursive: true });
const hash = text => createHash('sha256').update(text).digest('hex');
const manifestPath = resolve(output, 'direct-source.json');
let manifest;
if (existsSync(manifestPath)) {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.path.toLowerCase() !== file.toLowerCase()) throw new Error('Use a separate output directory for a different archive.');
} else {
  manifest = { path: file, archive_id: hash(file.toLowerCase()), parser: 'pst-extractor@1.12.0', source_id_type: 'pst_descriptor_node' };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}
const archiveId = manifest.archive_id;
const cache = resolve(output, 'messages.jsonl');
const seen = new Set();
if (existsSync(cache)) {
  for await (const line of createInterface({ input: createReadStream(cache, { encoding: 'utf8' }), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (record.archive_id !== archiveId) throw new Error('Output contains records from a different extraction method.');
    seen.add(record.source_key);
  }
}
const smtp = value => {
  const text = String(value || '').trim().toLowerCase();
  return text.includes('@') && !text.startsWith('/o=') ? text : '';
};
const date = value => value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
const pst = new PSTFile(file);
const descriptorIds = new Set(), inventory = [], errors = [];
const out = openSync(cache, 'a');
let added = 0;
function walk(folder, parent = '') {
  const path = `${parent}/${folder.displayName || 'Root'}`;
  // Search-folder nodes are virtual views, not additional stored correspondence.
  if (folder.getNodeType() === 3) {
    inventory.push({ folder: path, content_items: folder.contentCount, mail_items: 0, status: 'virtual_search_folder' });
    return;
  }
  let mailCount = 0;
  for (let index = 0; index < folder.contentCount; index++) {
    let mail, sourceId;
    try {
      mail = folder.getNextChild();
      if (!mail || !String(mail.messageClass || '').startsWith('IPM.Note')) continue;
      mailCount++;
      sourceId = String(mail.descriptorNodeId);
      descriptorIds.add(sourceId);
      const sourceKey = hash(`${archiveId}:${sourceId}`);
      if (seen.has(sourceKey)) continue;
      const recipients = [];
      for (let i = 0; i < mail.numberOfRecipients; i++) {
        const recipient = mail.getRecipient(i);
        if (recipient) recipients.push({ name: recipient.displayName || '', email: smtp(recipient.smtpAddress) || smtp(recipient.emailAddress), type: recipient.recipientType });
      }
      const attachments = [];
      for (let i = 0; i < mail.numberOfAttachments; i++) {
        const a = mail.getAttachment(i);
        attachments.push({ source_index: i, pst_attachment_number: a.attachNum, name: a.longFilename || a.filename || '', size_bytes: a.size, content_type: a.mimeTag, content_id: a.contentId, storage_path: null, status: 'reference_only' });
      }
      const conversation = mail.conversationId?.toString('hex') || null;
      const body = mail.body || '';
      const record = {
        archive_id: archiveId, source_id: sourceId, source_key: sourceKey, source_id_type: 'pst_descriptor_node', folder: path,
        internet_message_id: mail.internetMessageId || null, in_reply_to: mail.inReplyToId || null,
        conversation_id: conversation, thread_key: conversation || mail.internetMessageId || sourceId,
        sender_name: mail.senderName || '', sender_email: smtp(mail.getStringItem(0x5d01)) || smtp(mail.senderEmailAddress),
        recipients, subject: mail.subject || '', sent_at: date(mail.clientSubmitTime), received_at: date(mail.messageDeliveryTime),
        body_text: body, body_html: body ? '' : mail.bodyHTML || '', is_draft: mail.isUnsent, attachments,
      };
      // Keep HTML-only evidence readable without losing the original fallback HTML.
      if (!record.body_text && record.body_html) record.body_text = record.body_html.replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
      writeSync(out, JSON.stringify(record) + '\n');
      seen.add(sourceKey);
      added++;
      if (added % 500 === 0) console.log(`Extracted ${seen.size} messages`);
    } catch (error) {
      errors.push({ folder: path, index, source_id: sourceId || null, error_type: error.constructor.name });
      // Ensure the next attempt advances past an unreadable record.
      folder.moveChildCursorTo(index + 1);
    }
  }
  inventory.push({ folder: path, content_items: folder.contentCount, mail_items: mailCount });
  try {
    for (const child of folder.getSubFolders()) walk(child, path);
  } catch (error) {
    errors.push({ folder: path, stage: 'subfolders', error_type: error.constructor.name });
  }
}
try { walk(pst.getRootFolder()); } finally { closeSync(out); pst.close(); }
const senders = new Set(), participants = new Set(), dates = [];
let total = 0, attachments = 0, unresolved = 0, emptyBodies = 0, drafts = 0;
for await (const line of createInterface({ input: createReadStream(cache, { encoding: 'utf8' }), crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  const m = JSON.parse(line); total++;
  if (m.sender_email) { senders.add(m.sender_email); participants.add(m.sender_email); } else unresolved++;
  for (const r of m.recipients) if (r.email) participants.add(r.email);
  attachments += m.attachments.length;
  if (!m.body_text) emptyBodies++;
  if (m.is_draft) drafts++;
  if (m.sent_at) dates.push(m.sent_at);
}
dates.sort();
const summary = { messages_cached: total, unique_mail_items_in_inventory: descriptorIds.size, unique_senders: senders.size, unique_participant_addresses: participants.size, unresolved_sender_addresses: unresolved, empty_bodies: emptyBodies, drafts, attachment_references: attachments, date_min: dates[0] || null, date_max: dates.at(-1) || null, errors: errors.length, complete: errors.length === 0 && total === descriptorIds.size, external_ai_calls: 0, attachment_contents_extracted: 0, parser: manifest.parser };
for (const [name, data] of [['inventory.json', inventory], ['errors.json', errors], ['summary.json', summary]]) writeFileSync(resolve(output, name), JSON.stringify(data, null, 2));
console.log(JSON.stringify(summary, null, 2));
