import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {profileDataset,suggestMappings,reconcileDatasets,analyzeDataset} from '../discovery/engine.mjs';
import {LocalVault,parseMasterKey,makeCredentialResolver} from '../platform/vault.mjs';
import {DurableQueue} from '../platform/queue.mjs';

test('profiles unknown schemas and proposes mappings without assuming identity',()=>{
 const a=profileDataset([{billing_city:'Akron',account_id:'1'},{billing_city:'Cleveland',account_id:'2'}]);
 const b=profileDataset([{city:'Akron',id:'1'},{city:'Cleveland',id:'2'}]);
 assert.equal(a.rowCount,2);assert.ok(suggestMappings(a,b).some(m=>m.left==='billing_city'&&m.right==='city'));
});
test('cross-source reconciliation reports discrepancies but never chooses authority',()=>{
 const r=reconcileDatasets({leftId:'crm',rightId:'erp',left:[{id:'A',name:'Acme',status:'Inactive'}],right:[{id:'A',name:'Acme',status:'Active'}],leftKey:'id',rightKey:'id',fields:[{left:'status',right:'status'}]});
 assert.equal(r.findings.length,1);assert.equal(r.findings[0].type,'cross_source_mismatch');assert.match(r.findings[0].explanation,/Neither system/);
});
test('duplicate IDs and missing schema cannot lead to guessed matching',()=>{
 const d=analyzeDataset({sourceId:'accounts',rows:[{id:'1'},{id:'1'}],primaryKey:'id'});assert.ok(d.findings.some(f=>f.type==='duplicate_identity'));
 const r=reconcileDatasets({left:[{id:'A',name:'A'}],right:[{id:'A'}],leftKey:'id',rightKey:'id',fields:[{left:'name',right:'name'}]});
 assert.equal(r.findings[0].type,'schema_drift');
});
test('AES-GCM vault encrypts, persists, isolates tenants, never serializes master key',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ops-vault-'));const file=join(dir,'vault.sqlite');const key=parseMasterKey('c'.repeat(64));
 try{const a=new LocalVault({path:file,tenant:'alpha',key});a.set('vault://crm/private','TOP-SENSITIVE-VALUE');
  assert.equal(a.get('vault://crm/private'),'TOP-SENSITIVE-VALUE');assert.ok(!readFileSync(file).includes(Buffer.from('TOP-SENSITIVE-VALUE')));
  const resolver=makeCredentialResolver({vault:a,env:{OPS_TEST:'FROM-ENV'}});
  assert.equal(await resolver('env://OPS_TEST'),'FROM-ENV');assert.equal(await resolver('vault://crm/private'),'TOP-SENSITIVE-VALUE');
  a.close();const reopened=new LocalVault({path:file,tenant:'alpha',key});assert.equal(reopened.get('vault://crm/private'),'TOP-SENSITIVE-VALUE');reopened.close();
  const b=new LocalVault({path:file,tenant:'beta',key});assert.throws(()=>b.get('vault://crm/private'));b.close();
 }finally{rmSync(dir,{recursive:true,force:true})}
});
test('durable job deduplication, quarantine and single-execution semantics',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ops-queue-'));const q=new DurableQueue(join(dir,'jobs.sqlite'));
 try{const a=q.enqueue({tenant:'x',kind:'execute-plan',payload:{findingId:'a'},dedupeKey:'a'});
  const b=q.enqueue({tenant:'x',kind:'execute-plan',payload:{findingId:'a'},dedupeKey:'a'});assert.equal(a.id,b.id);
  let calls=0;await q.drain({'execute-plan':async()=>{calls++}});assert.equal(calls,1);await q.drain({'execute-plan':async()=>{calls++}});assert.equal(calls,1);
  q.enqueue({tenant:'x',kind:'execute-plan',payload:{findingId:'b'}});q.claim();assert.equal(q.quarantineInterrupted(),1);
 }finally{q.close();rmSync(dir,{recursive:true,force:true})}
});
import {SourceCatalog,loadRestDataset} from '../platform/sources.mjs';
import {PROVIDERS} from '../platform/provider-catalog.mjs';

test('source catalogs are encrypted when persistent; ephemeral without master key',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ops-source-'));const path=join(dir,'sources.sqlite'),key=parseMasterKey('b'.repeat(64));
 try{
  const c=new SourceCatalog({path,tenant:'tenant-one',key});c.put({id:'sales',title:'Sales source',rows:[{id:'C1',revenue:2000}]});
  assert.ok(!readFileSync(path).includes(Buffer.from('C1')),'raw customer ID must not be exposed in source store');
  assert.equal(c.get('sales').rows[0].revenue,2000);c.close();
  const reopen=new SourceCatalog({path,tenant:'tenant-one',key});assert.equal(reopen.list().length,1);reopen.close();
  const demo=new SourceCatalog({path:join(dir,'no-database.sqlite'),tenant:'tenant-one'});demo.put({id:'demo',title:'Temporary',rows:[]});assert.equal(demo.list().length,1);demo.close();
  assert.equal(readFileSync(path).includes(Buffer.from('C1')),false);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
test('generic REST source enforces HTTPS, fixed endpoint, data validation',async()=>{
 const rows=[{id:'1',status:'Active'}];
 const returned=await loadRestDataset({url:'https://example.test/api/v1/records',fetchImpl:async()=>({ok:true,headers:{get:()=> 'application/json'},text:async()=>JSON.stringify({results:rows})})});
 assert.deepEqual(returned,rows);
 await assert.rejects(loadRestDataset({url:'http://remote.test/api/v1/records'}),/HTTP only allowed/);
 await assert.rejects(loadRestDataset({url:'https://example.test/v1',extract:'bad.path',fetchImpl:async()=>({ok:true,headers:{get:()=> 'application/json'},text:async()=>JSON.stringify({other:[]})})}),/Cannot locate/);
});
test('provider catalog communicates readiness instead of inventing live integrations',()=>{
 assert.ok(PROVIDERS.some(x=>x.id==='teams'&&x.status==='template'));
 assert.ok(PROVIDERS.some(x=>x.id==='mcp'&&x.status==='adapter'));
});
import {ConnectorTemplateStore,registerTemplate} from '../connectors/templates.mjs';
import {CapabilityRegistry} from '../core.mjs';
import {CompanyPolicyStore} from '../admin/policy-store.mjs';

test('configurable REST connector enforces permissions and verifies writes with readback',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ops-template-'));
 const template=new ConnectorTemplateStore(join(dir,'templates.sqlite'),'tenanta');const policy=new CompanyPolicyStore(join(dir,'policy.sqlite'),'tenanta');
 try{
  policy.upsertConnection({id:'crm',provider:'rest',displayName:'Mock CRM',secretRef:'vault://test/crm',scopes:['crm:write'],settings:{baseUrl:'https://example.test/'},actor:'it-admin'});
  policy.setConnectionState('crm','verified','it-admin');
  const m=template.set({id:'crm.update',connectionId:'crm',method:'PATCH',path:'/api/customer/{id}',verifyPath:'/api/customer/{id}',description:'Update mocked account',scopes:['crm:write']});
  const registry=new CapabilityRegistry(),sent=[];
  registerTemplate({registry,manifest:m,policyStore:policy,credentialResolver:async()=> 'SANDBOX-TOKEN',fetchImpl:async(u,opts)=>{
   sent.push({url:u.href,method:opts.method,auth:opts.headers.Authorization});return {ok:true,text:async()=>JSON.stringify({status:'Active'})};
  }});
  const cap=registry.get('crm.update'),input={id:'001',body:{status:'Active'}};
  const result=await cap.execute(input);assert.equal(await cap.verify(input,result),true);assert.deepEqual(sent.map(x=>x.method),['PATCH','GET']);
  assert.ok(sent.every(x=>x.auth==='Bearer SANDBOX-TOKEN'));
  policy.setConnectionState('crm','needs_attention','it-admin');await assert.rejects(cap.execute(input),/not verified/);
 }finally{template.close();policy.close();rmSync(dir,{recursive:true,force:true})}
});

test('agent-independent profiler detects numeric outliers and circular relationships',()=>{
 const records=Array.from({length:12},(_,i)=>({id:String(i),parent_id:i===0?'1':i===1?'0':'',value:i===11?100000:100+i}));
 const result=analyzeDataset({sourceId:'ops_data',rows:records,primaryKey:'id'});
 assert.ok(result.findings.some(x=>x.type==='relationship_cycle'));
 assert.ok(result.findings.some(x=>x.type==='numeric_outlier'));
});

import {SqliteJournal as EncryptedJournal} from '../core.mjs';
test('business finding, plan and action receipts are encrypted when master key exists',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ops-journal-encrypted-')),path=join(dir,'journal.sqlite'),key=parseMasterKey('e'.repeat(64));
 try{const journal=new EncryptedJournal(path,{key});journal.save({id:'finding-1',tenant:'tenant',fingerprint:'f',data:{summary:'PRIVATE-ACCOUNT-123',plans:[]},discovery_decision:null,state:'discovered',selected_plan:null,approved_by:null});
  assert.equal(journal.get('finding-1').data.summary,'PRIVATE-ACCOUNT-123');
  assert.ok(!readFileSync(path).includes(Buffer.from('PRIVATE-ACCOUNT-123')));journal.close();
  const reopened=new EncryptedJournal(path,{key});assert.equal(reopened.list('tenant')[0].data.summary,'PRIVATE-ACCOUNT-123');reopened.close();
 }finally{rmSync(dir,{recursive:true,force:true})}
});
