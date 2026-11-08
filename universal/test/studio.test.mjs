import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SourceCatalog} from '../platform/sources.mjs';
import {DurableQueue} from '../platform/queue.mjs';
import {CompanyPolicyStore} from '../admin/policy-store.mjs';
import {ConnectorTemplateStore} from '../connectors/templates.mjs';
import {CapabilityRegistry,SqliteJournal,GovernedAgentRuntime} from '../core.mjs';
import {startOperationsStudio} from '../studio/server.mjs';

async function setup(){
 const dir=mkdtempSync(join(tmpdir(),'ops-studio-test-')),tenantId='test-company',storeFile=name=>join(dir,name+'.sqlite');
 const sourceCatalog=new SourceCatalog({path:storeFile('source'),tenant:tenantId});
 const policyStore=new CompanyPolicyStore(storeFile('policy'),tenantId);
 const journal=new SqliteJournal(storeFile('journal'));
 const queue=new DurableQueue(storeFile('queue'));
 const templates=new ConnectorTemplateStore(storeFile('templates'),tenantId);
 const writes=[];
 const registry=new CapabilityRegistry().register({id:'demo.update',description:'Synthetic CRM update',mode:'write',requiredScopes:['demo:write'],
  validate:a=>typeof a.id==='string'&&typeof a.status==='string',execute:async a=>{writes.push(a);return {ok:true}},verify:async()=>true});
 policyStore.upsertCapability({id:'demo.update',enabled:true,roles:['admin'],registry,actor:'test-admin'});
 const runtime=new GovernedAgentRuntime({registry,journal,tenantId,
   canApprove:({actor})=>actor==='local:administrator',canExecute:({actor})=>actor==='local:administrator'});
 const app=await startOperationsStudio({runtime,registry,journal,policyStore,sourceCatalog,queue,templates,tenantId,
   credentialResolver:async()=>{throw Error('no real credentials')},adminScopes:['demo:write'],port:0});
 const api=async(path,body,extraHeaders={})=>{
  const res=await fetch(app.origin+path,{method:body===undefined?'GET':'POST',headers:{'X-Studio-Key':app.key,
   ...(body!==undefined?{'Content-Type':'application/json',Origin:app.origin}:{}),...extraHeaders},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  return {status:res.status,data:await res.json()};
 };
 const close=async()=>{await app.close();sourceCatalog.close();policyStore.close();journal.db.close();queue.close();templates.close();rmSync(dir,{recursive:true,force:true})};
 return {app,api,close,writes,queue};
}
test('Studio local admin UI is accessible but all business API data requires authentication',async()=>{
 const s=await setup();try{
  const home=await fetch(s.app.origin+'/');assert.equal(home.status,200);const html=await home.text();
  assert.match(html,/Find the unusual/);assert.match(html,/Access & policies/);
  assert.equal((await fetch(s.app.origin+'/api/state')).status,401);
  const bad=await s.api('/api/import',{id:'crm',title:'CRM',rows:[]},{Origin:'https://evil.invalid'});assert.equal(bad.status,403);
  assert.equal((await s.api('/api/state')).status,200);
 }finally{await s.close()}
});
test('Studio end-to-end: import -> compare -> investigate -> plan -> confirm -> execute -> audit',async()=>{
 const s=await setup();try{
  let r=await s.api('/api/import',{id:'crm',title:'CRM',rows:[{id:'A',status:'Inactive'},{id:'B',status:'Active'}]});assert.equal(r.status,200);assert.equal(r.data.profile.rowCount,2);
  r=await s.api('/api/import',{id:'erp',title:'ERP',rows:[{id:'A',status:'Active'},{id:'B',status:'Active'}]});assert.equal(r.status,200);
  r=await s.api('/api/compare',{left:'crm',right:'erp',leftKey:'id',rightKey:'id',fields:[{left:'status',right:'status'}]});
  assert.equal(r.data.created,1);const findingId=r.data.findings[0];
  r=await s.api('/api/decision1',{id:findingId,decision:'investigate'});assert.equal(r.status,200);
  r=await s.api('/api/plan',{findingId,title:'Correct synthetic status',steps:[{tool:'demo.update',args:{id:'A',status:'Active'},reason:'Human validated change'}]});
  assert.equal(r.status,200);const planId=r.data.plan.id;
  assert.equal(s.writes.length,0);
  r=await s.api('/api/decision2',{findingId,planId,decision:'approve'});assert.equal(r.status,200);
  assert.equal(s.writes.length,0);
  r=await s.api('/api/execute',{findingId});assert.equal(r.status,200);assert.equal(r.data.job.state,'queued');
  r=await s.api('/api/queue-drain',{});assert.equal(r.status,200);assert.equal(r.data.processed,1);
  assert.deepEqual(s.writes,[{id:'A',status:'Active'}]);
  r=await s.api('/api/state');assert.equal(r.data.findings[0].state,'applied');assert.equal(r.data.jobs[0].state,'done');
  r=await s.api('/api/audit?id='+findingId);assert.ok(r.data.events.some(x=>x.event==='plan:applied'));
  r=await s.api('/api/execute',{findingId});assert.equal(r.status,400);assert.equal(s.writes.length,1);
 }finally{await s.close()}
});
test('Studio rejects credentials hidden in plan and no vault storage without a configured master key',async()=>{
 const s=await setup();try{
  let r=await s.api('/api/secret',{ref:'vault://test/key',value:'not-allowed'});assert.equal(r.status,400);
  r=await s.api('/api/import',{id:'source',title:'Source',rows:[{id:'A'}]});assert.equal(r.status,200);
  r=await s.api('/api/analyze',{id:'source'});assert.equal(r.status,200);
  r=await s.api('/api/plan',{findingId:'not-a-finding',title:'Unauthorized',steps:[{tool:'demo.update',args:{id:'A',password:'not-safe'},reason:'Bad'}]});
  assert.equal(r.status,400);assert.match(r.data.error,/Credentials|Finding/);
 }finally{await s.close()}
});
test('Source evidence is version-pinned, accessible only in local session, and stale approvals fail closed',async()=>{
 const s=await setup();try{
  const left=[{id:'1',status:'Inactive'}],right=[{id:'1',status:'Active'}];
  await s.api('/api/import',{id:'crm',title:'CRM',rows:left});await s.api('/api/import',{id:'erp',title:'ERP',rows:right});
  const d=await s.api('/api/compare',{left:'crm',right:'erp',leftKey:'id',rightKey:'id',fields:[{left:'status',right:'status'}]});
  const id=d.data.findings[0];const ev=await s.api('/api/evidence?id='+id);
  assert.equal(ev.status,200);assert.equal(ev.data.entries[0].value.status,'Inactive');
  await s.api('/api/decision1',{id,decision:'investigate'});
  const p=await s.api('/api/plan',{findingId:id,title:'Update',steps:[{tool:'demo.update',args:{id:'1',status:'Active'},reason:'Confirmed comparison'}]});
  await s.api('/api/import',{id:'crm',title:'CRM',rows:[{id:'1',status:'Active'}]});
  const stale=await s.api('/api/decision2',{findingId:id,planId:p.data.plan.id,decision:'approve'});
  assert.equal(stale.status,400);assert.match(stale.data.error,/Evidence changed/);
  assert.equal(s.writes.length,0);
  const changed=await s.api('/api/evidence?id='+id);
  assert.match(JSON.stringify(changed.data),/snapshot changed/);
 }finally{await s.close()}
});

test('IT can select model and AI key reference without storing raw key',async()=>{
 const s=await setup();try{
  let r=await s.api('/api/ai-config',{provider:'openai',model:'my-model',secretRef:'env://OPS_TEST_AI_KEY',approvalContext:false});
  assert.equal(r.status,200);r=await s.api('/api/state');assert.equal(r.data.aiSettings.provider,'openai');
  assert.ok(!JSON.stringify(r.data).includes('OPS_TEST_AI_KEY'));
 }finally{await s.close()}
});
