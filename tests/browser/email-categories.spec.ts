import { test, expect } from '@playwright/test';

test('dashboard displays relationship/topic counts and filters the active correspondents',async({page})=>{
  const records=[
    {thread_id:'customer-thread',email:'des@example.com',company:'Acme',role:'qualified_company',topic:'pricing',subject:'Battery price',status:'draft_ready',occurred_at:'2026-10-04T10:00:00Z'},
    {thread_id:'staff-thread',email:'alex@dcx-tech.com',company:'',role:'staff',topic:'service',subject:'Site service',status:'needs_attention',occurred_at:'2026-10-04T11:00:00Z'},
  ];
  await page.route('**/api/**',route=>{
    const url=new URL(route.request().url()),action=url.searchParams.get('action');
    const json=url.pathname==='/api/auth'?{configured:true,user:{email:'owner@example.com'}}:
    url.pathname==='/api/mail'?{connected:true,provider:'microsoft',mailbox:'owner@example.com',inboxId:'inbox'}:
    action==='email-brain'?{categories:{records,roles:{staff:1,qualified_company:1},topics:{pricing:1,service:1},total:2},routes:[],requests:[],learning:[]}:
    {people:[],sampled:0,records:[],books:[],history:[],attention:0,drafts:0,waiting:0,due:0,recent:[],unread:0};
    return route.fulfill({json});
  });
  await page.goto('/#dashboard');
  const panel=page.locator('.email-brain-panel');
  await expect(panel.getByRole('button',{name:'staff (1)',exact:true})).toBeVisible();
  await expect(panel.getByRole('button',{name:'pricing (1)',exact:true})).toBeVisible();
  await panel.getByRole('button',{name:'staff (1)',exact:true}).click();
  await expect(panel.getByText('alex@dcx-tech.com',{exact:true})).toBeVisible();
  await expect(panel.getByRole('cell',{name:/des@example.com/})).toHaveCount(0);
  await expect(panel.getByLabel('Classify alex@dcx-tech.com')).toBeDisabled();
  await panel.getByRole('button',{name:'qualified company (1)',exact:true}).click();
  await expect(panel.getByRole('cell',{name:/des@example.com/})).toBeVisible();
  await panel.getByRole('button',{name:'pricing (1)',exact:true}).click();
  await expect(panel.getByRole('button',{name:'Battery price',exact:true})).toBeVisible();
  await page.screenshot({path:'tmp/browser-results/email-categories.png',fullPage:true});
});
