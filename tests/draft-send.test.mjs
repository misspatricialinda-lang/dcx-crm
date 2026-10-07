import test from 'node:test';
import assert from 'node:assert/strict';
import { placeAboveQuote, sendAiDraft } from '../server/draft-send.js';
import { insertSignature, signatureHtml } from '../server/email-signature.js';

const claim = { ok: true, draft_id: 'd1', thread_id: 't1', revision: 2, body: 'Hi Ali,\n\nThanks.\n\nThank you,', subject: 'quotation', to: 'customer@example.com', reply_ref: 'incoming-ref', conversation: 'conv-1' };
const signature = { fields: { name: 'Raza Iqbal' }, html: signatureHtml({ name: 'Raza Iqbal', title: 'Field Service Specialist' }), enabled: true, banner_base64: 'AAAA', banner_content_type: 'image/jpeg' };

function fakeDb({ claimed = claim } = {}) {
  const calls = [];
  return {
    calls,
    rpc: async (name, args) => { calls.push({ name, args }); return { data: name === 'crm_claim_draft_send' ? claimed : { ok: true, message_id: 'm1' }, error: null }; },
    from: () => ({ select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: signature, error: null }) }),
  };
}
function fakeGraph({ to = ['customer@example.com'], failSend = false } = {}) {
  const calls = [];
  const graph = async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET', body: options.body });
    if (path.endsWith('/createReply')) return { id: 'reply-1', body: { contentType: 'html', content: '<html><body><div id="divRplyFwdMsg">quoted original</div></body></html>' } };
    if (path.endsWith('/send')) { if (failSend) throw new Error('timeout'); return null; }
    if (path.includes('$select=')) return { id: 'reply-1', isDraft: true, conversationId: 'conv-1', toRecipients: to.map(address => ({ emailAddress: { address } })), ccRecipients: [], bccRecipients: [] };
    return {};
  };
  graph.calls = calls;
  return graph;
}
const send = (db, graph, attachments = []) => sendAiDraft({ db, graph, mailbox: 'owner@outlook.com', draftId: 'd1', updatedAt: '2026-10-07T10:00:00Z', attachments, actor: 'owner@example.com' });

test('AI draft is sent as an Outlook reply with signature, banner and files, then recorded', async () => {
  const db = fakeDb(), graph = fakeGraph();
  const result = await send(db, graph, [{ name: 'quote.pdf', content_type: 'application/pdf', content_base64: 'JVBERg==' }]);
  assert.equal(result.status, 200);
  const patch = graph.calls.find(call => call.method === 'PATCH');
  assert.match(patch.body.body.content, /Hi Ali,<br><br>|<p[^>]*>Hi Ali,<\/p>/);
  assert.ok(patch.body.body.content.indexOf('Raza Iqbal') < patch.body.body.content.indexOf('quoted original'), 'signature sits above the quoted email');
  assert.deepEqual(patch.body.toRecipients, [{ emailAddress: { address: 'customer@example.com' } }]);
  const uploads = graph.calls.filter(call => call.path.endsWith('/attachments') && call.method === 'POST');
  assert.deepEqual(uploads.map(call => call.body.name), ['quote.pdf', 'dcx-signature-banner.jpg']);
  assert.equal(uploads[1].body.isInline, true);
  assert.ok(graph.calls.some(call => call.path.endsWith('/send')));
  const finished = db.calls.find(call => call.name === 'crm_finish_draft_send');
  assert.equal(finished.args.p_outcome, 'sent');
  assert.equal(finished.args.p_attachments[0].name, 'quote.pdf');
});

test('a refused claim sends nothing', async () => {
  const graph = fakeGraph();
  const result = await send(fakeDb({ claimed: { ok: false, reason: 'This draft is already being sent or was sent. Check Outlook Sent Items.' } }), graph);
  assert.equal(result.status, 409);
  assert.match(result.body.error, /already being sent/);
  assert.equal(graph.calls.length, 0);
});

test('wrong recipients in Outlook release the draft and delete the prepared reply without sending', async () => {
  const db = fakeDb(), graph = fakeGraph({ to: ['someone-else@example.com'] });
  const result = await send(db, graph);
  assert.equal(result.status, 409);
  assert.ok(!graph.calls.some(call => call.path.endsWith('/send')));
  assert.ok(graph.calls.some(call => call.method === 'DELETE'));
  assert.equal(db.calls.at(-1).args.p_outcome, 'released');
});

test('a send Outlook does not confirm is marked uncertain, not released', async () => {
  const db = fakeDb(), graph = fakeGraph({ failSend: true });
  const result = await send(db, graph);
  assert.equal(result.status, 502);
  assert.equal(result.body.send_outcome, 'uncertain');
  assert.equal(db.calls.at(-1).args.p_outcome, 'uncertain');
});

test('signature is placed above quoted history and only once', () => {
  const html = '<html><body><p>Reply</p><div id="appendonsend"></div><hr><div id="divRplyFwdMsg">old</div></body></html>';
  const signed = insertSignature(html, signatureHtml({ name: 'Raza Iqbal' }));
  assert.ok(signed.indexOf('Raza Iqbal') < signed.indexOf('divRplyFwdMsg'));
  assert.equal(insertSignature(signed, signatureHtml({ name: 'Raza Iqbal' })), signed);
  assert.equal(placeAboveQuote('<body class="x"><p>q</p></body>', '<p>new</p>'), '<body class="x"><p>new</p><p>q</p></body>');
  assert.doesNotMatch(signatureHtml({ name: '<script>x</script>' }), /<script>/);
});
