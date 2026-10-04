import { test, expect } from '@playwright/test';

async function preview(page:any){
  await page.route('**/api/auth',route=>route.fulfill({json:{configured:false,user:null}}));
  await page.goto('/');await page.getByRole('button',{name:/Open local dashboard preview/}).click();
}
test('quotation tax is editable and immediately recalculates the total',async({page})=>{
  await preview(page);await page.getByRole('button',{name:'Quotations',exact:true}).click();
  await page.getByRole('button',{name:'New quotation',exact:true}).first().click();
  const dialog=page.getByRole('dialog',{name:'Quotation editor'});
  await dialog.getByLabel('Product/Service row 1').fill('Battery');
  await dialog.getByLabel('Quantity row 1').fill('2');await dialog.getByLabel('Unit price row 1').fill('100');
  await expect(dialog.getByLabel('Quotation tax percent')).toHaveValue('13');
  await expect(dialog.getByText('$226.00',{exact:true})).toBeVisible();
  await dialog.getByLabel('Quotation tax percent').fill('5');
  await expect(dialog.getByText('$210.00',{exact:true})).toBeVisible();
});
test('customer deletion retains a recoverable customer record',async({page})=>{
  await preview(page);await page.getByRole('button',{name:'Customers',exact:true}).click();
  const card=page.locator('.crm-customer').first();const name=await card.locator('h2').textContent();
  page.on('dialog',dialog=>dialog.accept());await card.getByRole('button',{name:'Delete customer',exact:true}).click();
  await expect(page.locator('.crm-customer').filter({has:page.getByRole('heading',{name:name!,exact:true})})).toHaveCount(0);
  await page.getByRole('button',{name:'Deleted customers',exact:true}).click();
  const deleted=page.locator('.crm-customer').filter({has:page.getByRole('heading',{name:name!,exact:true})});
  await expect(deleted).toBeVisible();await deleted.getByRole('button',{name:'Restore',exact:true}).click();
  await page.getByRole('button',{name:'Active customers',exact:true}).click();
  await expect(page.getByRole('heading',{name:name!,exact:true})).toBeVisible();
});
test('calculator can create and delete a named pricing agreement',async({page})=>{
  await preview(page);await page.getByRole('button',{name:'Cost calculator',exact:true}).click();
  await page.getByLabel('New pricing agreement name').fill('Acme 2026');
  await page.getByRole('button',{name:'Save as new agreement',exact:true}).click();
  await expect(page.getByRole('button',{name:'Delete Acme 2026',exact:true})).toBeVisible();
  page.on('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Delete Acme 2026',exact:true}).click();
  await expect(page.getByRole('button',{name:'Delete Acme 2026',exact:true})).toHaveCount(0);
});
