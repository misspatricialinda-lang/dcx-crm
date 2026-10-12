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
export function signatureRows(fields) {
  const f = fields || {};
  return [
    line(escape(f.name), "font-size:22pt;font-family:'Brush Script MT',cursive;color:#00B0F0"),
    f.title && line(escape(f.title)),
    f.direct_phone && line(`D: ${escape(f.direct_phone)}`),
    f.email && line(`E: ${mail(f.email)}`),
    f.support_label && line(escape(f.support_label)),
    f.support_phone && line(escape(f.support_phone)),
    f.support_email && line(mail(f.support_email)),
  ].filter(Boolean).join('');
}
const bannerHtml = src => line('&nbsp;') + `<p style="margin:0"><img src="${src}" width="400" height="133" alt="DCX Critical Power Services" style="width:400px;height:133px;display:block"></p>`;
const wrap = content => `<div class="dcx-signature" style="font-family:Calibri,Arial,sans-serif;color:#000">${content}</div>`;

export function signatureHtml(fields, { banner = true, bannerSrc = `cid:${SIGNATURE_CID}` } = {}) {
  return wrap(signatureRows(fields) + (banner ? bannerHtml(bannerSrc) : ''));
}

// The signature as edited inside one email. Only basic formatting and mailto/web links survive;
// everything else is dropped. Returns '' when the person cleared it, meaning "no signature".
const allowedTags = new Set(['p', 'div', 'br', 'span', 'a', 'b', 'strong', 'i', 'em', 'u']);
const attribute = (attrs, name) => { const match = attrs.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i')); return match ? (match[2] ?? match[3]) : ''; };
export function cleanSignatureMarkup(html) {
  const source = String(html || '').slice(0, 20000)
    .replace(/<(script|style|iframe|object|embed|svg|math|template|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const clean = source.replace(/<(\/?)([a-z][a-z0-9]*)\b([^>]*)>/gi, (_, close, name, attrs) => {
    const tag = name.toLowerCase();
    if (!allowedTags.has(tag)) return '';
    if (close) return tag === 'br' ? '' : `</${tag}>`;
    let kept = '';
    const css = attribute(attrs, 'style').replace(/&quot;/g, "'");
    if (css && !/url\s*\(|expression|javascript:|[<>\\]/i.test(css)) kept += ` style="${css.replace(/"/g, "'")}"`;
    const href = tag === 'a' ? attribute(attrs, 'href') : '';
    if (/^(mailto:|https?:\/\/)/i.test(href)) kept += ` href="${href.replace(/"/g, '%22')}"`;
    return `<${tag}${kept}>`;
  });
  return clean.replace(/<[^>]*>/g, '').replace(/&nbsp;|\s/g, '').length ? clean : '';
}
export function customSignatureHtml(markup, { banner = true } = {}) {
  const clean = cleanSignatureMarkup(markup);
  return clean ? wrap(clean + (banner ? bannerHtml(`cid:${SIGNATURE_CID}`) : '')) : '';
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
