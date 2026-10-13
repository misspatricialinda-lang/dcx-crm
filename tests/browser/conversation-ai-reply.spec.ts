import { test, expect } from '@playwright/test';

test('inbox shows AI drafts above the email with tag, folder, chat, discard and restore', async ({ page }) => {
  const message = {
    id: 'message-1', internetMessageId:'<message-1@example.com>', conversationId: 'conversation-1', subject: 'UPS service', bodyPreview: 'Please confirm the next step.',
    from: { emailAddress: { address: 'customer@example.com', name: 'Customer' } },
    toRecipients: [{ emailAddress: { address: 'owner@example.com' } }], receivedDateTime: '2026-09-29T10:00:00Z',
    isRead: true, isDraft: false, importance: 'normal', hasAttachments: false, parentFolderId: 'inbox', changeKey: 'v1',
    body: { contentType: 'text', content: 'Please confirm the next step.' },
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
  let deleted = false;
  const posted: Record<string, unknown>[] = [];
  const thread = { id:'22222222-2222-4222-8222-222222222222', subject:'UPS service', status:'draft_ready', priority:'normal', last_message_at:'2026-10-04T10:00:00Z', customer_id:null, provider_thread_key:'conversation-1', sender:'customer@example.com', preview:'Please confirm the next step.' };
  const draft = () => ({ id:'11111111-1111-4111-8111-111111111111', thread_id:thread.id, current_body:'Thanks. Please share your availability.', original_ai_body:'Thanks. Please share your availability.', to_addresses:['customer@example.com'], status:'editing', updated_at:'2026-10-04T10:00:00Z', deleted_at:deleted?'2026-10-04T11:00:00Z':null });
  await page.route('**/api/email-assistant**', route => {
    const url = new URL(route.request().url()), action = url.searchParams.get('action'), trash = url.searchParams.get('trash') === 'true';
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON(); posted.push(body);
      if (body.action === 'delete') deleted = true;
      if (body.action === 'restore') deleted = false;
      if (body.action === 'assist') return route.fulfill({ json: { success: true, action: 'assist', kind: 'answer', answer: 'No price was given in earlier emails.' } });
      return route.fulfill({ json: { success: true, body_text: draft().current_body } });
    }
    const json = action === 'for-message' ? { draft: deleted ? null : draft() }
      : action === 'queue' ? { records: trash === deleted ? [{ ...thread, draft: draft() }] : [] }
      : action === 'location' ? { conversation: 'conversation-1', ai_draft: !deleted }
      : { thread, draft: draft(), messages: [{ id:'stored-message', sender:'customer@example.com', to_addresses:['owner@example.com'], cc_addresses:[], body_text:'Please confirm the next step.', body_html:'', body_loaded:true, has_attachments:false, direction:'incoming', occurred_at:'2026-10-04T10:00:00Z' }], attachments: [] };
    return route.fulfill({ json });
  });
  await page.route('**/api/crm?*', route => route.fulfill({ json: { records: [], books: [], history: [] } }));
  await page.route('**/api/notifications?*', route => route.fulfill({ json: { records: [], unread: 0 } }));
  await page.route('**/api/tracking?*', route => route.fulfill({ json: { attention: 0, drafts: 0, waiting: 0, due: 0, recent: [] } }));
  await page.goto('/#inbox');

  // One inbox: nothing opens by itself; the conversation is tagged and its draft sits above the email.
  await expect(page.getByRole('navigation', { name: 'Email views' })).toHaveCount(0);
  await expect(page.locator('.thread-item .ai-draft-tag')).toBeVisible();
  await expect(page.getByText('Select a conversation.')).toBeVisible();
  const reply = page.getByLabel('Edit AI reply draft');
  await expect(reply).toHaveCount(0);
  await page.locator('.thread-item').first().click();
  await expect(reply).toHaveValue('Thanks. Please share your availability.');
  expect(await page.locator('.conversation-content').evaluate(el => {
    const history = el.querySelector('.conversation-message'), composer = el.querySelector('.inline-ai-reply');
    return !!history && !!composer && !!(history.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_PRECEDING);
  })).toBe(true);

  // AI drafts folder lists only conversations with a waiting reply, each with a delete button.
  await page.getByRole('button', { name: /^AI drafts/ }).click();
  await expect(page.getByText('1 waiting for review')).toBeVisible();
  await expect(page.getByRole('button', { name: /and its AI draft/ })).toBeVisible();
  await page.locator('.thread-item').first().click();
  await expect(reply).toHaveValue('Thanks. Please share your availability.');
  await expect(page.getByRole('button', { name: 'Delete email' })).toBeVisible();

  // Questions about the customer are answered in the chat without changing the draft.
  await page.getByLabel('Ask AI or tell it what to change').fill('What did we quote him last time?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.locator('.chat-turn.assistant')).toHaveText('No price was given in earlier emails.');
  await expect(reply).toHaveValue('Thanks. Please share your availability.');

  // Cc and Bcc can be added to the AI reply.
  await page.locator('.inline-ai-to').getByRole('button', { name: 'Cc', exact: true }).click();
  await expect(page.getByLabel('Cc recipients')).toBeVisible();
  await page.screenshot({ path: 'tmp/inbox-inline-ai-draft.png', fullPage: true });
  await page.getByRole('button', { name: 'Shorter' }).click();
  await expect.poll(() => posted.some(item => item.action === 'rewrite' && item.instruction === 'Shorter')).toBe(true);

  // Discard removes the draft but keeps the email; the folder empties.
  await page.getByRole('button', { name: 'Discard draft' }).click();
  await expect(page.getByText('All caught up. No AI replies are waiting for review.')).toBeVisible();
  expect(posted.some(item => item.action === 'delete')).toBe(true);

  // Discarded drafts can be restored for review.
  await page.getByRole('button', { name: 'Discarded AI drafts' }).click();
  await page.getByRole('button', { name: 'Restore to AI drafts', exact: true }).click();
  await expect.poll(() => posted.some(item => item.action === 'restore')).toBe(true);

  // A manual reply opens above the conversation, like Outlook's reading pane.
  await page.locator('.mail-folders').getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.locator('.thread-item').first().click();
  await page.getByRole('button', { name: 'Reply', exact: true }).first().click();
  await expect(page.locator('.inline-mail-composer')).toBeVisible();
  expect(await page.locator('.conversation-content').evaluate(el => {
    const history = el.querySelector('.conversation-message'), editor = el.querySelector('.inline-mail-composer');
    return !!history && !!editor && !!(history.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_PRECEDING);
  })).toBe(true);
});
