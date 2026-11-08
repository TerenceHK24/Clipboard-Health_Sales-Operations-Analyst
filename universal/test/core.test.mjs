import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CapabilityRegistry, SqliteJournal, GovernedAgentRuntime } from '../core.mjs';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'universal-agent-test-'));
  const writes = [];
  const registry = new CapabilityRegistry()
    .register({id:'crm.read_account',description:'Read CRM account',mode:'read',validate:a=>typeof a.id==='string',execute:async a=>({id:a.id,status:'Active'})})
    .register({id:'crm.update_account',description:'Update CRM account',mode:'write',requiredScopes:['crm:write'],
      validate:a=>typeof a.id==='string' && typeof a.status==='string',
      execute:async a=>{writes.push(a);return {id:a.id,status:a.status}},
      verify:async (a, result)=>result.id===a.id && result.status===a.status});
  const journal = new SqliteJournal(join(dir,'journal.sqlite'));
  const runtime = new GovernedAgentRuntime({registry,journal,tenantId:'acme-demo',canApprove:async ({actor})=>actor==='manager-1'});
  const cleanup=()=>{journal.close();rmSync(dir,{recursive:true,force:true})};
  return { registry,journal,runtime,writes,cleanup };
}

const anomaly=()=>({type:'unusual_relationship',summary:'Inactive customer has recent activity',evidenceRefs:['crm:account-17','billing:invoice-3'],explanation:'Investigate before changing the customer'});

function prepare(runtime){
 const finding=runtime.discover(anomaly());
 runtime.decideDiscovery(finding.id,{decision:'investigate',actor:'analyst-1'});
 const plan=runtime.proposePlan(finding.id,{title:'Correct CRM status',steps:[{tool:'crm.update_account',args:{id:'account-17',status:'Active'},reason:'Billing team confirmed the account is current'}]});
 return {finding,plan};
}

test('agent hypotheses are saved; decision 1 never writes and unchanged findings are not duplicated',()=>{
 const s=setup();try{
  const f=s.runtime.discover(anomaly());assert.equal(f.state,'discovered');
  const repeated=s.runtime.discover({...anomaly(),summary:'Different wording'});
  assert.equal(repeated.id,f.id);assert.equal(repeated.repeated,true);
  s.runtime.decideDiscovery(f.id,{decision:'monitor',actor:'analyst-1'});
  assert.equal(s.writes.length,0);
 }finally{s.cleanup()}
});

test('decision 2 rejects unauthorized manager or missing scopes; zero writes',async()=>{
 const s=setup();try{
  const {finding,plan}=prepare(s.runtime);
  await assert.rejects(s.runtime.decidePlan(finding.id,{planId:plan.id,decision:'approve',actor:'stranger',context:{scopes:['crm:write']}}),/not authorized/);
  await assert.rejects(s.runtime.decidePlan(finding.id,{planId:plan.id,decision:'approve',actor:'manager-1'}),/Missing authorized scope/);
  assert.equal(s.writes.length,0);
 }finally{s.cleanup()}
});

test('approved plan runs exact capability and verifies once, never repeats on a second call',async()=>{
 const s=setup();try{
  const {finding,plan}=prepare(s.runtime);
  await s.runtime.decidePlan(finding.id,{planId:plan.id,decision:'approve',actor:'manager-1',context:{scopes:['crm:write']}});
  assert.equal(s.writes.length,0);
  const result=await s.runtime.execute(finding.id);
  assert.equal(result.state,'applied');assert.equal(s.writes.length,1);
  await assert.rejects(s.runtime.execute(finding.id),/No approved plan/);
  assert.equal(s.writes.length,1);
  const history=s.journal.history(finding.id);assert.ok(history.some(x=>x.event==='plan:applied'));
 }finally{s.cleanup()}
});

test('agent cannot invent tools or pass credentials through action plans',()=>{
 const s=setup();try{
  const f=s.runtime.discover(anomaly());s.runtime.decideDiscovery(f.id,{decision:'investigate',actor:'analyst'});
  assert.throws(()=>s.runtime.proposePlan(f.id,{title:'invented',steps:[{tool:'crm.delete_everything',args:{},reason:'Oops'}]}),/has not been installed/);
  assert.throws(()=>s.runtime.proposePlan(f.id,{title:'secret',steps:[{tool:'crm.update_account',args:{id:'a',status:'Active',api_key:'bad'},reason:'Oops'}]}),/Credentials must be supplied/);
  assert.equal(s.writes.length,0);
 }finally{s.cleanup()}
});

test('outbound activity failing verification stops safely and refuses automatic retry',async()=>{
 const s=setup();try{
  s.registry.register({id:'mail.send_message',description:'Send mail',mode:'notify',validate:a=>typeof a.to==='string',
   execute:async()=>{s.writes.push('sent');return {ok:false}},verify:async()=>false});
  const f=s.runtime.discover(anomaly());s.runtime.decideDiscovery(f.id,{decision:'investigate',actor:'analyst'});
  const p=s.runtime.proposePlan(f.id,{title:'email finance',steps:[{tool:'mail.send_message',args:{to:'finance@example.test'},reason:'Request review'}]});
  await s.runtime.decidePlan(f.id,{planId:p.id,decision:'approve',actor:'manager-1'});
  await assert.rejects(s.runtime.execute(f.id),/verification failed/);
  await assert.rejects(s.runtime.execute(f.id),/manual investigation/);
  assert.equal(s.writes.length,1);
 }finally{s.cleanup()}
});

test('discovery rejection persists and prevents plan creation',()=>{
 const s=setup();try{
  const f=s.runtime.discover(anomaly());s.runtime.decideDiscovery(f.id,{decision:'dismiss',actor:'analyst'});
  assert.throws(()=>s.runtime.proposePlan(f.id,{title:'bad',steps:[]}),/Decision 1 must allow/);
  assert.equal(s.journal.get(f.id).state,'dismissed');
 }finally{s.cleanup()}
});
