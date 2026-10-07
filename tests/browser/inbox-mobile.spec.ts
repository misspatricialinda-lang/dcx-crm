import { test, expect } from '@playwright/test';

// A short Gmail message that carries pasted page layout: fixed-height boxes and a scroll area.
const pastedLayout = '<div style="height:438px;overflow-y:scroll"><div style="min-width:502px;width:1097px">hey there, I need a battery for my apartment.</div></div><div style="height:566px"></div>';

test('phone inbox shows the list, then the conversation with a back button, and short emails stay short', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const message = {
    id: 'message-1', internetMessageId: '<message-1@example.com>', conversationId: 'conversation-1', subject: 'quotation', bodyPreview: 'hey there, I need a battery for my apartment.',
    from: { emailAddress: { address: 'customer@example.com', name: 'Customer' } },
    toRecipients: [{ emailAddress: { address: 'owner@example.com' } }], receivedDateTime: '2026-10-07T10:00:00Z',
    isRead: true, isDraft: false, importance: 'normal', hasAttachments: false, parentFolderId: 'inbox', changeKey: 'v1',
    body: { contentType: 'html', content: pastedLayout },
  };
  await page.route('**/api/auth', route => route.fulfill({ json: { configured: true, user: { email: 'owner@example.com' } } }));
  await page.route('**/api/mail?*', route => {
    const action = new URL(route.request().url()).searchParams.get('action');
    const json = action === 'status' ? { connected: true, provider: 'microsoft', mailbox: 'owner@example.com', inboxId: 'inbox' }
      : action === 'folders' ? { records: [{ id: 'inbox', displayName: 'Inbox', childFolderCount: 0, unreadItemCount: 0, totalItemCount: 1 }, { id: 'sentitems', displayName: 'Sent Items', childFolderCount: 0, unreadItemCount: 0, totalItemCount: 0 }], next: null }
      : action === 'messages' || action === 'thread' ? { records: [message], next: null }
      : action === 'message' ? { record: message }
      : { records: [], next: null };
    return route.fulfill({ json });
  });
  await page.route('**/api/email-assistant**', route => route.fulfill({ json: { records: [], draft: null } }));
  await page.route('**/api/crm?*', route => route.fulfill({ json: { records: [], books: [], history: [] } }));
  await page.route('**/api/notifications?*', route => route.fulfill({ json: { records: [], unread: 0 } }));
  await page.route('**/api/tracking?*', route => route.fulfill({ json: { attention: 0, drafts: 0, waiting: 0, due: 0, recent: [] } }));
  await page.goto('/#inbox');

  // List first: folders as one scrollable row, no reading pane.
  const folders = page.locator('.mail-folders');
  await expect(folders.getByRole('button', { name: /^AI drafts/ })).toBeVisible();
  const box = await folders.boundingBox();
  expect(box!.height).toBeLessThan(70);
  await expect(page.locator('.reading-pane')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'tmp/browser-results/inbox-mobile-list.png' });

  // Tapping a conversation shows it full width with a way back.
  await page.locator('.thread-item').first().click();
  await expect(page.locator('.thread-list')).toBeHidden();
  await expect(page.getByRole('heading', { name: 'quotation' })).toBeVisible();
  const frame = page.locator('.original-email-frame');
  await expect.poll(async () => (await frame.boundingBox())?.height || 999).toBeLessThan(160);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'tmp/browser-results/inbox-mobile-reading.png', fullPage: true });
  await page.locator('.phone-back').click();
  await expect(page.locator('.thread-list')).toBeVisible();
  await expect(page.locator('.reading-pane')).toBeHidden();
});
