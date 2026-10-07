// Company email signature. Outlook adds signatures only in its own app, so emails sent through
// Microsoft Graph or n8n get this one appended at send time instead. The banner travels as an
// inline attachment referenced by cid, the same way Outlook embeds it.
export const SIGNATURE_CID = 'dcx-signature-banner';

export const signatureFields = ['name', 'title', 'direct_phone', 'email', 'support_label', 'support_phone', 'support_email'];

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const line = (content, style = 'font-size:12pt') => `<p style="margin:0;${style}">${content}</p>`;
const mail = address => `<a href="mailto:${escape(address)}" style="color:blue">${escape(address)}</a>`;

export function cleanSignatureFields(input) {
  if (!input || typeof input !== 'object') throw new Error('Signature details are missing.');
  const fields = {};
  for (const key of signatureFields) {
    const value = typeof input[key] === 'string' ? input[key].trim() : '';
    if (value.length > 200 || /[\r\n]/.test(value)) throw new Error('Each signature line must be one line under 200 characters.');
    fields[key] = value;
  }
  if (!fields.name) throw new Error('Enter the name for the signature.');
  for (const key of ['email', 'support_email']) if (fields[key] && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(fields[key])) throw new Error('Enter valid signature email addresses.');
  return fields;
}

// Mirrors Raza's Outlook signature: script-style blue name, 12pt details, then the DCX banner.
export function signatureHtml(fields, { banner = true, bannerSrc = `cid:${SIGNATURE_CID}` } = {}) {
  const f = fields || {};
  const rows = [
    line(escape(f.name), "font-size:22pt;font-family:'Brush Script MT',cursive;color:#00B0F0"),
    f.title && line(escape(f.title)),
    f.direct_phone && line(`D: ${escape(f.direct_phone)}`),
    f.email && line(`E: ${mail(f.email)}`),
    f.support_label && line(escape(f.support_label)),
    f.support_phone && line(escape(f.support_phone)),
    f.support_email && line(mail(f.support_email)),
    banner && line('&nbsp;') + `<p style="margin:0"><img src="${bannerSrc}" width="400" height="133" alt="DCX Critical Power Services" style="width:400px;height:133px;display:block"></p>`,
  ].filter(Boolean);
  return `<div class="dcx-signature" style="font-family:Calibri,Arial,sans-serif;color:#000">${rows.join('')}</div>`;
}

export function signatureText(fields) {
  const f = fields || {};
  return [f.name, f.title, f.direct_phone && `D: ${f.direct_phone}`, f.email && `E: ${f.email}`, f.support_label, f.support_phone, f.support_email].filter(Boolean).join('\n');
}

export function textToHtml(text) {
  return String(text || '').replace(/\r\n?/g, '\n').trim().split(/\n{2,}/).map(block => `<p style="margin:0 0 12pt">${escape(block).replace(/\n/g, '<br>')}</p>`).join('');
}

// Places the signature above quoted history, where Outlook puts it.
export function insertSignature(html, signature) {
  const source = String(html || '');
  if (source.includes('class="dcx-signature"')) return source;
  const marker = source.search(/<div[^>]*id="?(appendonsend|divRplyFwdMsg)"?|<hr[^>]*>\s*<div[^>]*id="?divRplyFwdMsg/i);
  if (marker >= 0) return `${source.slice(0, marker)}<br>${signature}${source.slice(marker)}`;
  const end = source.search(/<\/body>/i);
  if (end >= 0) return `${source.slice(0, end)}<br>${signature}${source.slice(end)}`;
  return `${source}<br>${signature}`;
}

export async function loadSignature(db) {
  const { data, error } = await db.from('crm_email_signature').select('fields,html,enabled,banner_base64,banner_content_type,updated_at,updated_by').eq('id', 1).maybeSingle();
  if (error) throw error;
  return data && data.enabled && data.html ? data : null;
}

export function bannerAttachment(signature) {
  if (!signature?.banner_base64) return null;
  return { '@odata.type': '#microsoft.graph.fileAttachment', name: 'dcx-signature-banner.jpg', contentType: signature.banner_content_type || 'image/jpeg', contentBytes: signature.banner_base64, contentId: SIGNATURE_CID, isInline: true };
}
