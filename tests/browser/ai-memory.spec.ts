import { test, expect } from '@playwright/test';

const rules = [
  { id: '11111111-1111-4111-8111-111111111111', rule: 'Do not mention historical prices in replies; say we are checking current pricing and availability with our supplier instead.', active: true, source: 'chat', source_thread_id: '22222222-2222-4222-8222-222222222222', created_by: 'owner@example.com', created_at: '2026-11-08T10:00:00Z', updated_at: '2026-11-08T10:00:00Z', updated_by: null },
  { id: '33333333-3333-4333-8333-333333333333', rule: 'Keep replies short and non-technical unless the customer asks for details.', active: true, source: 'learn', source_thread_id: null, created_by: 'owner@example.com', created_at: '2026-11-01T10:00:00Z', updated_at: '2026-11-03T10:00:00Z', updated_by: 'owner@example.com' },
  { id: '44444444-4444-4444-8444-444444444444', rule: 'Offer a phone call when a customer reports an alarm.', active: false, scope: 'supplier', source: 'setup', source_thread_id: null, created_by: 'owner@example.com', created_at: '2026-10-25T10:00:00Z', updated_at: '2026-10-26T10:00:00Z', updated_by: 'owner@example.com' },
];

test('hidden AI memory page lists, edits, switches off and deletes rules', async ({ page }) => {
  const posts: any[] = [];
  await page.route('**/api/auth', route => route.fulfill({ json: { configured: true, user: { email: 'owner@example.com' } } }));
  await page.route('**/api/**', async route => {
    const url = route.request().url();
    if (url.includes('/api/auth')) return route.fallback();
    if (url.includes('/api/email-assistant') && route.request().method() === 'POST') { posts.push(route.request().postDataJSON()); return route.fulfill({ json: { success: true } }); }
    if (url.includes('action=rules')) return route.fulfill({ json: { rules } });
    return route.fulfill({ json: { records: [], books: [], history: [], unread: 0, attention: 0, drafts: 0, waiting: 0, due: 0, recent: [], configured: false } });
  });
  await page.goto('/#ai-memory');
  await expect(page.getByRole('heading', { name: 'AI memory' })).toBeVisible();
  // Not in the menu.
  await expect(page.getByRole('navigation').getByText('AI memory')).toHaveCount(0);
  await expect(page.getByText('Do not mention historical prices', { exact: false })).toBeVisible();
  await page.screenshot({ path: 'tmp/browser-results/ai-memory-desktop.png', fullPage: true });

  await expect(page.locator('.ai-memory-scope.supplier')).toHaveCount(1);
  await page.getByRole('tab', { name: /Supplier/ }).click();
  await expect(page.locator('.ai-memory-list li')).toHaveCount(1);
  await page.getByRole('tab', { name: /Everywhere/ }).click();
  await page.getByRole('tab', { name: /Off/ }).click();
  await expect(page.locator('.ai-memory-list li')).toHaveCount(1);
  await page.getByRole('tab', { name: /All/ }).click();

  const second = page.locator('.ai-memory-list li').nth(1);
  await second.getByRole('button', { name: 'Edit' }).click();
  await second.getByLabel('Edit rule').fill('Keep replies short.');
  await second.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => posts.at(-1)).toMatchObject({ action: 'rule-update', id: rules[1].id, rule: 'Keep replies short.' });

  await page.locator('.ai-memory-list li').first().getByRole('switch').click();
  await expect.poll(() => posts.at(-1)).toMatchObject({ action: 'rule-update', id: rules[0].id, active: false });

  await page.locator('.ai-memory-list li').nth(2).getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Yes, delete' }).click();
  await expect.poll(() => posts.at(-1)).toMatchObject({ action: 'rule-delete', id: rules[2].id });

  await page.getByLabel('Teach the AI a new rule').fill('Never promise delivery dates before the supplier confirms.');
  await page.getByRole('button', { name: 'Add rule' }).click();
  await expect.poll(() => posts.at(-1)).toMatchObject({ action: 'learn', rule: 'Never promise delivery dates before the supplier confirms.', scope: 'customer' });
  await page.getByText('Price requests to suppliers', { exact: true }).click();
  await page.getByLabel('Teach the AI a new rule').fill('Ask suppliers in one line.');
  await page.getByRole('button', { name: 'Add rule' }).click();
  await expect.poll(() => posts.at(-1)).toMatchObject({ action: 'learn', rule: 'Ask suppliers in one line.', scope: 'supplier' });

  // The AI memory button on a supplier draft opens the page on Supplier rules.
  await page.goto('/#ai-memory/supplier');
  await expect(page.getByRole('tab', { name: /Supplier/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.ai-memory-list li')).toHaveCount(1);
  await page.getByRole('button', { name: 'How AI memory works' }).click();
  await expect(page.getByRole('dialog', { name: 'How AI memory works' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'AI memory' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'tmp/browser-results/ai-memory-phone.png', fullPage: true });
});
