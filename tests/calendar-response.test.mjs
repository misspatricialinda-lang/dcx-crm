import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseCalendarResponse } from '../server/calendar-response.js';

test('extracts chat text from n8n streaming records', () => {
  const stream = [
    { type: 'begin', metadata: { nodeName: 'Calendar Agent' } },
    { type: 'item', content: '', metadata: {} },
    { type: 'item', content: 'Hello', metadata: {} },
    { type: 'item', content: '! How can I help?', metadata: {} },
    { type: 'end' },
  ].map(item => JSON.stringify(item)).join('\n');
  assert.equal(parseCalendarResponse(stream), 'Hello! How can I help?');
});

test('also accepts the regular n8n JSON response', () => {
  assert.equal(parseCalendarResponse('[{"output":"Your meeting is at 2 pm."}]'), 'Your meeting is at 2 pm.');
});
