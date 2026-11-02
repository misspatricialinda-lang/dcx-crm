import { test, expect } from '@playwright/test';

test('supplier quotes: write emails, send, and see who replied with their price', async ({ page }) => {
  const suppliers = [
    { id: '11111111-1111-4111-8111-111111111111', name: 'Atlas Power (demo)', contact: '', email: 'atlas@supplier.example' },
    { id: '22222222-2222-4222-8222-222222222222', name: 'Birch Batteries (demo)', contact: '', email: 'birch@supplier.example' },
    { id: '33333333-3333-4333-8333-333333333333', name: 'Cedar UPS (demo)', contact: '', email: 'cedar@supplier.example' },
  ];
  const recipient = (s: typeof suppliers[number], extra: Record<string, unknown>) => ({
    id: 'r-' + s.id, rfq_id: 'rfq-1', supplier_name: s.name, supplier_email: s.email, subject: 'Price request: 4 × 12V 9Ah UPS batteries [DCX-RFQ-1001]',
    body: 'Hello,\n\nCould you send your best price?\n\nOur reference: DCX-RFQ-1001\n\nThank you,', status: 'draft', sent_at: null, replied_at: null, last_reply_at: null,
    supplier_thread_id: null, reply_text: '', price: '', lead_time: '', reply_notes: '', reply_read_at: null, nudge_count: 0, last_nudged_at: null, error: null, updated_at: '2026-11-02T14:00:00Z', ...extra,
  });
  const rfq = { id: 'rfq-1', number: 1001, reference: 'DCX-RFQ-1001', thread_id: '44444444-4444-4444-8444-444444444444', customer_label: 'Acme Hospital (buyer@customer.example)', title: '4 × 12V 9Ah UPS batteries', request_text: '', status: 'draft', created_at: '2026-11-02T14:00:00Z', recipients: [] as ReturnType<typeof recipient>[] };
  let stage: 'empty' | 'draft' | 'sent' = 'empty';
  const posted: Record<string, unknown>[] = [];
  await page.route('**/api/auth', route => route.fulfill({ json: { configured: true, user: { email: 'owner@example.com' } } }));
  await page.route('**/api/email-assistant**', route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON(); posted.push(body);
      if (body.action === 'rfq-create') stage = 'draft';
      if (body.action === 'rfq-send') stage = 'sent';
      return route.fulfill({ json: { success: true } });
    }
    if (new URL(route.request().url()).searchParams.get('action') === 'rfq-thread') return route.fulfill({ json: { messages: [
      { id: 'request', direction: 'outgoing', sender: '', subject: 'Price request', occurred_at: '2026-11-02T14:05:00Z', text: 'Hello,\n\nCould you send your best price?' },
      { id: 'm2', direction: 'incoming', sender: 'atlas@supplier.example', subject: 'RE: Price request', occurred_at: '2026-11-02T18:30:00Z', text: 'Hi, CAD 48.50 each, in stock.' },
    ], can_reply: true } });
    const rows = stage === 'empty' ? [] : [{ ...rfq, status: stage === 'sent' ? 'open' : 'draft', recipients: stage === 'draft' ? suppliers.map(s => recipient(s, {})) : [
      recipient(suppliers[0], { status: 'replied', sent_at: '2026-11-02T14:05:00Z', replied_at: '2026-11-02T18:30:00Z', supplier_thread_id: '55555555-5555-4555-8555-555555555555', reply_read_at: '2026-11-02T18:31:00Z', price: 'CAD 48.50 each', lead_time: 'In stock, 2 days', reply_text: 'Hi, CAD 48.50 each, in stock.' }),
      recipient(suppliers[1], { status: 'sent', sent_at: '2026-11-02T14:05:00Z' }),
      recipient(suppliers[2], { status: 'sent', sent_at: '2026-11-02T14:05:00Z' }),
    ] }];
    return route.fulfill({ json: { suppliers, rfqs: rows } });
  });
  await page.route('**/api/crm?*', route => route.fulfill({ json: { records: [], books: [], history: [] } }));
  await page.route('**/api/notifications?*', route => route.fulfill({ json: { records: [], unread: 0 } }));
  await page.route('**/api/tracking?*', route => route.fulfill({ json: { attention: 0, drafts: 0, waiting: 0, due: 0, recent: [] } }));
  await page.goto('/#suppliers');

  await expect(page.getByRole('heading', { name: 'Supplier quotes' })).toBeVisible();
  await page.getByRole('button', { name: 'New request' }).click();
  await page.getByLabel('What do you need priced?').fill('4 × 12V 9Ah batteries for an APC SRT3000');
  await page.getByRole('checkbox', { name: /Cedar UPS/ }).uncheck();
  await page.getByRole('checkbox', { name: /Cedar UPS/ }).check();
  await page.getByRole('button', { name: 'Write 3 emails' }).click();
  expect(posted.at(-1)).toMatchObject({ action: 'rfq-create', supplier_ids: suppliers.map(s => s.id), request: '4 × 12V 9Ah batteries for an APC SRT3000' });

  // One editable email per supplier, then a single Send for all of them.
  const card = page.locator('.sq-card', { hasText: 'DCX-RFQ-1001' });
  await expect(card.locator('.sq-draft')).toHaveCount(3);
  const atlasDraft = card.locator('.sq-draft', { hasText: 'Atlas Power (demo)' });
  await atlasDraft.locator('summary').click();
  await expect(atlasDraft.getByLabel('Subject')).toHaveValue(/DCX-RFQ-1001/);
  await card.getByRole('button', { name: 'Send to 3 suppliers' }).click();
  expect(posted.at(-1)).toMatchObject({ action: 'rfq-send', rfq_id: 'rfq-1' });

  // Status board: who replied, when, at what price; the others are waiting and can be reminded.
  await expect(card.locator('.sq-card-status .pill')).toHaveText('1 of 3 replied');
  const atlas = card.locator('.sq-row', { hasText: 'Atlas Power' });
  await expect(atlas).toContainText('CAD 48.50 each');
  await expect(atlas).toContainText('In stock, 2 days');
  await expect(card.locator('.sq-row', { hasText: 'Birch Batteries' })).toContainText('Waiting');
  // The whole email chain with Atlas, and a reply that stays in that conversation.
  await atlas.getByRole('button', { name: 'Open' }).click();
  const chain = card.getByLabel('Emails with Atlas Power (demo)');
  await expect(chain.locator('.sq-msg.outgoing')).toContainText('Could you send your best price?');
  await expect(chain.locator('.sq-msg.incoming')).toContainText('CAD 48.50 each');
  await card.getByLabel('Reply to Atlas Power (demo)').fill('Thanks. Is shipping included?');
  await card.getByRole('button', { name: 'Send reply' }).click();
  expect(posted.at(-1)).toMatchObject({ action: 'rfq-reply', id: 'r-' + suppliers[0].id, body: 'Thanks. Is shipping included?' });
  await atlas.getByRole('button', { name: 'Hide' }).click();
  await expect(card.getByRole('button', { name: "Open customer's email" })).toBeVisible();
  await card.locator('.sq-row', { hasText: 'Birch Batteries' }).getByRole('button', { name: 'Remind' }).click();
  await expect(card.getByLabel(/Reminder to Birch/)).toHaveValue(/DCX-RFQ-1001/);
  await card.getByRole('button', { name: 'Send reminder' }).click();
  expect(posted.at(-1)).toMatchObject({ action: 'rfq-nudge', id: 'r-' + suppliers[1].id });

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('supplier email in the inbox: Supplier tag, link to its request, no AI reply box', async ({ page }) => {
  const message = (id: string, conversationId: string, from: string, subject: string) => ({
    id, internetMessageId: `<${id}@example.com>`, conversationId, subject, bodyPreview: 'I think the price is 100 dollars.',
    from: { emailAddress: { address: from, name: from } }, toRecipients: [{ emailAddress: { address: 'owner@example.com' } }],
    receivedDateTime: '2026-11-02T10:00:00Z', isRead: true, isDraft: false, importance: 'normal', hasAttachments: false, parentFolderId: 'inbox', changeKey: 'v1',
    body: { contentType: 'text', content: 'I think the price is 100 dollars.' },
  });
  const records = [message('m1', 'conv-supplier', 'atlas@supplier.example', 'RE: Price request [DCX-RFQ-1001]'), message('m2', 'conv-customer', 'buyer@customer.example', 'Battery quote')];
  await page.route('**/api/auth', route => route.fulfill({ json: { configured: true, user: { email: 'owner@example.com' } } }));
  await page.route('**/api/mail?*', route => {
    const params = new URL(route.request().url()).searchParams, action = params.get('action');
    const json = action === 'status' ? { connected: true, provider: 'microsoft', mailbox: 'owner@example.com', inboxId: 'inbox' }
      : action === 'folders' ? { records: [{ id: 'inbox', displayName: 'Inbox', childFolderCount: 0, unreadItemCount: 0, totalItemCount: 2 }], next: null }
      : action === 'messages' ? { records, next: null }
      : action === 'thread' ? { records: records.filter(r => r.conversationId === params.get('conversationId')), next: null }
      : action === 'message' ? { record: records.find(r => r.id === params.get('id')) || records[0] }
      : { records: [], next: null };
    return route.fulfill({ json });
  });
  await page.route('**/api/email-assistant**', route => {
    const action = new URL(route.request().url()).searchParams.get('action');
    if (action === 'rfq-links') return route.fulfill({ json: { suppliers: [{ name: 'Atlas Power (demo)', email: 'atlas@supplier.example' }], conversations: { 'conv-supplier': { rfq_id: 'rfq-1', reference: 'DCX-RFQ-1001', title: '8 × 12V 9Ah batteries', customer_label: 'buyer@customer.example', customer_thread_id: '44444444-4444-4444-8444-444444444444', supplier_name: 'Atlas Power (demo)' } } } });
    return route.fulfill({ json: { records: [], draft: null } });
  });
  await page.route('**/api/followups**', route => route.fulfill({ json: { records: [], settings: { enabled: true, quote_days: [3, 7], question_days: [3, 7], lead_days: [7, 14] } } }));
  await page.route('**/api/crm?*', route => route.fulfill({ json: { records: [], books: [], history: [] } }));
  await page.route('**/api/notifications?*', route => route.fulfill({ json: { records: [], unread: 0 } }));
  await page.route('**/api/tracking?*', route => route.fulfill({ json: { attention: 0, drafts: 0, waiting: 0, due: 0, recent: [] } }));
  await page.goto('/#inbox');

  await expect(page.locator('.thread-item', { hasText: 'DCX-RFQ-1001' }).locator('.supplier-tag')).toHaveText(/Supplier/);
  await expect(page.locator('.thread-item', { hasText: 'Battery quote' }).locator('.supplier-tag')).toHaveCount(0);

  await page.locator('.thread-item', { hasText: 'DCX-RFQ-1001' }).click();
  const banner = page.locator('.supplier-banner');
  await expect(banner).toContainText('Supplier email · Atlas Power (demo)');
  await expect(banner).toContainText('DCX-RFQ-1001 · 8 × 12V 9Ah batteries · for buyer@customer.example');
  await expect(page.getByRole('button', { name: 'Ask suppliers' })).toHaveCount(0);
  await expect(page.locator('.inline-ai-reply, .ai-reply-panel')).toHaveCount(0);
  await banner.getByRole('button', { name: 'Open in Supplier quotes' }).click();
  await expect(page).toHaveURL(/#suppliers/);
});
