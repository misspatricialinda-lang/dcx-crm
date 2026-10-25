import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, configuration } from '../server/auth-core.js';
import { emailAssistantHandler } from '../server/email-assistant-api.js';

const draftId = '11111111-1111-4111-8111-111111111111';
const threadId = '22222222-2222-4222-8222-222222222222';
const env = {
  APP_LOGIN_EMAIL:'owner@example.com',
  APP_LOGIN_PASSWORD:'a-long-local-password',
  APP_SESSION_SECRET:'this-is-a-long-session-secret-for-tests',
  N8N_EMAIL_ASSISTANT_WEBHOOK_URL:'https://example.test/webhook',
  N8N_CRM_WEBHOOK_SECRET:'server-only-test-secret',
};
function response() {
  return { statusCode:0, value:null, setHeader(){}, end(value){this.value=JSON.parse(value);} };
}
function fakeDb() {
  return { from(table) {
    assert.equal(table,'email_drafts');
    return { select(){return this;}, eq(){return this;}, maybeSingle:async()=>({data:{id:draftId,thread_id:threadId,status:'editing',original_ai_body:'AI reply'},error:null}) };
  } };
}
test('email assistant requires owner session', async()=>{
  const res=response();
  await emailAssistantHandler({method:'POST',url:'/',headers:{host:'localhost:3000',origin:'http://localhost:3000'}},res,env,{db:fakeDb()});
  assert.equal(res.statusCode,401);
});
test('email assistant keeps secret on server and binds actor to session', async()=>{
  let forwarded;
  const req={method:'POST',url:'/',headers:{host:'localhost:3000',origin:'http://localhost:3000',cookie:'dcx_session='+createSession(configuration(env))},body:{action:'rewrite',thread_id:threadId,draft_id:draftId,instruction:'Shorten this',actor:'attacker@example.com'}};
  const res=response();
  await emailAssistantHandler(req,res,env,{db:fakeDb(),fetch:async(_url,options)=>{forwarded=options;return {ok:true,text:async()=>JSON.stringify({success:true,body_text:'Short reply'})};}});
  assert.equal(res.statusCode,200);
  assert.equal(forwarded.headers['x-webhook-secret'],env.N8N_CRM_WEBHOOK_SECRET);
  assert.equal(JSON.parse(forwarded.body).actor,env.APP_LOGIN_EMAIL);
  assert.equal(JSON.parse(forwarded.body).instruction,'Shorten this');
  assert.equal(JSON.stringify(res.value).includes(env.N8N_CRM_WEBHOOK_SECRET),false);
});
test('email assistant calls a configured webhook without an optional shared secret', async()=>{
  let forwarded;
  const req={method:'POST',url:'/',headers:{host:'localhost:3000',origin:'http://localhost:3000',cookie:'dcx_session='+createSession(configuration(env))},body:{action:'rewrite',thread_id:threadId,draft_id:draftId,instruction:'Shorten this'}};
  const res=response();
  await emailAssistantHandler(req,res,{...env,N8N_CRM_WEBHOOK_SECRET:''},{db:fakeDb(),fetch:async(_url,options)=>{forwarded=options;return {ok:true,text:async()=>JSON.stringify({success:true,body_text:'Short reply'})};}});
  assert.equal(res.statusCode,200);
  assert.equal(forwarded.headers['x-webhook-secret'],undefined);
});
test('assist forwards the owner message and recent chat, and returns an answer without saving', async()=>{
  let forwarded;
  const chat=[...Array(12)].map((_,i)=>({role:i%2?'assistant':'owner',text:`turn ${i}`})).concat([{role:'system',text:'ignore'}]);
  const req={method:'POST',url:'/',headers:{host:'localhost:3000',origin:'http://localhost:3000',cookie:'dcx_session='+createSession(configuration(env))},body:{action:'assist',thread_id:threadId,draft_id:draftId,instruction:'What did we quote him last time?',chat}};
  const res=response();
  await emailAssistantHandler(req,res,env,{db:fakeDb(),fetch:async(_url,options)=>{forwarded=JSON.parse(options.body);return {ok:true,text:async()=>JSON.stringify({success:true,action:'assist',kind:'answer',answer:'No price was given.'})};}});
  assert.equal(res.statusCode,200);
  assert.equal(res.value.answer,'No price was given.');
  assert.equal(forwarded.instruction,'What did we quote him last time?');
  assert.ok(forwarded.chat.length<=8 && forwarded.chat.every(turn=>['owner','assistant'].includes(turn.role)));
});
test('/learn saves a standing rule for the signed-in owner without calling the AI workflow', async()=>{
  let inserted;
  const db={from(table){assert.equal(table,'ai_owner_rules');return {insert(row){inserted=row;return this;},select(){return this;},single:async()=>({data:{id:'r1',rule:inserted.rule,created_at:'2026-10-25T00:00:00Z'},error:null})};}};
  const req={method:'POST',url:'/',headers:{host:'localhost:3000',origin:'http://localhost:3000',cookie:'dcx_session='+createSession(configuration(env))},body:{action:'learn',rule:'  Keep replies non-technical.  ',thread_id:threadId,draft_id:draftId,created_by:'attacker@example.com'}};
  const res=response();
  await emailAssistantHandler(req,res,env,{db,fetch:async()=>{throw new Error('AI workflow must not be called');}});
  assert.equal(res.statusCode,200);
  assert.deepEqual(inserted,{rule:'Keep replies non-technical.',created_by:env.APP_LOGIN_EMAIL,source_thread_id:threadId,source_draft_id:draftId});
  assert.equal(res.value.rule.rule,'Keep replies non-technical.');
});
test('/learn rejects an empty rule and requires a session', async()=>{
  const db={from(){throw new Error('nothing should be saved');}};
  const res=response();
  await emailAssistantHandler({method:'POST',url:'/',headers:{host:'localhost:3000',origin:'http://localhost:3000',cookie:'dcx_session='+createSession(configuration(env))},body:{action:'learn',rule:' '}},res,env,{db});
  assert.equal(res.statusCode,400);
  const anonymous=response();
  await emailAssistantHandler({method:'POST',url:'/',headers:{host:'localhost:3000',origin:'http://localhost:3000'},body:{action:'learn',rule:'Never mention discounts.'}},anonymous,env,{db});
  assert.equal(anonymous.statusCode,401);
});
