import { test, expect } from '@playwright/test';

test('quotation navigation starts with customer selection', async ({ page }) => {
  await page.route('**/api/auth', route => route.fulfill({ json: { configured: false, user: null } }));
  await page.goto('/');
  await page.getByRole('button', { name: /Open local dashboard preview/ }).click();
  await page.getByRole('button', { name: 'Quotations', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Quotations', exact: true })).toBeVisible();
  await expect(page.getByText('Select a customer to create or view quotations.')).toBeVisible();
  await expect(page.getByText('Customer database')).toHaveCount(0);
  await page.getByRole('button', { name: 'New quotation', exact: true }).first().click();
  await expect(page.getByRole('dialog', { name: 'Quotation editor' })).toBeVisible();
});

test('customer profile keeps history accessible without quotation buttons or tab row', async ({ page }) => {
  await page.route('**/api/auth', route => route.fulfill({ json: { configured: false, user: null } }));
  await page.goto('/');
  await page.getByRole('button', { name: /Open local dashboard preview/ }).click();
  await page.getByRole('button', { name: 'Customers', exact: true }).click();
  await page.getByRole('button', { name: 'View customer', exact: true }).first().click();
  await expect(page.getByText('Workspace', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New quotation', exact: true })).toHaveCount(0);
  await expect(page.locator('.crm-tabs')).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Customer records section' }).selectOption('sites');
  await expect(page.getByRole('heading', { name: 'Sites' })).toBeVisible();
});

test('customer quotation editor adds and removes rows and updates totals immediately', async ({ page }) => {
  await page.route('**/api/auth', route => route.fulfill({ json: { configured: false, user: null } }));
  await page.goto('/');
  await page.getByRole('button', { name: /Open local dashboard preview/ }).click();
  await page.getByRole('button', { name: 'Quotations', exact: true }).click();
  await page.getByRole('button', { name: 'New quotation', exact: true }).first().click();
  const editor = page.getByRole('dialog', { name: 'Quotation editor' });
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel('Quantity row 1')).toHaveAttribute('step', '1');
  await expect(editor.getByTitle('Live quotation PDF preview')).toHaveAttribute('src', /^blob:/);
  await editor.getByLabel('Product/Service row 1').fill('DCXBATT');
  await editor.getByLabel('Quantity row 1').fill('2');
  await editor.getByLabel('Quantity row 1').press('ArrowUp');
  await expect(editor.getByLabel('Quantity row 1')).toHaveValue('3');
  await editor.getByLabel('Quantity row 1').press('ArrowDown');
  await expect(editor.getByLabel('Quantity row 1')).toHaveValue('2');
  await editor.getByLabel('Unit price row 1').fill('12.50');
  await expect(editor.getByText('$28.25', { exact: true })).toBeVisible();
  await editor.getByRole('button', { name: 'Add row' }).click();
  await editor.getByLabel('Product/Service row 2').fill('DCXSHIP');
  await editor.getByLabel('Unit price row 2').fill('10.00');
  await expect(editor.getByText('$39.55', { exact: true })).toBeVisible();
  await expect(editor.locator('.quotation-preview-heading span')).toHaveText('1 page');
  await editor.getByRole('button', { name: 'Expand preview' }).click();
  await page.screenshot({ path: 'tmp/browser-results/quotation-editor.png' });
  await editor.getByRole('button', { name: 'Delete row 2' }).click();
  await expect(editor.getByText('$28.25', { exact: true })).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Save draft' })).toBeDisabled();
});
