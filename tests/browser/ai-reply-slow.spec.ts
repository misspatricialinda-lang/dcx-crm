import { test, expect } from '@playwright/test';

// A long conversation can take the AI past the server's time limit. The request then ends with a plain
// error page, but the AI still finishes and updates the draft: the reply panel must say "Draft updated".
test('a rewrite that outlasts the server time limit still shows the updated draft, not an error', async ({ page }) => {
  const message = {
    id: 'message-1', internetMessageId: '<message-1@example.com>', conversationId: 'conversation-1', subject: 'Price request', bodyPreview: 'Need 5 Eaton 93PX batteries.',
    from: { emailAddress: { address: 'customer@example.com', name: 'Customer' } },
    toRecipients: [{ emailAddress: { address: 'owner@example.com' } }], receivedDateTime: '2026-11-08T10:00:00Z',
    isRead: true, isDraft: false, importance: 'normal', hasAttachments: false, parentFolderId: 'inbox', changeKey: 'v1',
    body: { contentType: 'text', content: 'Need 5 Eaton 93PX batteries.' },
  };
  await page.route('**/api/auth', route => route.fulfill({ json: { configured: true, user: { email: 'owner@example.com' } } }));
  await page.route('**/api/mail?*', route => {
    const action = new URL(route.request().url()).searchParams.get('action');
    const json = action === 'status' ? { connected: true, provider: 'microsoft', mailbox: 'owner@example.com', inboxId: 'inbox' }
      : action === 'folders' ? { records: [{ id: 'inbox', displayName: 'Inbox', childFolderCount: 0, unreadItemCount: 0, totalItemCount: 1 }], next: null }
      : action === 'messages' || action === 'thread' ? { records: [message], next: null }
      : action === 'message' ? { record: message }
      : { records: [], next: null };
    return route.fulfill({ json });
  });
  const thread = { id: '22222222-2222-4222-8222-222222222222', subject: 'Price request', status: 'draft_ready', priority: 'normal', last_message_at: '2026-11-08T10:00:00Z', customer_id: null, provider_thread_key: 'conversation-1', sender: 'customer@example.com', preview: 'Need 5 Eaton 93PX batteries.' };
  let draft = { id: '11111111-1111-4111-8111-111111111111', thread_id: thread.id, current_body: 'Hi,\n\nOld draft with too many questions.\n\nThank you,', original_ai_body: 'x', to_addresses: ['customer@example.com'], status: 'editing', updated_at: '2026-11-08T10:00:00Z', deleted_at: null };
  await page.route('**/api/email-assistant**', route => {
    const action = new URL(route.request().url()).searchParams.get('action');
    if (route.request().method() === 'POST') {
      // The server gives up waiting; meanwhile the AI saves the rewritten draft.
      draft = { ...draft, current_body: 'Hi,\n\nThanks, I am checking with our supplier and will get back to you shortly.\n\nThank you,', updated_at: '2026-11-08T10:01:10Z' };
      return route.fulfill({ status: 504, contentType: 'text/plain', body: 'An error occurred with your deployment\n\nFUNCTION_INVOCATION_TIMEOUT' });
    }
    const json = action === 'signature' ? { signature: null }
      : action === 'for-message' ? { draft }
      : action === 'queue' ? { records: [{ ...thread, draft }] }
      : action === 'location' ? { conversation: 'conversation-1', ai_draft: true }
      : { thread, draft, messages: [], attachments: [] };
    return route.fulfill({ json });
  });
  await page.route('**/api/crm?*', route => route.fulfill({ json: { records: [], books: [], history: [] } }));
  await page.route('**/api/followups?*', route => route.fulfill({ json: { records: [], settings: null } }));
  await page.route('**/api/notifications?*', route => route.fulfill({ json: { records: [], unread: 0 } }));
  await page.route('**/api/tracking?*', route => route.fulfill({ json: { attention: 0, drafts: 0, waiting: 0, due: 0, recent: [] } }));
  await page.goto('/#inbox');
  await page.locator('.thread-item').first().click();

  const editor = page.getByRole('textbox', { name: 'Edit AI reply draft' });
  await expect(editor).toHaveValue(/too many questions/);
  await page.getByLabel('Ask AI or tell it what to change').fill('rewrite the email');
  await page.getByLabel('Ask AI or tell it what to change').press('Enter');
  await expect(page.getByText('Draft updated.').first()).toBeVisible({ timeout: 15000 });
  await expect(editor).toHaveValue(/checking with our supplier/);
  await expect(page.getByText(/not valid JSON|An error occurred/)).toHaveCount(0);
  await expect(page.getByText('That did not work')).toHaveCount(0);
});
