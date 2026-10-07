import { test, expect } from '@playwright/test';

// 1x1 PNG
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const pdf = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF';

test('email shows embedded pictures, working links and previews attachments', async ({ page }) => {
  const message = {
    id: 'message-1', internetMessageId: '<message-1@example.com>', conversationId: 'conversation-1', subject: 'Site photos', bodyPreview: 'See the photo.',
    from: { emailAddress: { address: 'customer@example.com', name: 'Customer' } },
    toRecipients: [{ emailAddress: { address: 'owner@example.com' } }], receivedDateTime: '2026-10-07T10:00:00Z',
    isRead: true, isDraft: false, importance: 'normal', hasAttachments: true, parentFolderId: 'inbox', changeKey: 'v1',
    body: { contentType: 'html', content: '<p>See the photo.</p><img src="cid:photo1@example" width="40" height="40"><p><a href="https://example.com/specs">Battery specs</a></p>' },
  };
  const attachments = [
    { id: 'att-photo', name: 'photo.png', size: 70, isInline: true, contentType: 'image/png', contentId: '<photo1@example>' },
    { id: 'att-pdf', name: 'quotation template for dcx.pdf', size: 101000, isInline: false, contentType: 'application/pdf', contentId: null },
  ];
  await page.route('**/api/auth', route => route.fulfill({ json: { configured: true, user: { email: 'owner@example.com' } } }));
  await page.route('**/api/mail?*', route => {
    const params = new URL(route.request().url()).searchParams, action = params.get('action');
    if (action === 'download') return route.fulfill(params.get('attachment') === 'att-photo' ? { body: Buffer.from(png, 'base64'), contentType: 'application/octet-stream' } : { body: pdf, contentType: 'application/octet-stream' });
    const json = action === 'status' ? { connected: true, provider: 'microsoft', mailbox: 'owner@example.com', inboxId: 'inbox' }
      : action === 'folders' ? { records: [{ id: 'inbox', displayName: 'Inbox', childFolderCount: 0, unreadItemCount: 0, totalItemCount: 1 }], next: null }
      : action === 'messages' || action === 'thread' ? { records: [message], next: null }
      : action === 'message' ? { record: message }
      : action === 'attachments' ? { records: attachments, next: null }
      : { records: [], next: null };
    return route.fulfill({ json });
  });
  await page.route('**/api/email-assistant**', route => route.fulfill({ json: { records: [], draft: null } }));
  await page.route('**/api/crm?*', route => route.fulfill({ json: { records: [], books: [], history: [] } }));
  await page.route('**/api/notifications?*', route => route.fulfill({ json: { records: [], unread: 0 } }));
  await page.route('**/api/tracking?*', route => route.fulfill({ json: { attention: 0, drafts: 0, waiting: 0, due: 0, recent: [] } }));
  await page.goto('/#inbox');

  await expect(page.getByText('External images and links are blocked')).toHaveCount(0);
  const body = page.frameLocator('.original-email-frame');
  await expect(body.locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect(body.getByRole('link', { name: 'Battery specs' })).toHaveAttribute('href', 'https://example.com/specs');
  // The embedded picture is shown in the email, not repeated as an attachment.
  await expect(page.locator('.attachment-list')).not.toContainText('photo.png');

  await page.getByRole('button', { name: /^quotation template for dcx\.pdf/ }).click();
  const preview = page.getByRole('dialog', { name: 'Preview quotation template for dcx.pdf' });
  await expect(preview).toBeVisible();
  await expect(preview.locator('iframe')).toHaveAttribute('src', /^blob:/);
  await expect(preview.getByRole('button', { name: 'Download' })).toBeVisible();
  await page.screenshot({ path: 'tmp/browser-results/mail-viewer-preview.png' });
  await preview.getByRole('button', { name: 'Close preview' }).click();
  await expect(preview).toBeHidden();
});
