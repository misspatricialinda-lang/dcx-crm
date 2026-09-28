import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const one = JSON.parse(readFileSync('workflow 1.json', 'utf8'));
const two = JSON.parse(readFileSync('workflow 2 - draft actions.json', 'utf8'));
const three = JSON.parse(readFileSync('workflow 3 - send reply.json', 'utf8'));
const node = (workflow, name) => workflow.nodes.find(item => item.name === name);
assert.equal(node(three, 'Send Outlook Reply Draft').parameters.to, '');
assert.equal(node(one, 'Get Email Chain').parameters.filtersUI.values.filterBy, 'filters');
assert.match(node(one, 'Format Email Chain').parameters.jsCode, /item\.json\.conversationId === trig\.conversationId/);
const format = new Function('$input', '$', node(one, 'Format Email Chain').parameters.jsCode);
const mailbox = 'aliisthebestofthebest@outlook.com';
const graphMessages = Array.from({length:40}, (_, index) => ({
  id:`graph-${index + 1}`,conversationId:'forty-message-chain',isDraft:false,
  from:{emailAddress:{address:index % 2 ? mailbox : 'customer@example.com'}},
  toRecipients:[{emailAddress:{address:index % 2 ? 'customer@example.com' : mailbox}}],
  ccRecipients:[],subject:'Re: long conversation',body:{contentType:'html',content:`<p>${index + 1}: ${'Detailed conversation text. '.repeat(400)}</p>`},
  bodyPreview:`${index + 1}: Older message preview`,receivedDateTime:new Date(Date.parse('2026-09-01T00:00:00Z')+index*3600_000).toISOString()
}));
const trigger=graphMessages.at(-1);
const context=format({all:()=>[...graphMessages.map(json=>({json})),{json:{id:'unrelated',conversationId:'other'}}]},
  name=>({first:()=>({json:name==='New Outlook Email' ? trigger : {mailbox_address:mailbox,own_addresses:[mailbox]}})}))[0].json;
assert.equal(JSON.parse(Buffer.from(context.payloadBase64,'base64').toString()).messages.length,40);
assert.ok(context.threadText.length<70_000, `AI context was ${context.threadText.length} characters`);
assert.match(context.threadText,/40 messages in this Outlook conversation/);
const editContext = new Function('$', node(two, 'Build AI Context').parameters.jsCode);
const dbMessages = graphMessages.map((message,index)=>({
  id:message.id,direction:index % 2 ? 'outgoing' : 'incoming',
  sender:message.from.emailAddress.address,to_addresses:message.toRecipients.map(r=>r.emailAddress.address),
  occurred_at:message.receivedDateTime,body_html:message.body.content,body_text:message.bodyPreview
}));
const edit = editContext(name=>({
  item:{json:name==='Validate Request' ? {action:'regenerate',thread_id:'test',draft_id:'draft',request_id:'request',actor:'owner'}
    : name==='Load Thread' ? {status:'draft_ready',subject:'Re: long conversation',mailbox_id:'mailbox'}
    : name==='Load Draft' ? {id:'draft',current_body:'Draft',revision:1,status:'editing',reply_to_message_id:'graph-39',to_addresses:['customer@example.com']}
    : {}},
  all:()=>name==='Load Thread Messages' ? dbMessages.map(json=>({json})) : []
}))[0].json;
assert.ok(edit.history.length<70_000, `Draft edit context was ${edit.history.length} characters`);
assert.match(edit.history,/40 messages in the conversation/);

const db = new PGlite();
await db.exec(`
 CREATE TABLE email_mailboxes(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),provider text,address text,UNIQUE(provider,address));
 CREATE TABLE email_threads(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),mailbox_id uuid,provider_thread_key text,subject text,status text,last_message_at timestamptz,updated_at timestamptz DEFAULT now(),UNIQUE(mailbox_id,provider_thread_key));
 CREATE TABLE email_messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),thread_id uuid,mailbox_id uuid,provider_key text,provider_ref text,internet_message_id text,direction text,sender text,to_addresses jsonb,cc_addresses jsonb,subject text,body_text text,body_html text,body_loaded boolean,has_attachments boolean,occurred_at timestamptz,UNIQUE(mailbox_id,provider_key));
 CREATE TABLE email_drafts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),thread_id uuid,reply_to_message_id uuid,current_body text,original_ai_body text,to_addresses jsonb,subject text,revision integer,source_message_version integer,status text,updated_at timestamptz DEFAULT now());
 CREATE UNIQUE INDEX email_one_open_draft ON email_drafts(thread_id) WHERE status <> 'sent';
 CREATE TABLE email_draft_revisions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),draft_id uuid,revision integer,body text,to_addresses jsonb,subject text,actor text);
 INSERT INTO email_mailboxes VALUES('00000000-0000-0000-0000-000000000001','microsoft','owner@example.com');
 INSERT INTO email_threads(id,mailbox_id,provider_thread_key,subject,status,last_message_at) VALUES('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','conversation-1','Re: test','needs_attention','2026-09-26T18:00:00Z');
 INSERT INTO email_messages(id,thread_id,mailbox_id,provider_key,provider_ref,direction,sender,to_addresses,subject,body_text,occurred_at) VALUES('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','crm-send:draft:1','draft-provider-ref','outgoing','owner@example.com','["customer@example.com"]','Re: test','Thanks for your message. We will help.','2026-09-26T18:00:00Z');
`);
const payload = {mailbox:'owner@example.com',thread_key:'conversation-1',subject:'Re: test',trigger_id:'incoming-2',trigger_direction:'incoming',messages:[
 {provider_key:'outlook-sent-1',provider_ref:'outlook-sent-1',internet_message_id:'<sent1>',direction:'outgoing',sender:'owner@example.com',to_addresses:['customer@example.com'],cc_addresses:[],subject:'Re: test',body_text:'Thanks for your message. We will help.',body_html:'',body_loaded:true,has_attachments:false,occurred_at:'2026-09-26T18:00:05Z'},
 {provider_key:'incoming-2',provider_ref:'incoming-2',internet_message_id:'<incoming2>',direction:'incoming',sender:'customer@example.com',to_addresses:['owner@example.com'],cc_addresses:[],subject:'Re: test',body_text:'Great, thank you.',body_html:'',body_loaded:true,has_attachments:false,occurred_at:'2026-09-26T18:01:00Z'}
]};
const b64 = Buffer.from(JSON.stringify(payload)).toString('base64');
const reconciled = await db.query(node(one, 'Reconcile Sent Copies').parameters.query, [b64]);
assert.equal(Number(reconciled.rows[0].reconciled_sent_copies), 1);
const persisted = await db.query(node(one, 'Persist Incoming Email').parameters.query, [b64]);
assert.equal(persisted.rows[0].stored_message_count, 2);
const stored = await db.query('SELECT provider_key,direction FROM email_messages ORDER BY occurred_at');
assert.deepEqual(stored.rows.map(row => row.provider_key), ['outlook-sent-1', 'incoming-2']);
const longChain = structuredClone(payload);
for (let index = 3; index <= 13; index++) longChain.messages.push({
  provider_key:`message-${index}`,provider_ref:`message-${index}`,internet_message_id:`<message-${index}>`,
  direction:index % 2 ? 'incoming' : 'outgoing',
  sender:index % 2 ? 'customer@example.com' : 'owner@example.com',
  to_addresses:[index % 2 ? 'owner@example.com' : 'customer@example.com'],cc_addresses:[],
  subject:'Re: test',body_text:`Message ${index}`,body_html:'',body_loaded:true,has_attachments:false,
  occurred_at:new Date(Date.parse('2026-09-26T18:01:00Z') + index * 60_000).toISOString()
});
longChain.trigger_id='message-13';
const longB64=Buffer.from(JSON.stringify(longChain)).toString('base64');
await db.query(node(one, 'Persist Incoming Email').parameters.query, [longB64]);
await db.query(node(one, 'Persist Incoming Email').parameters.query, [longB64]);
const count=await db.query('SELECT count(*)::int AS n FROM email_messages');
assert.equal(count.rows[0].n, 13);

const draftPayload = Buffer.from(JSON.stringify({body:'A tricky $body$ quote: O\'Brien',subject:'Re: test',sender:'customer@example.com',thread_id:'00000000-0000-0000-0000-000000000002',message_id:persisted.rows[0].message_id})).toString('base64');
const draft = await db.query(node(one, 'Save Dashboard Draft').parameters.query, [draftPayload]);
assert.equal(draft.rows[0].revision, 1);
const body = await db.query('SELECT current_body FROM email_drafts');
assert.equal(body.rows[0].current_body, "A tricky $body$ quote: O'Brien");
await db.query("UPDATE email_mailboxes SET address='aliisthebestofthebest@outlook.com'");
await db.query("UPDATE email_messages SET to_addresses='[\"aliisthebestofthebest@outlook.com\"]'::jsonb WHERE provider_key='incoming-2'");
const draftId = draft.rows[0].draft_id;
const claimQuery = node(three, 'Claim Draft for Send').parameters.query;
const params = [draftId, '00000000-0000-0000-0000-000000000002', 1,
  'aliisthebestofthebest@outlook.com;outlook_f90cec84ccc04643@outlook.com',
  'aliisthebestofthebest@outlook.com'];
const claim = await db.query(claimQuery, params);
assert.equal(claim.rows[0].draft_id, draftId);
const verifyCode = node(three, 'Verify Exact Recipient').parameters.jsCode;
const verify = new Function('$json', '$', verifyCode);
const setup = {mailbox_address:'aliisthebestofthebest@outlook.com',own_addresses:['aliisthebestofthebest@outlook.com','outlook_f90cec84ccc04643@outlook.com']};
const resolve = name => ({first:() => ({json:name==='Claim Draft for Send' ? claim.rows[0] : setup})});
const outlookDraft = {isDraft:true,conversationId:'conversation-1',from:{emailAddress:{address:setup.mailbox_address}},toRecipients:[{emailAddress:{address:'customer@example.com'}}],ccRecipients:[],bccRecipients:[]};
assert.equal(verify(outlookDraft, resolve)[0].json.recipient_safe, true);
assert.equal(verify({...outlookDraft,toRecipients:[{emailAddress:{address:setup.own_addresses[1]}}]}, resolve)[0].json.recipient_safe, false);
assert.equal(verify({...outlookDraft,conversationId:'other-conversation'}, resolve)[0].json.recipient_safe, false);
assert.equal(verify({...outlookDraft,ccRecipients:[{emailAddress:{address:'third@example.com'}}]}, resolve)[0].json.recipient_safe, false);
await db.query("UPDATE email_drafts SET status='editing',to_addresses='[\"outlook_f90cec84ccc04643@outlook.com\"]'::jsonb");
const selfClaim = await db.query(claimQuery, params);
assert.equal(selfClaim.rows[0].draft_id, null);
await db.close();
console.log('Thirteen-message chain, repeat import, reconcile, quoted draft, and recipient checks passed.');


