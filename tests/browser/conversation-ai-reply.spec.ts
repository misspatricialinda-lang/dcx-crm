import { test, expect } from '@playwright/test';

test('AI reply opens an editable draft in the selected conversation', async ({ page }) => {
  const message = {
    id: 'message-1', conversationId: 'conversation-1', subject: 'UPS service', bodyPreview: 'Please confirm the next step.',
    from: { emailAddress: { address: 'customer@example.com', name: 'Customer' } },
    toRecipients: [{ emailAddress: { address: 'owner@example.com' } }], receivedDateTime: '2026-09-29T10:00:00Z',
    isRead: true, isDraft: false, importance: 'normal', hasAttachments: true, parentFolderId: 'inbox', changeKey: 'v1',
    body: { contentType: 'text', content: 'Please confirm the next step.' },
  };
  await page.route('**/api/auth', route => route.fulfill({ json: { configured: true, user: { email: 'owner@example.com' } } }));
  await page.route('**/api/mail?*', route => {
    const action = new URL(route.request().url()).searchParams.get('action');
    const json = action === 'status' ? { connected: true, provider: 'microsoft', mailbox: 'owner@example.com', inboxId: 'inbox' }
      : action === 'folders' ? { records: [{ id: 'inbox', displayName: 'Inbox', childFolderCount: 0, unreadItemCount: 0, totalItemCount: 1 }], next: null }
      : action === 'messages' || action === 'thread' ? { records: [message], next: null }
      : action === 'attachments' ? { records: [], next: null }
      : { records: [], next: null };
    return route.fulfill({ json });
  });
  await page.route('**/api/conversation-ai', route => route.fulfill({ json: {
    analysis: { summary: 'The customer wants the next step for UPS service.', customer_request: 'Confirm next step.', next_steps: ['Arrange a site review'], reply_needed: true, draft_reply: 'Thanks for your email. We can arrange a site review. Please share your availability.', uncertainties: [] },
    attachments: [{ name: 'scope.pdf', status: 'read' }, { name: 'archive.zip', status: 'unsupported' }], truncated: false, message_count: 1, knowledge_sources: [], reply_to_message_id: 'message-1',
  } }));
  await page.route('**/api/crm?*', route => route.fulfill({ json: { records: [], books: [], history: [] } }));
  await page.route('**/api/notifications?*', route => route.fulfill({ json: { records: [], unread: 0 } }));
  await page.route('**/api/tracking?*', route => route.fulfill({ json: { attention: 0, drafts: 0, waiting: 0, due: 0, recent: [] } }));
  await page.goto('/#inbox');
  await page.getByRole('button', { name: 'Analyze conversation' }).click();
  await expect(page.getByRole('heading', { name: 'Suggested reply' })).toBeVisible();
  await expect(page.getByText('1 of 2 attached files included in analysis')).toBeVisible();
  await page.getByRole('button', { name: 'Reply with AI draft' }).click();
  const editor = page.getByRole('textbox', { name: 'Email reply content' });
  await expect(editor).toContainText('We can arrange a site review');
  await expect(page.locator('.mail-recipient-chip')).toContainText('customer@example.com');
  await editor.fill('Thanks. Please send your availability.');
  await expect(editor).toContainText('Please send your availability.');
});
