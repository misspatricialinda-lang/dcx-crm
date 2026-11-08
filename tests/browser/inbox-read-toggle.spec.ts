import { test, expect } from '@playwright/test';

test('each email row has a read/unread button that bolds and unbolds it, and there is no Refresh button', async ({ page }) => {
  const messages = [0, 1].map(i => ({
    id: `m${i}`, internetMessageId: `<m${i}@example.com>`, conversationId: `c${i}`, subject: `Price request ${i}`, bodyPreview: 'Please give me a price.',
    from: { emailAddress: { address: `customer${i}@example.com`, name: `Customer ${i}` } }, toRecipients: [{ emailAddress: { address: 'owner@example.com' } }],
    receivedDateTime: new Date(Date.UTC(2026, 10, 8, 12, 0) - i * 3600000).toISOString(), isRead: i === 1, isDraft: false, importance: 'normal', hasAttachments: false, parentFolderId: 'inbox', changeKey: 'v1',
    body: { contentType: 'text', content: 'Please give me a price.' },
  }));
  const reads: any[] = [];
  await page.route('**/api/auth', route => route.fulfill({ json: { configured: true, user: { email: 'owner@example.com' } } }));
  await page.route('**/api/mail?*', route => {
    const url = new URL(route.request().url()), action = url.searchParams.get('action');
    if (action === 'read') { reads.push(route.request().postDataJSON()); return route.fulfill({ json: { success: true } }); }
    const json = action === 'status' ? { connected: true, provider: 'microsoft', mailbox: 'owner@example.com', inboxId: 'inbox' }
      : action === 'folders' ? { records: [{ id: 'inbox', displayName: 'Inbox', childFolderCount: 0, unreadItemCount: 1, totalItemCount: 2 }], next: null }
      : action === 'messages' ? { records: messages, next: null }
      : { records: [], next: null };
    return route.fulfill({ json });
  });
  await page.route('**/api/email-assistant**', route => route.fulfill({ json: route.request().url().includes('queue') ? { records: [] } : { draft: null } }));
  await page.route('**/api/followups**', route => route.fulfill({ json: { records: [], settings: {} } }));
  await page.route('**/api/crm?*', route => route.fulfill({ json: { records: [] } }));
  await page.route('**/api/notifications?*', route => route.fulfill({ json: { records: [], unread: 0 } }));
  await page.route('**/api/tracking?*', route => route.fulfill({ json: {} }));
  await page.goto('/#inbox');

  const fresh = page.locator('.thread-item', { hasText: 'Price request 0' });
  const old = page.locator('.thread-item', { hasText: 'Price request 1' });
  await expect(fresh).toHaveClass(/unread/);
  await expect(old).not.toHaveClass(/unread/);
  await expect(page.locator('.outlook-ribbon').getByRole('button', { name: 'Refresh' })).toHaveCount(0);
  await page.screenshot({ path: 'tmp/browser-results/inbox-read-toggle.png' });

  await page.getByRole('button', { name: 'Mark Price request 0 as read' }).click();
  await expect(fresh).not.toHaveClass(/unread/);
  await expect.poll(() => reads.at(-1)).toMatchObject({ id: 'm0', isRead: true });

  await page.getByRole('button', { name: 'Mark Price request 1 as unread' }).click();
  await expect(old).toHaveClass(/unread/);
  await expect.poll(() => reads.at(-1)).toMatchObject({ id: 'm1', isRead: false });
});
