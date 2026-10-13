// Sends an approved AI draft as an Outlook reply through Microsoft Graph, with the company
// signature and any attached files. Replaces n8n Workflow 3. The database claim makes the
// send happen at most once; anything that fails before Microsoft is asked to send releases
// the draft, and a failure during the send marks it uncertain so nobody resends blindly.
import { bannerAttachment, customSignatureHtml, loadSignature, textToHtml } from './email-signature.js';

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

// signatureHtml: the signature as edited in this email ('' for none); undefined uses the saved one.
// stagedReplyId: an Outlook reply prepared earlier (prepareAiReply) that already holds uploaded files.
// cc / bcc: extra recipients the owner added; the main recipient is always the original sender.
export async function sendAiDraft({ db, graph, mailbox, draftId, updatedAt, attachments = [], actor, signatureHtml, stagedReplyId, cc = [], bcc = [] }) {
  const claim = await checked(db.rpc('crm_claim_draft_send', { p_draft: draftId, p_updated_at: updatedAt, p_actor: actor, p_mailbox: mailbox }));
  if (!claim?.ok) return { status: 409, body: { error: claim?.reason || 'This draft cannot be sent.' } };
  const finish = (outcome, extra = {}) => checked(db.rpc('crm_finish_draft_send', { p_draft: draftId, p_outcome: outcome, p_provider_ref: extra.ref || null, p_body_html: extra.html || null, p_attachments: extra.files || [], p_actor: actor, p_error: extra.error || null }));

  let replyId, html, files = [];
  try {
    const saved = await loadSignature(db);
    const signatureBlock = saved && (typeof signatureHtml === 'string' ? customSignatureHtml(signatureHtml, { banner: !!saved.banner_base64 }) : saved.html);
    const signature = signatureBlock ? { ...saved, html: signatureBlock } : null;
    let reply;
    if (stagedReplyId) {
      reply = await graph(`/messages/${encodeURIComponent(stagedReplyId)}?$select=id,isDraft,conversationId,body`);
      if (!reply?.isDraft) throw new Error('The prepared reply is no longer a draft.');
    } else reply = await graph(`/messages/${encodeURIComponent(claim.reply_ref)}/createReply`, { method: 'POST', body: {} });
    replyId = reply.id;
    html = placeAboveQuote(reply.body?.content, `<div class="dcx-reply" style="font-family:Calibri,Arial,sans-serif;font-size:12pt">${textToHtml(claim.body)}</div>${signature ? `<br>${signature.html}` : ''}<br>`);
    await graph(`/messages/${encodeURIComponent(replyId)}`, { method: 'PATCH', body: { body: { contentType: 'HTML', content: html }, toRecipients: [{ emailAddress: { address: claim.to } }], ccRecipients: cc.map(address => ({ emailAddress: { address } })), bccRecipients: bcc.map(address => ({ emailAddress: { address } })) } });
    for (const [index, file] of attachments.entries()) {
      await graph(`/messages/${encodeURIComponent(replyId)}/attachments`, { method: 'POST', body: { '@odata.type': '#microsoft.graph.fileAttachment', name: file.name, contentType: file.content_type || 'application/octet-stream', contentBytes: file.content_base64 } });
      files.push({ index, name: file.name, content_type: file.content_type || 'application/octet-stream', size_bytes: Math.floor(file.content_base64.replace(/=+$/, '').length * 3 / 4) });
    }
    if (stagedReplyId) {
      const uploaded = await graph(`/messages/${encodeURIComponent(replyId)}/attachments?$select=id,name,contentType,size,isInline&$top=200`);
      for (const [index, file] of (uploaded?.value || []).filter(item => !item.isInline).entries()) files.push({ index: attachments.length + index, name: file.name, content_type: file.contentType || 'application/octet-stream', size_bytes: file.size || 0 });
    }
    const banner = signature && bannerAttachment(signature);
    if (banner) await graph(`/messages/${encodeURIComponent(replyId)}/attachments`, { method: 'POST', body: banner });
    const ready = await graph(`/messages/${encodeURIComponent(replyId)}?$select=id,isDraft,conversationId,toRecipients,ccRecipients,bccRecipients`);
    const to = addresses(ready.toRecipients);
    const same = (actual, wanted) => actual.length === wanted.length && wanted.every(address => actual.includes(address.toLowerCase()));
    if (!ready.isDraft || to.length !== 1 || to[0] !== String(claim.to).toLowerCase() || !same(addresses(ready.ccRecipients), cc) || !same(addresses(ready.bccRecipients), bcc)) throw new Error('Outlook prepared the reply with different recipients.');
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
    if (recorded?.message_id && cc.length) await db.from('email_messages').update({ cc_addresses: cc }).eq('id', recorded.message_id);
    return { status: 200, body: { success: true, action: 'send', status: 'waiting_customer', message_id: recorded?.message_id || null } };
  } catch {
    return { status: 200, body: { success: true, action: 'send', warning: 'Email sent, but the CRM record needs checking.' } };
  }
}

// Creates the Outlook reply for an AI draft before sending, so large files can be uploaded into it
// in chunks. Nothing is sent; sendAiDraft later fills in the text and sends this same reply.
export async function prepareAiReply({ db, graph, draftId, threadId }) {
  const draft = await checked(db.from('email_drafts').select('id,thread_id,status,deleted_at,reply_to_message_id').eq('id', draftId).eq('thread_id', threadId).maybeSingle());
  if (!draft || draft.deleted_at || !['editing', 'approved'].includes(draft.status)) return { status: 409, body: { error: 'The AI draft is no longer ready for review.' } };
  const source = draft.reply_to_message_id && await checked(db.from('email_messages').select('provider_ref,direction').eq('id', draft.reply_to_message_id).maybeSingle());
  if (!source?.provider_ref || source.direction !== 'incoming') return { status: 409, body: { error: 'The email this replies to is no longer in Outlook.' } };
  const reply = await graph(`/messages/${encodeURIComponent(source.provider_ref)}/createReply`, { method: 'POST', body: {} });
  return { status: 200, body: { reply_id: reply.id } };
}
export async function discardPreparedReply({ graph, replyId }) {
  const reply = await graph(`/messages/${encodeURIComponent(replyId)}?$select=id,isDraft`).catch(() => null);
  if (reply?.isDraft) await graph(`/messages/${encodeURIComponent(replyId)}`, { method: 'DELETE' });
  return { status: 200, body: { success: true } };
}
