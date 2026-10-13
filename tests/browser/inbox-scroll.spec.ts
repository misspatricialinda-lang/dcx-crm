import { test, expect } from '@playwright/test';

test('the conversation list and the open email scroll independently, the page does not', async ({ page }) => {
  const messages = [...Array(40)].map((_, i) => ({
    id: `m${i}`, internetMessageId: `<m${i}@example.com>`, conversationId: `c${i}`, subject: `Battery question ${i}`, bodyPreview: 'Please advise on batteries.',
    from: { emailAddress: { address: `customer${i}@example.com`, name: `Customer ${i}` } }, toRecipients: [{ emailAddress: { address: 'owner@example.com' } }],
    receivedDateTime: new Date(Date.UTC(2026, 9, 13, 12, 0) - i * 3600000).toISOString(), isRead: true, isDraft: false, importance: 'normal', hasAttachments: false, parentFolderId: 'inbox', changeKey: 'v1',
    body: { contentType: 'text', content: Array(120).fill('A long paragraph about UPS batteries.').join('\n') },
  }));
  await page.route('**/api/auth', route => route.fulfill({ json: { configured: true, user: { email: 'owner@example.com' } } }));
  await page.route('**/api/mail?*', route => {
    const url = new URL(route.request().url()), action = url.searchParams.get('action');
    const json = action === 'status' ? { connected: true, provider: 'microsoft', mailbox: 'owner@example.com', inboxId: 'inbox' }
      : action === 'folders' ? { records: [{ id: 'inbox', displayName: 'Inbox', childFolderCount: 0, unreadItemCount: 0, totalItemCount: 40 }], next: null }
      : action === 'messages' ? { records: messages, next: null }
      : action === 'thread' ? { records: messages.filter(m => m.conversationId === url.searchParams.get('conversation')), next: null }
      : action === 'message' ? { record: messages.find(m => m.id === url.searchParams.get('id')) }
      : { records: [], next: null };
    return route.fulfill({ json });
  });
  await page.route('**/api/email-assistant**', route => route.fulfill({ json: route.request().url().includes('queue') ? { records: [] } : { draft: null } }));
  await page.route('**/api/followups**', route => route.fulfill({ json: { records: [], settings: {} } }));
  await page.route('**/api/crm?*', route => route.fulfill({ json: { records: [] } }));
  await page.route('**/api/notifications?*', route => route.fulfill({ json: { records: [], unread: 0 } }));
  await page.route('**/api/tracking?*', route => route.fulfill({ json: {} }));
  await page.goto('/#inbox');
  await page.locator('.thread-item', { hasText: 'Battery question 0' }).click();
  await expect(page.locator('.reading-pane .pre-line').first()).toBeVisible();

  const list = page.locator('.thread-list'), pane = page.locator('.reading-pane');
  await list.hover();
  await page.mouse.wheel(0, 1500);
  await expect.poll(() => list.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  expect(await pane.evaluate(el => el.scrollTop)).toBe(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  await pane.hover();
  await page.mouse.wheel(0, 800);
  await expect.poll(() => pane.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({ path: 'tmp/inbox-scroll.png' });
});
