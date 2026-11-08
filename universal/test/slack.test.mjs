import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { SlackApprovalBridge, verifySlackRequest } from '../adapters/slack.mjs';
const secret='synthetic-signing-secret';
const sign=(raw,timestamp)=> 'v0='+createHmac('sha256',secret).update(`v0:${timestamp}:${raw}`).digest('hex');

test('Slack signature verifies exact raw payload, rejects forgery and stale requests',()=>{
 const timestamp=String(Math.floor(Date.now()/1000));const rawBody='payload=%7B%7D';
 assert.equal(verifySlackRequest({rawBody,timestamp,signature:sign(rawBody,timestamp),signingSecret:secret}),true);
 assert.equal(verifySlackRequest({rawBody:rawBody+'x',timestamp,signature:sign(rawBody,timestamp),signingSecret:secret}),false);
 assert.equal(verifySlackRequest({rawBody,timestamp:String(Number(timestamp)-400),signature:sign(rawBody,timestamp),signingSecret:secret}),false);
});

test('Slack request approval does not expose tokens and maps only to known plans',async()=>{
 const calls=[],bridge=new SlackApprovalBridge({signingSecret:secret,botToken:'synthetic-bot-token',expectedTeamId:'T-TEST',
 fetchImpl:async(_url,opts)=>{calls.push(opts);return {ok:true,json:async()=>({ok:true,ts:'123.000'})}}});
 const {requestId}=await bridge.requestApproval({channel:'C-TEST',findingId:'case-1',planId:'plan-1',summary:'Approve known change'});
 assert.equal(calls.length,1);
 assert.equal(JSON.parse(calls[0].body).blocks[1].elements[0].value,requestId);
 assert.ok(!calls[0].body.includes('synthetic-bot-token'));
 const timestamp=String(Math.floor(Date.now()/1000));
 const payload={team:{id:'T-TEST'},user:{id:'manager-1'},actions:[{action_id:'universal_approve',value:requestId}]};
 const rawBody=new URLSearchParams({payload:JSON.stringify(payload)}).toString();
 const headers={'x-slack-request-timestamp':timestamp,'x-slack-signature':sign(rawBody,timestamp)};
 const decisions=[];
 const runtime={decidePlan:async (id,params)=>{decisions.push({id,params});return {state:'approved'}}};
 const a=await bridge.acceptAction({headers,rawBody,runtime,scopes:['crm:write']});
 assert.equal(a.status,'approved');
 assert.equal(decisions[0].params.actor,'manager-1');
 assert.deepEqual(decisions[0].params.context.scopes,['crm:write']);
 await assert.rejects(bridge.acceptAction({headers,rawBody,runtime,scopes:['crm:write']}),/already used/);
});

test('Slack action rejects wrong Slack tenant and cannot trick the runtime into approval',async()=>{
 const bridge=new SlackApprovalBridge({signingSecret:secret,botToken:'synthetic-bot-token',expectedTeamId:'T-TEST',
 fetchImpl:async()=>({ok:true,json:async()=>({ok:true,ts:'x'})})});
 const {requestId}=await bridge.requestApproval({channel:'C',findingId:'f',planId:'p',summary:'Investigate'});
 const timestamp=String(Math.floor(Date.now()/1000));
 const rawBody=new URLSearchParams({payload:JSON.stringify({team:{id:'T-OTHER'},user:{id:'manager'},actions:[{action_id:'universal_approve',value:requestId}]})}).toString();
 const headers={'x-slack-request-timestamp':timestamp,'x-slack-signature':sign(rawBody,timestamp)};
 await assert.rejects(bridge.acceptAction({headers,rawBody,runtime:{decidePlan:async()=>{throw Error('should not be invoked')}}}),/workspace mismatch/);
});
