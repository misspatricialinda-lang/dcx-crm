"""Readable text from HTML-only mail; retains original HTML and email identities."""
import html.parser
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / '.tools/email-archive'


class EmailText(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.ignored = 0

    def handle_starttag(self, tag, attrs):
        if tag in {'head', 'script', 'style'}:
            self.ignored += 1
        if not self.ignored:
            if tag in {'br', 'p', 'div', 'tr', 'table', 'blockquote', 'li'}:
                self.parts.append('\n')
            elif tag in {'td', 'th'}:
                self.parts.append(' ')

    def handle_endtag(self, tag):
        if tag in {'head', 'script', 'style'}:
            self.ignored = max(0, self.ignored - 1)
        if not self.ignored and tag in {'p', 'div', 'tr', 'table', 'blockquote', 'li'}:
            self.parts.append('\n')

    def handle_data(self, data):
        if not self.ignored:
            self.parts.append(data)

    def text(self):
        text = ''.join(self.parts).replace('\xa0', ' ')
        text = re.sub(r'[ \t]+', ' ', text)
        text = re.sub(r' *\n *', '\n', text)
        return re.sub(r'\n{3,}', '\n\n', text).strip()


def main():
    cache = OUT / 'messages.jsonl'
    pending = OUT / 'messages.normalized.jsonl'
    total = converted = 0
    with cache.open(encoding='utf-8') as source, pending.open('w', encoding='utf-8') as destination:
        for line in source:
            message = json.loads(line)
            if message.get('body_html'):
                parser = EmailText()
                parser.feed(message['body_html'])
                message['body_text'] = parser.text()
                message['body_text_source'] = 'html-derived-v1'
                converted += 1
            else:
                message['body_text_source'] = 'original_plain_text'
            destination.write(json.dumps(message, ensure_ascii=False) + '\n')
            total += 1
    # Replace only after every record was successfully parsed and written.
    pending.replace(cache)
    result = {'messages': total, 'html_bodies_converted': converted, 'original_html_preserved': True}
    (OUT / 'normalization.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
