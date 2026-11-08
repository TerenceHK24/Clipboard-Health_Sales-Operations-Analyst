import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CapabilityRegistry,SqliteJournal,GovernedAgentRuntime } from '../core.mjs';
import { CompanyPolicyStore } from '../admin/policy-store.mjs';
import { SlackApprovalStore,RichSlackApprovalGateway,buildApprovalBlocks } from '../adapters/slack-workflow.mjs';
import { createSlackInteractionHandler } from '../adapters/slack-receiver.mjs';
import { createServer } from 'node:http';
const secret='test-signing-secret';
const signed=payload=>{const rawBody=new URLSearchParams({payload:JSON.stringify(payload)}).toString();const ts=String(Math.floor(Date.now()/1000));return {rawBody,headers:{'x-slack-request-timestamp':ts,'x-slack-signature':'v0='+createHmac('sha256',secret).update(`v0:${ts}:${rawBody}`).digest('hex')}}};
function setup({withManager=true,onApproved=true}={}){
 const dir=mkdtempSync(join(tmpdir(),'universal-rich-slack-'));
 const reg=new CapabilityRegistry(),writes=[];
 reg.register({id:'crm.update',mode:'write',description:'Update a CRM account',requiredScopes:['crm:write'],
  validate:a=>typeof a.id==='string'&&typeof a.name==='string',execute:async a=>{writes.push(a);return {ok:true,id:a.id,name:a.name}},
  verify:async(a,r)=>r.ok===true&&a.id===r.id&&a.name===r.name});
 const journal=new SqliteJournal(join(dir,'journal.sqlite'));
 const policies=new CompanyPolicyStore(join(dir,'policies.sqlite'),'test-co');
 const approvals=new SlackApprovalStore(join(dir,'requests.sqlite'));
 policies.upsertCapability({id:'crm.update',enabled:true,roles:['manager'],actor:'it-admin',registry:reg});
 if(withManager)policies.setSlackUser({teamId:'T-TEST',userId:'U-MANAGER',role:'manager',scopes:['crm:write'],actor:'it-admin'});
 const runtime=new GovernedAgentRuntime({registry:reg,journal,tenantId:'test-co',canApprove:async({actor,plan})=>policies.canApprove({actor,plan,registry:reg})});
 const f=runtime.discover({type:'mismatched_account',summary:'Accounting and CRM disagree on payer',evidenceRefs:['crm:case-1','erp:invoice-2']});
 runtime.decideDiscovery(f.id,{decision:'investigate',actor:'analyst'});
 const plan=runtime.proposePlan(f.id,{title:'Correct name',steps:[{tool:'crm.update',args:{id:'acc-1',name:'Correct Legal Name'},reason:'Validated against signed contract'}]});
 const apiCalls=[];
 const gateway=new RichSlackApprovalGateway({signingSecret:secret,botToken:'test-bot-token',teamId:'T-TEST',tenantId:'test-co',
  approvalStore:approvals,policyStore:policies,registry:reg,allowedChannels:['C-OPS'],
  answerQuestion:async ({question})=>`The evidence shows ${question.length} chars in your question; please review source records.`,
  onApproved:onApproved?async()=>{await runtime.execute(f.id)}:null,
  fetchImpl:async(url,options)=>{apiCalls.push({url:String(url),options});return {ok:true,json:async()=>({ok:true,ts:'123.456'})}}});
 const close=()=>{journal.close();policies.close();approvals.close();rmSync(dir,{recursive:true,force:true})};
 return {dir,reg,journal,policies,approvals,runtime,gateway,f,plan,apiCalls,writes,close};
}
const makeAction=(action,value,user='U-MANAGER')=>({type:'block_actions',team:{id:'T-TEST'},user:{id:user},trigger_id:'999.999',actions:[{action_id:action,value}]});

test('rich Slack card has four actions, native second confirmation, evidence and no token or raw payload',async()=>{
 const s=setup();try{
  const r=await s.gateway.publish({channel:'C-OPS',findingId:s.f.id,planId:s.plan.id,runtime:s.runtime,risk:'High',affected:3});
  const body=JSON.parse(s.apiCalls[0].options.body);
  assert.equal(body.blocks.at(-1).elements.length,4);
  assert.equal(body.blocks.at(-1).elements[0].confirm.confirm.text,'Confirm approval');
  assert.ok(!JSON.stringify(body).includes('test-bot-token'));
  assert.ok(!JSON.stringify(body).includes('Correct Legal Name'));
  assert.equal(s.approvals.get(r.id).status,'pending');
 }finally{s.close()}
});

test('manager approval uses server-derived scopes; no write until after ACK; replay is ignored',async()=>{
 const s=setup();try{
  const approval=await s.gateway.publish({channel:'C-OPS',findingId:s.f.id,planId:s.plan.id,runtime:s.runtime});
  const input=signed(makeAction('ua.approve',approval.id));
  const result=await s.gateway.handle({...input,runtime:s.runtime});
  assert.equal(s.writes.length,0,'not before the callback ACK');
  assert.equal(result.kind,'decision');
  assert.equal((await result.afterAck()).status,'approve');
  assert.equal(s.writes.length,1);
  assert.equal(s.approvals.get(approval.id).status,'approved');
  assert.equal((await result.afterAck()).status,'ignored');
  assert.equal(s.writes.length,1,'replayed Slack action cannot rerun backend');
 }finally{s.close()}
});

test('unknown or unassigned Slack manager cannot approve even with a valid signed callback',async()=>{
 const s=setup();try{
  const a=await s.gateway.publish({channel:'C-OPS',findingId:s.f.id,planId:s.plan.id,runtime:s.runtime});
  const input=signed(makeAction('ua.approve',a.id,'U-UNASSIGNED'));
  await assert.rejects(s.gateway.handle({...input,runtime:s.runtime}),/not mapped/);
  assert.equal(s.approvals.get(a.id).status,'pending');assert.equal(s.writes.length,0);
 }finally{s.close()}
});

test('evidence button opens a safe modal but does not change decisions',async()=>{
 const s=setup();try{
  const a=await s.gateway.publish({channel:'C-OPS',findingId:s.f.id,planId:s.plan.id,runtime:s.runtime});
  const r=await s.gateway.handle({...signed(makeAction('ua.details',a.id)),runtime:s.runtime});
  assert.equal(r.kind,'modal');
  assert.equal(s.apiCalls.at(-1).url.endsWith('views.open'),true);
  assert.match(JSON.stringify(s.apiCalls.at(-1).options.body),/Evidence references/);
  assert.equal(s.journal.get(s.f.id).state,'investigating');assert.equal(s.writes.length,0);
 }finally{s.close()}
});

test('Ask Agent displays input modal, returns private answer, does not approve, and deduplicates submissions',async()=>{
 const s=setup();try{
  const a=await s.gateway.publish({channel:'C-OPS',findingId:s.f.id,planId:s.plan.id,runtime:s.runtime});
  const ask=await s.gateway.handle({...signed(makeAction('ua.ask',a.id)),runtime:s.runtime});
  assert.equal(ask.kind,'modal');
  const payload={type:'view_submission',team:{id:'T-TEST'},user:{id:'U-MANAGER'},view:{id:'V123',hash:'hash-1',callback_id:'ua.question',private_metadata:a.id,state:{values:{question:{entry:{value:'Why update accounting?' }}}}}};
  const result=await s.gateway.handle({...signed(payload),runtime:s.runtime});
  assert.equal(result.kind,'question');assert.equal(result.ack.response_action,'clear');
  assert.equal((await result.afterAck()).status,'answered');
  assert.equal(s.apiCalls.at(-1).url.endsWith('chat.postEphemeral'),true);
  assert.equal((await result.afterAck()).status,'duplicate');
  assert.equal(s.writes.length,0);
 }finally{s.close()}
});

test('signed callback rejects tampering and plan changes after Slack card issuance',async()=>{
 const s=setup();try{
  const a=await s.gateway.publish({channel:'C-OPS',findingId:s.f.id,planId:s.plan.id,runtime:s.runtime});
  const input=signed(makeAction('ua.approve',a.id));
  await assert.rejects(s.gateway.handle({...input,rawBody:input.rawBody+'tampered',runtime:s.runtime}),/Invalid Slack signature/);
  const f=s.journal.get(s.f.id);f.data.plans[0].digest='modified';s.journal.save(f);
  await assert.rejects(s.gateway.handle({...input,runtime:s.runtime}),/plan changed/);
  assert.equal(s.writes.length,0);
 }finally{s.close()}
});

test('signed HTTP callback sends 200 ACK before delayed backend execution',async()=>{
 const s=setup();let server;
 try{
  const a=await s.gateway.publish({channel:'C-OPS',findingId:s.f.id,planId:s.plan.id,runtime:s.runtime});
  server=createServer(createSlackInteractionHandler({gateway:s.gateway,runtime:s.runtime}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const input=signed(makeAction('ua.approve',a.id));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/slack/interactions`,{method:'POST',headers:{...input.headers,'content-type':'application/x-www-form-urlencoded'},body:input.rawBody});
  assert.equal(response.status,200);
  assert.match(await response.text(),/Approval received/);
  // Backend dispatches separately; check it finishes and is journaled.
  for(let i=0;i<40 && !s.writes.length;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(s.writes.length,1);
  assert.equal(s.journal.get(s.f.id).state,'applied');
 }finally{if(server)await new Promise(r=>server.close(r));s.close()}
});

test('permission revoked by IT after Slack action is received blocks backend execution',async()=>{
 const s=setup();try{
  const a=await s.gateway.publish({channel:'C-OPS',findingId:s.f.id,planId:s.plan.id,runtime:s.runtime});
  const action=await s.gateway.handle({...signed(makeAction('ua.approve',a.id)),runtime:s.runtime});
  s.policies.upsertCapability({id:'crm.update',enabled:false,roles:['manager'],actor:'it-admin',registry:s.reg});
  await assert.rejects(action.afterAck(),/revoked/);
  assert.equal(s.writes.length,0);
  assert.equal(s.approvals.get(a.id).status,'pending');
 }finally{s.close()}
});

test('pending Slack approval survives gateway restart and can be atomically consumed only once',()=>{
 const s=setup();try{
  const req=s.approvals.create({tenant:'test-co',teamId:'T-TEST',channel:'C-OPS',findingId:s.f.id,planId:s.plan.id,planDigest:s.plan.digest});
  const extra=new SlackApprovalStore(join(s.dir,'requests.sqlite'));
  try{
    assert.equal(extra.get(req.id).status,'pending');
    assert.equal(s.approvals.claim(req.id,'manager'),true);
    assert.equal(extra.claim(req.id,'manager'),false);
    s.approvals.complete(req.id,'approved');
    assert.equal(extra.get(req.id).status,'approved');
  }finally{extra.close()}
 }finally{s.close()}
});
