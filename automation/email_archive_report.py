"""Aggregate-only extraction/identity QA; never emits message bodies or addresses."""
import collections
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / '.tools/email-archive'


def main():
    report = json.loads((OUT / 'summary.json').read_text(encoding='utf-8'))
    senders, participants, keys, ids, body_sources = set(), set(), set(), collections.Counter(), collections.Counter()
    total = unresolved = attachments = drafts = empty = 0
    with (OUT / 'messages.jsonl').open(encoding='utf-8') as source:
        for line in source:
            m = json.loads(line)
            total += 1
            keys.add(m['source_key'])
            if m['sender_email']:
                senders.add(m['sender_email'])
                participants.add(m['sender_email'])
            else:
                unresolved += 1
            participants.update(r['email'] for r in m['recipients'] if r['email'])
            if m.get('internet_message_id'):
                ids[m['internet_message_id']] += 1
            body_sources[m.get('body_text_source', 'unknown')] += 1
            attachments += len(m['attachments'])
            drafts += int(m['is_draft'])
            empty += int(not m['body_text'].strip())
    report.update(messages_cached=total, unique_source_keys=len(keys), unique_senders=len(senders), unique_participant_addresses=len(participants), unresolved_sender_addresses=unresolved, attachment_references=attachments, drafts=drafts, empty_bodies=empty, unique_internet_message_ids=len(ids), additional_copies_with_same_internet_id=sum(count - 1 for count in ids.values()), body_sources=dict(body_sources))
    report['complete'] = report['errors'] == 0 and total == len(keys) == report['unique_mail_items_in_inventory']
    (OUT / 'summary.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
