import { test, expect } from '@playwright/test';

test('inbox displays saved AI drafts and supports delete and restore without deleting the email', async ({ page }) => {
  const message = {
    id: 'message-1', internetMessageId:'<message-1@example.com>', conversationId: 'conversation-1', subject: 'UPS service', bodyPreview: 'Please confirm the next step.',
    from: { emailAddress: { address: 'customer@example.com', name: 'Customer' } },
    toRecipients: [{ emailAddress: { address: 'owner@example.com' } }], receivedDateTime: '2026-09-29T10:00:00Z',
    isRead: true, isDraft: false, importance: 'normal', hasAttachments: true, parentFolderId: 'inbox', changeKey: 'v1',
    body: { contentType: 'text', content: 'Please confirm the next step.' },
  };
  await page.route('**/api/auth', route => route.fulfill({ json: { configured: true, user: { email: 'owner@example.com' } } }));
  await page.route('**/api/mail?*', route => {
    const action = new URL(route.request().url()).searchParams.get('action');
    const json = action === 'status' ? { connected: true, provider: 'microsoft', mailbox: 'owner@example.com', inboxId: 'inbox' }
      : action === 'folders' ? { records: [{ id: 'inbox', displayName: 'Inbox', childFolderCount: 0, unreadItemCount: 0, totalItemCount: 1 }], next: null }
      : action === 'messages' || action === 'thread' ? { records: [message], next: null }
      : action === 'attachments' ? { records: [], next: null }
      : { records: [], next: null };
    return route.fulfill({ json });
  });
  let deleted=false;
  const thread={id:'22222222-2222-4222-8222-222222222222',subject:'UPS service',status:'draft_ready',priority:'normal',last_message_at:'2026-10-04T10:00:00Z',customer_id:null};
  const draft=()=>({id:'11111111-1111-4111-8111-111111111111',thread_id:thread.id,current_body:'Thanks. Please share your availability.',original_ai_body:'Thanks. Please share your availability.',to_addresses:['customer@example.com'],status:'editing',updated_at:'2026-10-04T10:00:00Z',deleted_at:deleted?'2026-10-04T11:00:00Z':null});
  await page.route('**/api/email-assistant**',route=>{
    const action=new URL(route.request().url()).searchParams.get('action');
    if(route.request().method()==='POST'){deleted=route.request().postDataJSON().action==='delete';return route.fulfill({json:{success:true}});}
    return route.fulfill({json:action==='for-message'?{draft:deleted?null:draft()}:action==='queue'?{records:[{...thread,draft:draft()}]}:{thread,draft:draft(),messages:[{id:'stored-message',sender:'customer@example.com',to_addresses:['owner@example.com'],cc_addresses:[],body_text:'Please confirm the next step.',body_html:'',body_loaded:true,has_attachments:false,direction:'incoming',occurred_at:'2026-10-04T10:00:00Z'}],attachments:[]}});
  });
  await page.route('**/api/crm?*', route => route.fulfill({ json: { records: [], books: [], history: [] } }));
  await page.route('**/api/notifications?*', route => route.fulfill({ json: { records: [], unread: 0 } }));
  await page.route('**/api/tracking?*', route => route.fulfill({ json: { attention: 0, drafts: 0, waiting: 0, due: 0, recent: [] } }));
  await page.goto('/#inbox');
  await expect(page.getByRole('button',{name:'Analyze conversation'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Review / edit AI reply'})).toBeVisible();
  await page.getByRole('button',{name:'Delete AI draft',exact:true}).click();
  await expect(page.getByRole('button',{name:'Review / edit AI reply'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Reply',exact:true}).last()).toBeVisible();
  await page.getByRole('button',{name:'Deleted',exact:true}).click();
  await page.getByRole('button',{name:/Deleted AI drafts/}).click();
  await page.getByRole('button',{name:'Move to AI Draft Replies',exact:true}).click();
  await page.getByRole('button',{name:'AI Draft Replies',exact:true}).click();
  await expect(page.getByLabel('Edit AI reply draft')).toHaveValue('Thanks. Please share your availability.');
  await page.screenshot({path:'tmp/browser-results/ai-draft-controls.png'});
});
