// Sends an approved AI draft as an Outlook reply through Microsoft Graph, with the company
// signature and any attached files. Replaces n8n Workflow 3. The database claim makes the
// send happen at most once; anything that fails before Microsoft is asked to send releases
// the draft, and a failure during the send marks it uncertain so nobody resends blindly.
import { bannerAttachment, loadSignature, textToHtml } from './email-signature.js';

const checked = async query => { const { data, error } = await query; if (error) throw error; return data; };
const addresses = list => (list || []).map(item => String(item.emailAddress?.address || '').trim().toLowerCase()).filter(Boolean);

// Puts the reply and signature above the quoted original, inside the reply's own <body>.
export function placeAboveQuote(html, block) {
  const source = String(html || '');
  const body = source.match(/<body[^>]*>/i);
  if (!body) return `${block}${source}`;
  const at = body.index + body[0].length;
  return `${source.slice(0, at)}${block}${source.slice(at)}`;
}

export async function sendAiDraft({ db, graph, mailbox, draftId, updatedAt, attachments, actor }) {
  const claim = await checked(db.rpc('crm_claim_draft_send', { p_draft: draftId, p_updated_at: updatedAt, p_actor: actor, p_mailbox: mailbox }));
  if (!claim?.ok) return { status: 409, body: { error: claim?.reason || 'This draft cannot be sent.' } };
  const finish = (outcome, extra = {}) => checked(db.rpc('crm_finish_draft_send', { p_draft: draftId, p_outcome: outcome, p_provider_ref: extra.ref || null, p_body_html: extra.html || null, p_attachments: extra.files || [], p_actor: actor, p_error: extra.error || null }));

  let replyId, html, files = [];
  try {
    const signature = await loadSignature(db);
    const reply = await graph(`/messages/${encodeURIComponent(claim.reply_ref)}/createReply`, { method: 'POST', body: {} });
    replyId = reply.id;
    html = placeAboveQuote(reply.body?.content, `<div class="dcx-reply" style="font-family:Calibri,Arial,sans-serif;font-size:12pt">${textToHtml(claim.body)}</div>${signature ? `<br>${signature.html}` : ''}<br>`);
    await graph(`/messages/${encodeURIComponent(replyId)}`, { method: 'PATCH', body: { body: { contentType: 'HTML', content: html }, toRecipients: [{ emailAddress: { address: claim.to } }], ccRecipients: [], bccRecipients: [] } });
    for (const [index, file] of attachments.entries()) {
      await graph(`/messages/${encodeURIComponent(replyId)}/attachments`, { method: 'POST', body: { '@odata.type': '#microsoft.graph.fileAttachment', name: file.name, contentType: file.content_type || 'application/octet-stream', contentBytes: file.content_base64 } });
      files.push({ index, name: file.name, content_type: file.content_type || 'application/octet-stream', size_bytes: Math.floor(file.content_base64.replace(/=+$/, '').length * 3 / 4) });
    }
    const banner = signature && bannerAttachment(signature);
    if (banner) await graph(`/messages/${encodeURIComponent(replyId)}/attachments`, { method: 'POST', body: banner });
    const ready = await graph(`/messages/${encodeURIComponent(replyId)}?$select=id,isDraft,conversationId,toRecipients,ccRecipients,bccRecipients`);
    const to = addresses(ready.toRecipients);
    if (!ready.isDraft || to.length !== 1 || to[0] !== String(claim.to).toLowerCase() || addresses(ready.ccRecipients).length || addresses(ready.bccRecipients).length) throw new Error('Outlook prepared the reply with different recipients.');
    if (claim.conversation && ready.conversationId && ready.conversationId !== claim.conversation) throw new Error('Outlook prepared the reply in a different conversation.');
  } catch (error) {
    if (replyId) await graph(`/messages/${encodeURIComponent(replyId)}`, { method: 'DELETE' }).catch(() => {});
    await finish('released', { error: error.message });
    return { status: 409, body: { error: `No email was sent: ${error.message || 'Outlook could not prepare the reply.'} Your draft is preserved.` } };
  }

  try {
    await graph(`/messages/${encodeURIComponent(replyId)}/send`, { method: 'POST' });
  } catch (error) {
    await finish('uncertain', { ref: replyId, error: error.message }).catch(() => {});
    return { status: 502, body: { error: 'Outlook did not confirm the send. Check Sent Items before trying again; this draft is locked to prevent a duplicate.', send_outcome: 'uncertain' } };
  }
  try {
    const recorded = await finish('sent', { ref: replyId, html, files });
    return { status: 200, body: { success: true, action: 'send', status: 'waiting_customer', message_id: recorded?.message_id || null } };
  } catch {
    return { status: 200, body: { success: true, action: 'send', warning: 'Email sent, but the CRM record needs checking.' } };
  }
}
