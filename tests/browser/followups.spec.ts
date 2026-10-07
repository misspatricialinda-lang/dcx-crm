import { test, expect } from '@playwright/test';

test('follow-ups folder, conversation tag and the follow-up bar actions', async ({ page }) => {
  const message = (id: string, conversationId: string, subject: string) => ({
    id, internetMessageId: `<${id}@example.com>`, conversationId, subject, bodyPreview: 'Thanks for the quotation.',
    from: { emailAddress: { address: 'buyer@example.com', name: 'Buyer' } }, toRecipients: [{ emailAddress: { address: 'owner@example.com' } }],
    receivedDateTime: '2026-10-05T10:00:00Z', isRead: true, isDraft: false, importance: 'normal', hasAttachments: false, parentFolderId: 'inbox', changeKey: 'v1',
    body: { contentType: 'text', content: 'Please send a quotation.' },
  });
  const records = [message('m1', 'conv-due', 'Battery quote'), message('m2', 'conv-other', 'General question')];
  await page.route('**/api/auth', route => route.fulfill({ json: { configured: true, user: { email: 'owner@example.com' } } }));
  await page.route('**/api/mail?*', route => {
    const params = new URL(route.request().url()).searchParams, action = params.get('action');
    const json = action === 'status' ? { connected: true, provider: 'microsoft', mailbox: 'owner@example.com', inboxId: 'inbox' }
      : action === 'folders' ? { records: [{ id: 'inbox', displayName: 'Inbox', childFolderCount: 0, unreadItemCount: 0, totalItemCount: 2 }], next: null }
      : action === 'messages' ? { records, next: null }
      : action === 'thread' ? { records: records.filter(r => r.conversationId === params.get('conversationId')).length ? records.filter(r => r.conversationId === params.get('conversationId')) : records.slice(0, 1), next: null }
      : action === 'message' ? { record: records.find(r => r.id === params.get('id')) || records[0] }
      : { records: [], next: null };
    return route.fulfill({ json });
  });
  const followup = { thread_id: '33333333-3333-4333-8333-333333333333', provider_thread_key: 'conv-due', subject: 'Battery quote', followup_at: '2026-10-08T13:00:00Z', reason: 'quote', stage: 1, source: 'auto', notified_at: null, due: true, contact: 'buyer@example.com', last_sent_at: '2026-10-05T16:00:00Z' };
  let done = false; const posted: Record<string, unknown>[] = [];
  await page.route('**/api/followups**', route => {
    const action = new URL(route.request().url()).searchParams.get('action');
    if (route.request().method() === 'POST') { const body = route.request().postDataJSON(); posted.push({ action, ...body }); if (body.op === 'done') done = true; return route.fulfill({ json: action === 'run' ? { due: 0, drafted: 0, notified: 0 } : { success: true } }); }
    return route.fulfill({ json: { records: done ? [] : [followup], settings: { enabled: true, quote_days: [3, 7], question_days: [3, 7], lead_days: [7, 14] } } });
  });
  await page.route('**/api/email-assistant**', route => route.fulfill({ json: { records: [], draft: null } }));
  await page.route('**/api/crm?*', route => route.fulfill({ json: { records: [], books: [], history: [] } }));
  await page.route('**/api/notifications?*', route => route.fulfill({ json: { records: [], unread: 0 } }));
  await page.route('**/api/tracking?*', route => route.fulfill({ json: { attention: 0, drafts: 0, waiting: 0, due: 0, recent: [] } }));
  await page.goto('/#inbox');

  // The due conversation is tagged (the 9 AM check itself runs from n8n, not the browser).
  await expect(page.locator('.thread-item', { hasText: 'Battery quote' }).locator('.followup-tag')).toHaveText(/Follow up/);
  await expect(page.locator('.thread-item', { hasText: 'General question' }).locator('.followup-tag')).toHaveCount(0);
  expect(posted.some(p => p.action === 'run')).toBe(false);

  // Follow-ups folder lists it, and the conversation shows why and when.
  const folder = page.locator('.mail-folders').getByRole('button', { name: /Follow-ups/ });
  await expect(folder).toContainText('1');
  await folder.click();
  await expect(page.getByText('1 due · 0 upcoming')).toBeVisible();
  const bar = page.locator('.followup-bar');
  await expect(bar).toContainText('Follow-up due');
  await expect(bar).toContainText('Quotation sent, no reply yet');
  await page.getByRole('button', { name: 'Rules' }).click();
  await expect(page.getByRole('dialog', { name: 'Follow-up rules' }).getByLabel('Quotation sent')).toHaveValue('3, 7');
  await page.getByRole('dialog', { name: 'Follow-up rules' }).getByRole('button', { name: 'Cancel' }).click();
  await page.screenshot({ path: 'tmp/browser-results/followups-folder.png' });

  // Done clears it; any other conversation offers "Remind me".
  await bar.getByRole('button', { name: 'Done' }).click();
  await expect.poll(() => posted.some(p => p.op === 'done' && p.thread_id === followup.thread_id)).toBe(true);
  await expect(page.getByText('No follow-ups due.')).toBeVisible();
  await page.locator('.mail-folders').getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.locator('.thread-item', { hasText: 'General question' }).click();
  await page.getByLabel('Remind me to follow up').selectOption('Tomorrow');
  await expect.poll(() => posted.find(p => p.op === 'remind')?.provider_thread_key).toBe('conv-other');
  expect(posted.find(p => p.op === 'remind')).toMatchObject({ days: 1 }); // the server turns this into 9 AM Toronto
});
