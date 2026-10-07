import { test, expect } from '@playwright/test';

const daysAgo=(n:number)=>new Date(Date.now()-n*86400000).toISOString();
const torontoDay=(iso:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(iso));

test('email activity filters by chips, summary cards and date range',async({page})=>{
  const records=[
    {thread_id:'lead-thread',email:'des@example.com',company:'Acme',role:'lead',topic:'quotation',subject:'Battery price',preview:'Please quote 40 batteries for our Eaton 93PM.',status:'draft_ready',classification_state:'classified',occurred_at:daysAgo(1)},
    {thread_id:'staff-thread',email:'alex@dcx-tech.com',company:'',role:'employee',topic:'meeting',subject:'Site visit',status:'needs_attention',classification_state:'classified',occurred_at:daysAgo(3)},
    {thread_id:'old-thread',email:'old@example.com',company:'',role:null,topic:null,subject:'Old question',status:'needs_attention',classification_state:'needs_review',occurred_at:daysAgo(40)},
  ];
  await page.route('**/api/**',route=>{
    const url=new URL(route.request().url()),action=url.searchParams.get('action');
    const json=url.pathname==='/api/auth'?{configured:true,user:{email:'owner@example.com'}}:
    url.pathname==='/api/mail'?{connected:true,provider:'microsoft',mailbox:'owner@example.com',inboxId:'inbox'}:
    action==='email-brain'?{categories:{records,roles:{lead:1,employee:1},topics:{quotation:1,meeting:1},needs_review:1,total:3},routes:[],requests:[],learning:[]}:
    {people:[],sampled:0,records:[],books:[],history:[],attention:0,drafts:0,waiting:0,due:0,recent:[],unread:0};
    return route.fulfill({json});
  });
  await page.goto('/#dashboard');
  const panel=page.locator('.email-brain-panel');
  const relationship=panel.getByRole('group',{name:'Relationship'}),purpose=panel.getByRole('group',{name:'Purpose'});
  const listed=(email:string)=>panel.locator('tbody tr').filter({hasText:email});

  await expect(panel.getByText('Please quote 40 batteries for our Eaton 93PM.')).toBeVisible();
  await expect(relationship.getByRole('button',{name:'employee 1'})).toBeVisible();
  await expect(relationship.getByRole('button',{name:'Needs review 1'})).toBeVisible();

  // Relationship chip lists only that relationship; the purpose counts follow it.
  await relationship.getByRole('button',{name:'employee 1'}).click();
  await expect(listed('alex@dcx-tech.com')).toBeVisible();
  await expect(listed('des@example.com')).toHaveCount(0);
  await expect(panel.getByLabel('Classify alex@dcx-tech.com')).toBeDisabled();
  await expect(purpose.getByRole('button',{name:'quotation 0'})).toBeVisible();

  // Summary card switches to that category only, and All conversations returns everything.
  await panel.getByRole('button',{name:/Quotation requests/}).click();
  await expect(panel.getByRole('button',{name:/Quotation requests/})).toHaveAttribute('aria-pressed','true');
  await expect(listed('des@example.com')).toBeVisible();
  await expect(listed('alex@dcx-tech.com')).toHaveCount(0);
  await panel.getByRole('button',{name:'All conversations',exact:true}).click();
  await expect(panel.locator('tbody tr')).toHaveCount(3);

  // Preset period hides the 40-day-old conversation.
  await panel.getByRole('group',{name:'Activity period'}).getByRole('button',{name:'30 days'}).click();
  await expect(panel.locator('tbody tr')).toHaveCount(2);
  await expect(listed('old@example.com')).toHaveCount(0);

  // A single custom day shows only that day's conversation.
  const day=torontoDay(records[1].occurred_at);
  await panel.getByLabel('From date').fill(day);
  await panel.getByLabel('To date').fill(day);
  await expect(panel.locator('tbody tr')).toHaveCount(1);
  await expect(listed('alex@dcx-tech.com')).toBeVisible();

  await panel.getByRole('button',{name:'Clear all filters'}).click();
  await expect(panel.locator('tbody tr')).toHaveCount(3);
  await page.screenshot({path:'tmp/browser-results/email-categories.png',fullPage:true});
});
