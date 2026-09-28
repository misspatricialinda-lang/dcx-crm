import { test, expect } from '@playwright/test';

test('new chat clears visible history and rotates calendar session', async ({ page }) => {
  const sessions: string[] = [];
  await page.route('**/api/auth', route => route.fulfill({ json: { configured: true, user: { email: 'owner@example.com' } } }));
  await page.route('**/api/mail?*', route => route.fulfill({ json: { configured: false, provider: 'microsoft' } }));
  await page.route('**/api/crm?*', route => route.fulfill({ json: { records: [], books: [], history: [] } }));
  await page.route('**/api/calendar-agent', async route => {
    const body = route.request().postDataJSON();
    sessions.push(body.sessionId);
    await route.fulfill({ json: { answer: `Reply ${sessions.length}` } });
  });
  await page.goto('/#calendar-agent');
  const input = page.getByRole('textbox', { name: 'Message Calendar Agent' });
  await input.fill('First question');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('Reply 1')).toBeVisible();
  await page.getByRole('button', { name: 'New chat' }).click();
  await expect(page.getByText('Reply 1')).toHaveCount(0);
  await expect(page.getByText('First question')).toHaveCount(0);
  await input.fill('Second question');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('Reply 2')).toBeVisible();
  expect(sessions[0]).not.toBe(sessions[1]);
});
