import { test, expect } from '@playwright/test';
import ExcelJS from 'exceljs';

test('number cells can be cleared with Backspace and Quote #, PO # and Date reach the Excel export', async ({ page }) => {
  await page.route('**/api/auth', route => route.fulfill({ json: { configured: false, user: null } }));
  await page.goto('/'); await page.getByRole('button', { name: /Open local dashboard preview/ }).click();
  await page.getByRole('button', { name: 'Cost calculator', exact: true }).click();

  // A 0 can be erased while typing; leaving the cell empty puts 0 back.
  const cost = page.getByLabel(/supplier cost$/).first();
  await cost.fill('0');
  await cost.click(); await cost.press('End'); await cost.press('Backspace');
  await expect(cost).toHaveValue('');
  await cost.pressSequentially('25');
  await expect(cost).toHaveValue('25');
  await cost.fill(''); await cost.blur();
  await expect(cost).toHaveValue('0');
  await cost.fill('100');

  await expect(page.getByLabel('Currency', { exact: true })).toHaveValue('CAD');
  await page.getByLabel('Quote number').fill('DCX-7781');
  await page.getByLabel('PO number').fill('PO-55012');
  await page.getByLabel('Quote date').fill('2026-11-03');
  await page.getByLabel(/quantity$/).first().fill('2');

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download XLSX' }).click();
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(await (await download).path());
  const sheet = book.getWorksheet('Job Cost Sheet')!;
  expect(sheet.getCell('L2').value).toBe('DCX-7781');
  expect(sheet.getCell('L3').value).toBe('PO-55012');
  const date = sheet.getCell('L4').value as Date;
  expect([date.getFullYear(), date.getMonth() + 1, date.getDate()]).toEqual([2026, 11, 3]);
});
