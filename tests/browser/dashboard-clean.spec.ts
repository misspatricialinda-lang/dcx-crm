import { test, expect } from '@playwright/test';

test('dashboard has no email-activity or calculator-quote panels and no floating Calendar Agent', async ({ page }) => {
  await page.route('**/api/auth', route => route.fulfill({ json: { configured: true, user: { email: 'owner@example.com' } } }));
  await page.route('**/api/**', route => route.request().url().includes('/api/auth') ? route.fallback() : route.fulfill({ json: { records: [], books: [], history: [], unread: 0, attention: 0, drafts: 0, waiting: 0, due: 0, recent: [], configured: false } }));
  await page.goto('/');
  await expect(page.getByText('Earlier calculator quotes')).toHaveCount(0);
  await expect(page.getByText('Follow-ups due')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open Calendar Agent' })).toHaveCount(0);
  await page.screenshot({ path: 'tmp/browser-results/dashboard-clean.png', fullPage: true });
  // The Calendar Agent is still reachable from the menu.
  await page.getByRole('button', { name: 'Calendar Agent', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: /Calendar/ }).first()).toBeVisible();
});
