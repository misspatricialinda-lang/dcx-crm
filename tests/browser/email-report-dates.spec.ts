import {test,expect} from '@playwright/test';
test('email performance accepts a specific day and inclusive custom range',async({page})=>{
  const requests:URL[]=[];
  await page.route('**/api/**',route=>{
    const url=new URL(route.request().url());
    const json=url.pathname==='/api/auth'?{configured:true,user:{email:'owner@example.com'}}:
      url.pathname==='/api/mail'?{connected:true,provider:'microsoft',mailbox:'owner@example.com',inboxId:'inbox'}:
      url.pathname==='/api/tracking'&&url.searchParams.get('action')==='report'?(requests.push(url),{report:{received:2,sent:1,conversations_replied:1,conversations_received:2,reply_rate:50}}):{people:[],sampled:0,records:[],books:[],history:[],roles:[],topics:[],routes:[],requests:[],examples:[],recent:[],unread:0};
    return route.fulfill({json});
  });
  await page.goto('/');
  const selector=page.getByLabel('Email reporting period');await expect(selector).toBeVisible();
  await selector.selectOption('day');await page.getByLabel('Reporting date').fill('2026-10-03');
  await expect.poll(()=>requests.at(-1)?.searchParams.get('from')).toBe('2026-10-03');
  expect(requests.at(-1)?.searchParams.get('through')).toBe('2026-10-03');
  await selector.selectOption('custom');await page.getByLabel('Report from date').fill('2026-10-01');await page.getByLabel('Report through date').fill('2026-10-03');
  await expect.poll(()=>requests.at(-1)?.searchParams.get('from')).toBe('2026-10-01');
  expect(requests.at(-1)?.searchParams.get('through')).toBe('2026-10-03');
  await expect(page.getByText('50%',{exact:true})).toBeVisible();
  await page.screenshot({path:'tmp/browser-results/custom-report-dates.png',fullPage:true});
});
