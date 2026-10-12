import { test, expect, type Page } from '@playwright/test';

async function mockInbox(page: Page, posted: { url: string; body: unknown }[]) {
  let connected = true;
  await page.route('**/api/auth', route => route.fulfill({ json: { configured: true, user: { email: 'owner@example.com' } } }));
  await page.route('**/api/mail?*', route => {
    const action = new URL(route.request().url()).searchParams.get('action');
    const json = action === 'status' ? (connected ? { connected: true, provider: 'microsoft', mailbox: 'owner@outlook.com', inboxId: 'inbox' } : { connected: false, provider: 'microsoft' })
      : action === 'folders' ? { records: [{ id: 'inbox', displayName: 'Inbox', childFolderCount: 0, unreadItemCount: 0, totalItemCount: 0 }], next: null }
      : { records: [], next: null };
    return route.fulfill({ json });
  });
  await page.route('**/api/microsoft-oauth?*', route => {
    if (route.request().method() === 'POST') { posted.push({ url: route.request().url(), body: route.request().postDataJSON() }); connected = false; return route.fulfill({ json: { ok: true } }); }
    return route.fulfill({ json: { connections: connected ? [{ id: 'conn-1', email_address: 'owner@outlook.com', display_name: 'Owner', is_active: true }] : [] } });
  });
  await page.route('**/api/email-assistant**', route => route.fulfill({ json: { records: [], signature: null } }));
  await page.route('**/api/followups?*', route => route.fulfill({ json: { records: [], settings: null } }));
  await page.route('**/api/crm?*', route => route.fulfill({ json: { records: [], books: [], history: [] } }));
  await page.route('**/api/notifications?*', route => route.fulfill({ json: { records: [], unread: 0 } }));
  await page.route('**/api/tracking?*', route => route.fulfill({ json: { attention: 0, drafts: 0, waiting: 0, due: 0, recent: [] } }));
}

for (const [name, size] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 844 }]] as const) {
  test(`the mailbox can be disconnected from the inbox (${name})`, async ({ page }) => {
    await page.setViewportSize(size);
    const posted: { url: string; body: unknown }[] = [];
    await mockInbox(page, posted);
    await page.goto('/#inbox');
    await page.getByRole('button', { name: 'owner@outlook.com' }).click();
    await expect(page.getByRole('menuitem', { name: 'Connect another mailbox' })).toHaveAttribute('href', '/api/microsoft-oauth?action=start');
    await page.screenshot({ path: `tmp/browser-results/mail-account-menu-${name}.png` });
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('menuitem', { name: 'Disconnect this mailbox' }).click();
    await expect.poll(() => posted.length).toBe(1);
    expect(posted[0].url).toContain('action=disconnect');
    expect(posted[0].body).toEqual({ id: 'conn-1' });
    await expect(page.getByRole('link', { name: 'Connect Microsoft' })).toBeVisible();
  });
}
