import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHmac} from 'node:crypto';
import {CapabilityRegistry,SqliteJournal,GovernedAgentRuntime} from '../core.mjs';
import {CompanyPolicyStore} from '../admin/policy-store.mjs';
import {DurableQueue} from '../platform/queue.mjs';
import {SlackApprovalStore,RichSlackApprovalGateway} from '../adapters/slack-workflow.mjs';

test('Slack decisions are journaled before ACK, RBAC is rechecked and execution is queued once',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ops-slack-durable-'));
 const file=name=>join(dir,name+'.sqlite'),tenant='example',writes=[];
 const journal=new SqliteJournal(file('journal'));
 const policyStore=new CompanyPolicyStore(file('policy'),tenant);
 const queue=new DurableQueue(file('queue'));
 const approvalStore=new SlackApprovalStore(file('slack'));
 const registry=new CapabilityRegistry().register({id:'crm.update',description:'Mock CRM write',mode:'write',requiredScopes:['crm:write'],validate:a=>!!a?.id,
   execute:async a=>{writes.push(a);return {success:true}},verify:async(_a,r)=>r.success===true});
 policyStore.upsertCapability({id:'crm.update',enabled:true,roles:['manager'],registry,actor:'it-admin'});
 policyStore.setSlackUser({teamId:'T123',userId:'U123',role:'manager',scopes:['crm:write'],actor:'it-admin'});
 const runtime=new GovernedAgentRuntime({registry,journal,tenantId:tenant,
   canApprove:({actor,plan})=>policyStore.canApprove({actor,plan,registry}),
   canExecute:({actor,plan})=>policyStore.canApprove({actor,plan,registry})});
 const messages=[];
 const gateway=new RichSlackApprovalGateway({tenantId:tenant,teamId:'T123',signingSecret:'test-secret',botToken:'test-bot',approvalStore,
   policyStore,registry,queue,allowedChannels:['C123'],fetchImpl:async(url,opts)=>{messages.push({url:String(url),body:JSON.parse(opts.body)});return {ok:true,json:async()=>({ok:true,ts:'1.000'})}}});
 try{
  const finding=runtime.discover({type:'mismatch',summary:'Account mismatch confirmed after investigation',evidenceRefs:['crm:id:A','erp:id:A']});
  runtime.decideDiscovery(finding.id,{decision:'investigate',actor:'analyst'});
  const plan=runtime.proposePlan(finding.id,{title:'Correct CRM',steps:[{tool:'crm.update',args:{id:'A'},reason:'Finance team validated proposed change'}]});
  const sent=await gateway.publish({channel:'C123',findingId:finding.id,planId:plan.id,runtime,risk:'High',affected:1});
  const buttons=messages[0].body.blocks.at(-1).elements;assert.equal(buttons.length,4);assert.ok(buttons[0].confirm,'Native second confirmation must exist');
  const payload={type:'block_actions',team:{id:'T123'},user:{id:'U123'},actions:[{action_id:'ua.approve',value:sent.id}]};
  const rawBody=new URLSearchParams({payload:JSON.stringify(payload)}).toString(),ts=String(Math.floor(Date.now()/1000));
  const signature='v0='+createHmac('sha256','test-secret').update(`v0:${ts}:${rawBody}`).digest('hex');
  const headers={'x-slack-request-timestamp':ts,'x-slack-signature':signature};
  const result=await gateway.handle({headers,rawBody,runtime});assert.equal(result.kind,'queued');assert.equal(result.afterAck,null);
  assert.equal(queue.list(tenant).length,1);assert.equal(writes.length,0);
  const replay=await gateway.handle({headers,rawBody,runtime});assert.equal(replay.jobId,result.jobId);assert.equal(queue.list(tenant).length,1);
  await queue.drain({'slack-decision':job=>gateway.processQueuedDecision(job,runtime),
   'execute-plan':async job=>runtime.execute(job.payload.findingId)});
  assert.equal(journal.get(finding.id).state,'applied');assert.equal(writes.length,1);
  assert.equal(queue.list(tenant).filter(j=>j.state==='done').length,2);
 }finally{approvalStore.close();queue.close();policyStore.close();journal.db.close();rmSync(dir,{recursive:true,force:true})}
});

test('Revoking Slack approver permission before durable queue drain blocks all writes',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ops-slack-revoke-'));
 const file=name=>join(dir,name+'.sqlite'),tenant='example',writes=[];
 const journal=new SqliteJournal(file('journal')),policy=new CompanyPolicyStore(file('policy'),tenant),queue=new DurableQueue(file('queue')),
 approvals=new SlackApprovalStore(file('approvals'));
 const registry=new CapabilityRegistry().register({id:'crm.write',description:'Synthetic write',mode:'write',requiredScopes:['crm:write'],validate:a=>!!a?.id,
   execute:async a=>{writes.push(a);return {ok:true}},verify:async()=>true});
 policy.upsertCapability({id:'crm.write',enabled:true,roles:['manager'],registry,actor:'admin'});policy.setSlackUser({teamId:'T123',userId:'U123',role:'manager',scopes:['crm:write'],actor:'admin'});
 const runtime=new GovernedAgentRuntime({registry,journal,tenantId:tenant,canApprove:({actor,plan})=>policy.canApprove({actor,plan,registry}),canExecute:({actor,plan})=>policy.canApprove({actor,plan,registry})});
 const gateway=new RichSlackApprovalGateway({tenantId:tenant,teamId:'T123',signingSecret:'secret',botToken:'token',approvalStore:approvals,
   policyStore:policy,registry,queue,allowedChannels:['C123'],fetchImpl:async()=>({ok:true,json:async()=>({ok:true,ts:'1.000'})})});
 try{const f=runtime.discover({type:'data_issue',summary:'Some status mismatch investigated',evidenceRefs:['ref1']});
  runtime.decideDiscovery(f.id,{decision:'investigate',actor:'analyst'});
  const p=runtime.proposePlan(f.id,{title:'Change',steps:[{tool:'crm.write',args:{id:'A'},reason:'Example'}]});
  const sent=await gateway.publish({channel:'C123',findingId:f.id,planId:p.id,runtime});
  queue.enqueue({tenant,kind:'slack-decision',payload:{requestId:sent.id,actor:'slack:T123:U123',decision:'approve'},dedupeKey:sent.id});
  policy.upsertCapability({id:'crm.write',enabled:false,roles:['manager'],registry,actor:'admin'});
  await queue.drain({'slack-decision':job=>gateway.processQueuedDecision(job,runtime)});
  assert.equal(queue.list(tenant)[0].state,'blocked');assert.equal(writes.length,0);
 }finally{approvals.close();queue.close();policy.close();journal.db.close();rmSync(dir,{recursive:true,force:true})}
});
