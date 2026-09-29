import { test, expect } from '@playwright/test';

test('phone navigation and notification feed fit a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/auth', route => route.fulfill({ json: { configured: true, user: { email: 'owner@example.com' } } }));
  await page.route('**/api/notifications?*', route => {
    const action = new URL(route.request().url()).searchParams.get('action');
    return route.fulfill({ json: action === 'config' ? { available: false, publicKey: '' } : action === 'list' ? { unread: 1, records: [{ id: '123e4567-e89b-42d3-a456-426614174000', thread_id: '123e4567-e89b-42d3-a456-426614174001', sender: 'Raza <raza@example.com>', subject: 'Quotation details', preview: 'Please review the attached details.', occurred_at: '2026-09-27T12:00:00Z', read_at: null }] } : { ok: true } });
  });
  await page.route('**/api/crm?*', route => route.fulfill({ json: { records: [], books: [], history: [] } }));
  await page.route('**/api/mail?*', route => route.fulfill({ json: { configured: false } }));
  await page.route('**/api/tracking?*', route => route.fulfill({ json: { attention: 0, drafts: 0, waiting: 0, due: 0, recent: [] } }));
  await page.goto('/#notifications');
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  await expect(page.getByText('Quotation details')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toBeVisible();
  await expect(page.getByText('1 unread')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'tmp/notifications-mobile.png', fullPage: true });
  await page.getByRole('button', { name: /Mark all read/ }).click();
  await expect(page.getByText('All caught up')).toBeVisible();
  await page.getByRole('button', { name: /Raza.*Quotation details/ }).click();
  await expect(page.getByRole('navigation', { name: 'Email views' }).getByRole('button', { name: 'AI Draft Replies' })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('button', { name: 'More' }).click();
  await expect(page.getByRole('button', { name: 'Customers', exact: true })).toBeVisible();
});

test('main work areas stay within a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/auth', route => route.fulfill({ json: { configured: false, user: null } }));
  await page.goto('/');
  await page.getByRole('button', { name: /Open local dashboard preview/ }).click();
  for (const tab of ['Home', 'Inbox', 'Quotes', 'Alerts']) {
    await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('button', { name: tab }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth), tab).toBeLessThanOrEqual(390);
  }
  await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('button', { name: 'More' }).click();
  for (const tab of ['Customers', 'Calendar Agent', 'Cost calculator']) {
    await page.getByRole('button', { name: tab, exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth), tab).toBeLessThanOrEqual(390);
    await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('button', { name: 'More' }).click();
  }
});
