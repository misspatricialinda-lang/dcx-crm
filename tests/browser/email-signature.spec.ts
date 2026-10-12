import { test, expect } from '@playwright/test';

// The signature sits inside the reply, like Gmail, and edits apply to that one email only.
test('signature is editable inside the AI reply on a phone and the edited version is sent', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const message = {
    id: 'message-1', internetMessageId: '<message-1@example.com>', conversationId: 'conversation-1', subject: 'UPS service', bodyPreview: 'Please confirm the next step.',
    from: { emailAddress: { address: 'customer@example.com', name: 'Customer' } },
    toRecipients: [{ emailAddress: { address: 'owner@example.com' } }], receivedDateTime: '2026-09-29T10:00:00Z',
    isRead: true, isDraft: false, importance: 'normal', hasAttachments: false, parentFolderId: 'inbox', changeKey: 'v1',
    body: { contentType: 'text', content: 'Please confirm the next step.' },
  };
  const signature = {
    fields: { name: 'Raza Iqbal', title: 'Field Service Specialist' }, enabled: true, updated_at: '2026-10-07T10:00:00Z', updated_by: null, preview_html: '',
    body_html: '<p style="margin:0;font-size:22pt">Raza Iqbal</p><p style="margin:0;font-size:12pt">Field Service Specialist</p>',
    banner_src: 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==',
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
  const posted: Record<string, unknown>[] = [];
  const thread = { id: '22222222-2222-4222-8222-222222222222', subject: 'UPS service', status: 'draft_ready', priority: 'normal', last_message_at: '2026-10-04T10:00:00Z', customer_id: null, provider_thread_key: 'conversation-1', sender: 'customer@example.com', preview: 'Please confirm the next step.' };
  const draft = { id: '11111111-1111-4111-8111-111111111111', thread_id: thread.id, current_body: 'Thanks. Please share your availability.', original_ai_body: 'Thanks. Please share your availability.', to_addresses: ['customer@example.com'], status: 'editing', updated_at: '2026-10-04T10:00:00Z', deleted_at: null };
  await page.route('**/api/email-assistant**', route => {
    const action = new URL(route.request().url()).searchParams.get('action');
    if (route.request().method() === 'POST') { posted.push(route.request().postDataJSON()); return route.fulfill({ json: { success: true } }); }
    const json = action === 'signature' ? { signature }
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

  const canvas = page.locator('.inline-ai-reply .reply-canvas');
  const sig = canvas.getByRole('textbox', { name: 'Signature for this email' });
  await expect(sig).toContainText('Field Service Specialist');
  await expect(page.getByText('Signature added when sent')).toHaveCount(0);
  await sig.getByText('Field Service Specialist').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' (on site today)');
  await canvas.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'tmp/browser-results/signature-inline-phone.png' });

  await page.getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => posted.find(item => item.action === 'send')?.signature_html as string | undefined).toContain('Field Service Specialist (on site today)');
});
