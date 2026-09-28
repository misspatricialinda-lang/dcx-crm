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
