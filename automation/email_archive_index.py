"""Build a private local contact/history search index; no model/network required.

python automation/email_archive_index.py build
python automation/email_archive_index.py search --email person@example.com --query battery
"""
import argparse
import json
import pathlib
import re
import sqlite3

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / '.tools/email-archive'


def build():
    OUT.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(OUT / 'history.sqlite')
    db.executescript('''
      create table if not exists messages(id text primary key, sender_email text, sender_name text,
        subject text, sent_at text, thread_key text, body_text text, attachments text, is_draft integer);
      create table if not exists participants(email text, message_id text, primary key(email,message_id));
      create index if not exists participants_email on participants(email);
      create virtual table if not exists search using fts5(id unindexed,subject,body_text);
    ''')
    total = 0
    contacts = {}
    with (OUT / 'messages.jsonl').open(encoding='utf-8') as source, db:
        # Rebuild transactionally so interrupted indexing preserves the old index.
        db.execute('delete from search')
        db.execute('delete from participants')
        db.execute('delete from messages')
        for line in source:
            m = json.loads(line)
            db.execute('insert into messages values(?,?,?,?,?,?,?,?,?)', (m['source_key'], m['sender_email'], m['sender_name'], m['subject'], m['sent_at'] or m['received_at'], m['thread_key'], m['body_text'], json.dumps(m['attachments']), int(m['is_draft'])))
            addresses = {m['sender_email'], *(r['email'] for r in m['recipients'])} - {''}
            names = {m['sender_email']: m['sender_name']}
            names.update({r['email']: r['name'] for r in m['recipients'] if r['email']})
            for email in addresses:
                contact = contacts.setdefault(email, {'email': email, 'observed_names': set(), 'message_count': 0, 'first_seen': None, 'last_seen': None, 'crm_link_status': 'unconfirmed'})
                if names.get(email):
                    contact['observed_names'].add(names[email])
                contact['message_count'] += 1
                when = m['sent_at'] or m['received_at']
                if when:
                    contact['first_seen'] = min(contact['first_seen'] or when, when)
                    contact['last_seen'] = max(contact['last_seen'] or when, when)
            db.executemany('insert into participants values(?,?)', ((a, m['source_key']) for a in addresses))
            db.execute('insert into search values(?,?,?)', (m['source_key'], m['subject'], m['body_text']))
            total += 1
    with (OUT / 'contact_candidates.jsonl').open('w', encoding='utf-8') as destination:
        for email in sorted(contacts):
            record = contacts[email]
            record['observed_names'] = sorted(record['observed_names'])
            destination.write(json.dumps(record, ensure_ascii=False) + '\n')
    print(json.dumps({'indexed_messages': total, 'participant_addresses': db.execute('select count(distinct email) from participants').fetchone()[0]}))
    db.close()


def search(email, query, limit):
    db = sqlite3.connect(f'file:{(OUT / "history.sqlite").as_posix()}?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    email = email.strip().lower()
    # Quote tokens to avoid FTS query syntax errors from natural language.
    tokens = re.findall(r'\w+', query)[:30]
    match = ' OR '.join('"' + token + '"' for token in tokens)
    if match:
        sql = '''select m.*,bm25(search) score from search join messages m on m.id=search.id
          join participants p on p.message_id=m.id where p.email=? and search match ? and m.is_draft=0
          order by score,m.sent_at desc limit ?'''
        rows = db.execute(sql, (email, match, limit)).fetchall()
    else:
        rows = db.execute('''select m.* from messages m join participants p on p.message_id=m.id
          where p.email=? and m.is_draft=0 order by m.sent_at desc limit ?''', (email, limit)).fetchall()
    result = [dict(row) for row in rows]
    for m in result:
        m['attachments'] = json.loads(m['attachments'])
    print(json.dumps(result, ensure_ascii=False, indent=2))
    db.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['build', 'search'])
    parser.add_argument('--email')
    parser.add_argument('--query', default='')
    parser.add_argument('--limit', type=int, default=12)
    args = parser.parse_args()
    if args.action == 'build':
        build()
    elif args.email:
        search(args.email, args.query, max(1, min(args.limit, 100)))
    else:
        parser.error('--email is required for search')
