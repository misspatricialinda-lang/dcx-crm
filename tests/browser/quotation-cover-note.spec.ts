import { test, expect } from '@playwright/test';

test('a quotation made from the AI draft is attached as a PDF and the reply becomes a cover note', async ({ page }) => {
  const message = {
    id: 'message-1', internetMessageId: '<message-1@example.com>', conversationId: 'conversation-1', subject: 'Battery quote', bodyPreview: 'Please quote 40 batteries.',
    from: { emailAddress: { address: 'isha@thermo.example', name: 'Isha' } }, toRecipients: [{ emailAddress: { address: 'owner@example.com' } }], receivedDateTime: '2026-10-13T10:00:00Z',
    isRead: true, isDraft: false, importance: 'normal', hasAttachments: false, parentFolderId: 'inbox', changeKey: 'v1', body: { contentType: 'text', content: 'Please quote 40 batteries.' },
  };
  const customer = { id: '33333333-3333-4333-8333-333333333333', name: 'ThermoFisher Scientific', contact: 'Isha', email: 'isha@thermo.example', phone: '', notes: '', billing_address: '19 Allstate Parkway', price_book: 'standard', relationship_type: 'customer', updated_at: '2026-10-01T00:00:00Z' };
  const thread = { id: '22222222-2222-4222-8222-222222222222', subject: 'Battery quote', status: 'draft_ready', priority: 'normal', last_message_at: '2026-10-13T10:00:00Z', customer_id: customer.id, provider_thread_key: 'conversation-1', sender: 'isha@thermo.example', preview: 'Please quote 40 batteries.' };
  let body = 'Hi Isha,\n\nThanks for reaching out.\n\nThank you,';
  const draft = () => ({ id: '11111111-1111-4111-8111-111111111111', thread_id: thread.id, current_body: body, original_ai_body: 'x', to_addresses: ['isha@thermo.example'], status: 'editing', updated_at: '2026-10-13T10:00:00Z', deleted_at: null });
  const posted: Record<string, any>[] = [];
  await page.route('**/api/auth', route => route.fulfill({ json: { configured: true, user: { email: 'owner@example.com' } } }));
  await page.route('**/api/mail?*', route => {
    const action = new URL(route.request().url()).searchParams.get('action');
    return route.fulfill({ json: action === 'status' ? { connected: true, provider: 'microsoft', mailbox: 'owner@example.com', inboxId: 'inbox' }
      : action === 'folders' ? { records: [{ id: 'inbox', displayName: 'Inbox', childFolderCount: 0, unreadItemCount: 0, totalItemCount: 1 }], next: null }
      : action === 'messages' || action === 'thread' ? { records: [message], next: null } : action === 'message' ? { record: message } : { records: [], next: null } });
  });
  await page.route('**/api/email-assistant**', route => {
    const url = new URL(route.request().url()), action = url.searchParams.get('action');
    if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON(); posted.push(input);
      if (input.action === 'rewrite') body = 'Good Afternoon Isha,\n\nPlease see attached quote for 40 replacement batteries. Please provide PO so I can order batteries.\n\nKindly review and let me know if you have any questions or concerns.\n\nThank you,';
      return route.fulfill({ json: { success: true, body_text: body } });
    }
    return route.fulfill({ json: action === 'for-message' ? { draft: draft() } : action === 'queue' ? { records: [{ ...thread, draft: draft() }] } : action === 'signature' ? { signature: null } : { conversation: 'conversation-1', ai_draft: true } });
  });
  await page.route('**/api/crm?*', route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('action') === 'quotations' && route.request().method() === 'POST') {
      const input = route.request().postDataJSON();
      return route.fulfill({ status: 201, json: { record: { id: 'q1', customer_id: customer.id, estimate_number: 1042, recipient_snapshot: { name: customer.name, contact: 'Isha', email: customer.email, billing_address: customer.billing_address }, address_1: input.address_1, status: 'draft', version: 1, tax_rate: 13, subtotal: 1946, tax_total: 252.98, grand_total: 2198.98, created_at: '2026-10-13T10:00:00Z', items: input.items.map((item: any, position: number) => ({ ...item, id: `i${position}`, position, line_total: Number(item.quantity) * Number(item.unit_price) })) } } });
    }
    if (url.searchParams.get('action') === 'quotations') return route.fulfill({ json: { records: [] } });
    return route.fulfill({ json: { records: url.searchParams.get('entity') === 'customers' || !url.searchParams.get('action') ? [customer] : [], books: [], history: [] } });
  });
  await page.route('**/api/notifications?*', route => route.fulfill({ json: { records: [], unread: 0 } }));
  await page.route('**/api/followups**', route => route.fulfill({ json: { records: [], settings: {} } }));
  await page.route('**/api/tracking?*', route => route.fulfill({ json: {} }));

  await page.goto('/#customers');
  await expect(page.getByRole('heading', { name: 'ThermoFisher Scientific' })).toBeVisible();
  await page.goto('/#inbox');
  await page.locator('.thread-item').first().click();
  await expect(page.getByLabel('Edit AI reply draft')).toHaveValue(/Thanks for reaching out/);

  await page.getByLabel('Customer for saved quotation').selectOption(customer.id);
  await page.getByRole('button', { name: 'New quotation' }).click();
  const editor = page.getByRole('dialog', { name: 'Quotation editor' });
  await editor.getByLabel('Product/Service row 1').fill('Replacement battery 12V 9Ah');
  await editor.getByLabel('Quantity row 1').fill('40');
  await editor.getByLabel('Unit price row 1').fill('48.65');
  await editor.getByRole('button', { name: 'Save draft' }).click();

  await expect(page.locator('.inline-ai-file')).toContainText('DCX Technical Inc Quote 1042 - ThermoFisher Scientific.pdf');
  await expect.poll(() => posted.find(item => item.action === 'rewrite')?.instruction || '').toContain('Kindly review and let me know if you have any questions or concerns.');
  const instruction = posted.find(item => item.action === 'rewrite')!.instruction as string;
  expect(instruction).toContain('Do not write any prices');
  expect(instruction).not.toContain('48.65');
  await expect(page.getByLabel('Edit AI reply draft')).toHaveValue(/Please see attached quote/);
  await page.getByRole('button', { name: 'Undo rewrite' }).click();
  await expect(page.getByLabel('Edit AI reply draft')).toHaveValue(/Thanks for reaching out/);
});
