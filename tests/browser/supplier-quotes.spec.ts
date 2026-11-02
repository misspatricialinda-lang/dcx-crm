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
  await atlas.getByRole('button', { name: 'View' }).click();
  await expect(card.locator('.sq-reply')).toHaveText('Hi, CAD 48.50 each, in stock.');
  await card.locator('.sq-row', { hasText: 'Birch Batteries' }).getByRole('button', { name: 'Remind' }).click();
  await expect(card.getByLabel(/Reminder to Birch/)).toHaveValue(/DCX-RFQ-1001/);
  await card.getByRole('button', { name: 'Send reminder' }).click();
  expect(posted.at(-1)).toMatchObject({ action: 'rfq-nudge', id: 'r-' + suppliers[1].id });

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
