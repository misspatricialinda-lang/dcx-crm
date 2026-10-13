export interface Recipient {
  emailAddress: { name?: string; address: string };
}
export interface MicrosoftMessage {
  id: string;
  conversationId: string;
  internetMessageId?: string;
  subject: string;
  bodyPreview: string;
  from?: Recipient;
  toRecipients: Recipient[];
  ccRecipients?: Recipient[];
  bccRecipients?: Recipient[];
  receivedDateTime: string;
  sentDateTime?: string;
  lastModifiedDateTime?: string;
  isRead: boolean;
  isDraft: boolean;
  importance: string;
  flag?: { flagStatus: 'notFlagged' | 'flagged' | 'complete' };
  hasAttachments: boolean;
  parentFolderId: string;
  webLink?: string;
  changeKey: string;
  body?: { contentType: string; content: string };
  uniqueBody?: { contentType: string; content: string };
}
export interface MicrosoftFolder {
  id: string;
  displayName: string;
  childFolderCount: number;
  unreadItemCount: number;
  totalItemCount: number;
  depth?: number;
}
export interface MailAttachment {
  id: string;
  name: string;
  size: number;
  isInline: boolean;
  contentType: string;
  contentId?: string | null;
}
export interface Page<T> {
  records: T[];
  next: string | null;
}
export async function mailRequest<T = any>(
  action: string,
  params: Record<string, string> = {},
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(
    `/api/mail?${new URLSearchParams({ action, ...params })}`,
    {
      credentials: "same-origin",
      signal,
      ...(body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    },
  );
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || "The mailbox request failed.");
  return data;
}
export const addressList = (list?: Recipient[]) =>
  (list || []).map((r) => r.emailAddress.address).join(", ");
export function outlookLink(value?: string) {
  try {
    const url = new URL(value || "");
    return url.protocol === "https:" &&
      [
        "outlook.office.com",
        "outlook.office365.com",
        "outlook.live.com",
      ].includes(url.hostname)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
export function mailTimestamp(
  message: Pick<
    MicrosoftMessage,
    "receivedDateTime" | "sentDateTime" | "lastModifiedDateTime"
  >,
) {
  for (const value of [
    message.receivedDateTime,
    message.sentDateTime,
    message.lastModifiedDateTime,
  ]) {
    const parsed = Date.parse(value || "");
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}
export function groupMicrosoftMessages(messages: MicrosoftMessage[]) {
  const map = new Map<string, MicrosoftMessage[]>();
  for (const m of messages) {
    const id = m.conversationId || m.id;
    const list = map.get(id) || [];
    if (!list.some((x) => x.id === m.id)) list.push(m);
    map.set(id, list);
  }
  return [...map]
    .map(([id, messages]) => {
      messages.sort(
        (a, b) =>
          mailTimestamp(a) - mailTimestamp(b) || a.id.localeCompare(b.id),
      );
      return { id, messages, latest: messages[messages.length - 1] };
    })
    .sort(
      (a, b) =>
        mailTimestamp(b.latest) - mailTimestamp(a.latest) ||
        a.id.localeCompare(b.id),
    );
}

// Attachments: any number of files, up to 25 MB per email in total (the Gmail and common provider limit).
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const DIRECT_LIMIT = 3 * 1024 * 1024; // Microsoft accepts smaller files in one request
const CHUNK_BYTES = 8 * 327680; // 2.5 MB chunks keep every request under the hosting body limit
export function attachmentLimitError(files: File[]) {
  const total = files.reduce((sum, file) => sum + file.size, 0);
  return total > MAX_TOTAL_ATTACHMENT_BYTES ? `Attachments total ${(total / 1048576).toFixed(1)} MB. The limit is 25 MB per email; remove a file or share large files with a link.` : '';
}
function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 16384) binary += String.fromCharCode(...bytes.subarray(start, start + 16384));
  return btoa(binary);
}
// Uploads one file into an Outlook draft (manual draft or prepared AI reply).
export async function uploadAttachment(messageId: string, file: File, onProgress?: (sent: number) => void) {
  const contentType = file.type || 'application/octet-stream';
  if (file.size < DIRECT_LIMIT) {
    const result = await mailRequest<{ version: string; hasAttachments: boolean }>('attach', {}, { id: messageId, name: file.name, contentType, contentBytes: bytesToBase64(new Uint8Array(await file.arrayBuffer())) });
    onProgress?.(file.size);
    return result;
  }
  const { upload } = await mailRequest<{ upload: string }>('upload-session', {}, { id: messageId, name: file.name, size: file.size, contentType });
  for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
    const chunk = new Uint8Array(await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
    await mailRequest('upload-chunk', {}, { upload, offset, contentBytes: bytesToBase64(chunk) });
    onProgress?.(Math.min(file.size, offset + chunk.length));
  }
  return null;
}
