"""Full, resumable local PST export. Retains identity and original bodies.

No network calls or attachment content extraction. Private output is ignored.
Run: python automation/extract_email_archive.py
"""
import argparse
import collections
import datetime
import hashlib
import json
import pathlib
import win32com.client

ROOT = pathlib.Path(__file__).resolve().parents[1]
PROPS = 'http://schemas.microsoft.com/mapi/proptag/'


def prop(item, tag):
    try:
        return str(item.PropertyAccessor.GetProperty(PROPS + tag) or '')
    except Exception:
        return ''


def address(entry):
    try:
        smtp = prop(entry, '0x39FE001F') or prop(entry, '0x39FE001E')
        if '@' in smtp:
            return smtp.strip().lower()
        if entry.Type == 'EX':
            # Do not contact an unavailable Exchange server during offline export.
            # Missing SMTP addresses remain explicitly unresolved for later review.
            value = ''
        else:
            value = entry.Address
        value = str(value or '').strip().lower()
        return value if '@' in value and not value.startswith('/o=') else ''
    except Exception:
        return ''


def stamp(value):
    try:
        return value.astimezone(datetime.timezone.utc).isoformat()
    except Exception:
        return None


def extract(mail, folder, archive_id):
    source_id = str(mail.EntryID)
    sender = (prop(mail, '0x5D01001F') or prop(mail, '0x5D01001E')).strip().lower()
    if '@' not in sender:
        sender = address(mail.Sender)
    recipients = []
    for recipient in mail.Recipients:
        recipients.append({'name': str(recipient.Name or ''), 'email': address(recipient.AddressEntry), 'type': int(recipient.Type)})
    internet_id = prop(mail, '0x1035001F') or prop(mail, '0x1035001E')
    conversation = str(mail.ConversationID or '')
    attachments = []
    for index in range(1, mail.Attachments.Count + 1):
        attachment = mail.Attachments.Item(index)
        attachments.append({'source_index': index, 'name': str(attachment.FileName or ''), 'size_bytes': int(attachment.Size), 'content_id': prop(attachment, '0x3712001F'), 'storage_path': None, 'status': 'reference_only'})
    return {
        'archive_id': archive_id, 'source_id': source_id,
        'source_key': hashlib.sha256((archive_id + ':' + source_id).encode()).hexdigest(),
        'folder': folder, 'internet_message_id': internet_id or None,
        'in_reply_to': prop(mail, '0x1042001F') or prop(mail, '0x1042001E') or None,
        'conversation_id': conversation or None,
        'thread_key': conversation or internet_id or source_id,
        'sender_name': str(mail.SenderName or ''), 'sender_email': sender,
        'recipients': recipients, 'subject': str(mail.Subject or ''),
        'sent_at': stamp(mail.SentOn), 'received_at': stamp(mail.ReceivedTime),
        'body_text': str(mail.Body or ''), 'attachments': attachments,
        'is_draft': not bool(mail.Sent),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pst', type=pathlib.Path, default=ROOT / 'backup.pst')
    parser.add_argument('--output', type=pathlib.Path, default=ROOT / '.tools/email-archive')
    args = parser.parse_args()
    pst = args.pst.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    manifest = args.output / 'source.json'
    if manifest.exists():
        saved = json.loads(manifest.read_text(encoding='utf-8'))
        if saved['path'].lower() != str(pst).lower():
            raise RuntimeError('Use a separate output folder for a different PST')
        archive_id = saved['archive_id']
    else:
        # Outlook can update PST metadata when mounting it. Persist identity once.
        archive_id = hashlib.sha256(f'{pst.name}:{pst.stat().st_size}:{pst.stat().st_mtime_ns}'.encode()).hexdigest()
        existing_cache = args.output / 'messages.jsonl'
        if existing_cache.exists() and existing_cache.stat().st_size:
            with existing_cache.open(encoding='utf-8') as existing:
                archive_id = json.loads(existing.readline())['archive_id']
        manifest.write_text(json.dumps({'path': str(pst), 'archive_id': archive_id}, indent=2), encoding='utf-8')
    cache = args.output / 'messages.jsonl'
    seen = set()
    if cache.exists():
        # Recover only an interrupted final line; never discard valid earlier records.
        with cache.open('rb+') as existing:
            while line := existing.readline():
                try:
                    record = json.loads(line)
                    seen.add(record['source_key'])
                except (ValueError, KeyError):
                    if existing.read(1):
                        raise RuntimeError('Corrupt archive export before final line')
                    existing.truncate(existing.tell() - len(line))
                    break
    ns = win32com.client.Dispatch('Outlook.Application').GetNamespace('MAPI')
    store = next((s for s in ns.Stores if str(s.FilePath).lower() == str(pst).lower()), None)
    attached = store is None
    if attached:
        ns.AddStoreEx(str(pst), 2)
        store = next(s for s in ns.Stores if str(s.FilePath).lower() == str(pst).lower())
    folders, errors = [], []
    counts = collections.Counter()
    def walk(folder, parent, out):
        path = parent + '/' + str(folder.Name)
        table = folder.GetTable()
        table.Columns.RemoveAll()
        table.Columns.Add('EntryID')
        table.Columns.Add('MessageClass')
        count = 0
        while not table.EndOfTable:
            row = table.GetNextRow()
            if not str(row.Item('MessageClass')).startswith('IPM.Note'):
                continue
            count += 1
            source_id = str(row.Item('EntryID'))
            key = hashlib.sha256((archive_id + ':' + source_id).encode()).hexdigest()
            if key in seen:
                counts['already_cached'] += 1
                continue
            try:
                record = extract(ns.GetItemFromID(source_id, store.StoreID), path, archive_id)
                out.write(json.dumps(record, ensure_ascii=False) + '\n')
                out.flush()
                seen.add(key)
                counts['extracted'] += 1
                if counts['extracted'] % 250 == 0:
                    print(f"Extracted {counts['extracted']} messages", flush=True)
            except Exception as error:
                errors.append({'source_id': source_id, 'folder': path, 'error_type': type(error).__name__})
        folders.append({'folder': path, 'mail_items': count})
        for child in folder.Folders:
            walk(child, path, out)
    try:
        with cache.open('a', encoding='utf-8') as out:
            walk(store.GetRootFolder(), '', out)
    finally:
        if attached:
            ns.RemoveStore(store.GetRootFolder())
    for name, value in [('inventory.json', folders), ('errors.json', errors)]:
        (args.output / name).write_text(json.dumps(value, indent=2), encoding='utf-8')
    senders, participants, dates = set(), set(), []
    attachment_count = unresolved = total = 0
    with cache.open(encoding='utf-8') as source:
        for line in source:
            record = json.loads(line)
            total += 1
            if record['sender_email']:
                senders.add(record['sender_email'])
                participants.add(record['sender_email'])
            else:
                unresolved += 1
            participants.update(r['email'] for r in record['recipients'] if r['email'])
            attachment_count += len(record['attachments'])
            if record['sent_at']:
                dates.append(record['sent_at'])
    summary = {'messages_cached': total, 'mail_items_in_inventory': sum(f['mail_items'] for f in folders), 'unique_senders': len(senders), 'unique_participant_addresses': len(participants), 'unresolved_sender_addresses': unresolved, 'attachment_references': attachment_count, 'date_min': min(dates, default=None), 'date_max': max(dates, default=None), 'errors': len(errors), 'complete': not errors and total == sum(f['mail_items'] for f in folders), 'external_ai_calls': 0, 'attachment_contents_extracted': 0, **counts}
    (args.output / 'summary.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
