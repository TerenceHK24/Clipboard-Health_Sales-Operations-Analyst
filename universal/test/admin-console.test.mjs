import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CompanyPolicyStore } from '../admin/policy-store.mjs';
import { startCompanyAdminConsole } from '../admin/console.mjs';
import { CapabilityRegistry } from '../core.mjs';

function setup(){const dir=mkdtempSync(join(tmpdir(),'company-admin-test-'));
 const registry=new CapabilityRegistry().register({id:'erp.update_customer',description:'Update ERP customer',mode:'write',requiredScopes:['erp:write'],
  validate:a=>typeof a.id==='string',execute:async a=>a,verify:async()=>true});
 const policy=new CompanyPolicyStore(join(dir,'settings.sqlite'),'business-one');
 const done=()=>{policy.close();rmSync(dir,{recursive:true,force:true})};
 return {dir,registry,policy,done};
}

test('IT policy is denied by default and cannot enable a tool not installed in SDK',()=>{
 const s=setup();try{
  assert.equal(s.policy.canApprove({actor:'slack:T1:U1',plan:{steps:[{tool:'erp.update_customer'}]},registry:s.registry}),false);
  assert.throws(()=>s.policy.upsertCapability({id:'erp.delete_all',enabled:true,roles:['manager'],registry:s.registry,actor:'it-admin'}),/preinstalled capability/);
  assert.throws(()=>s.policy.upsertConnection({id:'erp',provider:'netsuite',displayName:'ERP',secretRef:'real-secret-key',actor:'it-admin'}),/vault:\/\//);
 }finally{s.done()}
});

test('IT can configure a vault reference, verify via trusted probe, and allocate manager permissions',()=>{
 const s=setup();try{
  s.policy.upsertConnection({id:'finance',provider:'erp',displayName:'Finance',secretRef:'vault://finance/erp',scopes:['erp:write'],actor:'it-admin'});
  s.policy.upsertCapability({id:'erp.update_customer',enabled:true,connectionId:'finance',roles:['manager'],registry:s.registry,actor:'it-admin'});
  s.policy.setSlackUser({teamId:'T111',userId:'U222',role:'manager',scopes:['erp:write'],actor:'it-admin'});
  const actor='slack:T111:U222',plan={steps:[{tool:'erp.update_customer'}]};
  assert.equal(s.policy.canApprove({actor,plan,registry:s.registry}),false,'connection is not verified');
  s.policy.setConnectionState('finance','verified','it-admin');
  assert.equal(s.policy.canApprove({actor,plan,registry:s.registry}),true);
  const snapshot=s.policy.snapshot(s.registry);
  assert.equal(snapshot.connections[0].has_secret_ref,true);
  assert.equal(JSON.stringify(snapshot).includes('vault://finance/erp'),false,'never expose vault locator in UI');
  assert.equal(readFileSync(join(s.dir,'settings.sqlite')).includes(Buffer.from('my-real-token')),false);
 }finally{s.done()}
});

test('IT admin console serves local configuration, blocks cross-origin writes and rejects raw credentials',async()=>{
 const s=setup();let consoleServer;
 try{
  consoleServer=await startCompanyAdminConsole({registry:s.registry,policyStore:s.policy,connectionProbes:{erp:async c=>c.secret_ref==='vault://finance/erp'}});
  const origin=consoleServer.origin,headers={'X-Admin-Key':consoleServer.key,'Content-Type':'application/json',Origin:origin};
  assert.equal((await fetch(origin+'/')).status,200);
  assert.equal((await fetch(origin+'/api/config')).status,401);
  let response=await fetch(origin+'/api/connection',{method:'POST',headers:{...headers,Origin:'https://evil.invalid'},body:JSON.stringify({id:'finance',provider:'erp',displayName:'Finance'})});
  assert.equal(response.status,403);
  response=await fetch(origin+'/api/connection',{method:'POST',headers,body:JSON.stringify({id:'finance',provider:'erp',displayName:'Finance',apiKey:'forbidden'})});
  assert.equal(response.status,400);
  response=await fetch(origin+'/api/connection',{method:'POST',headers,body:JSON.stringify({id:'finance',provider:'erp',displayName:'Finance',secretRef:'vault://finance/erp',scopes:['erp:write']})});
  assert.equal(response.status,200);
  assert.equal(s.policy.connection('finance').state,'unverified');
  response=await fetch(origin+'/api/test',{method:'POST',headers,body:JSON.stringify({id:'finance'})});
  assert.equal(response.status,200);
  assert.equal(s.policy.connection('finance').state,'verified');
  response=await fetch(origin+'/api/capability',{method:'POST',headers,body:JSON.stringify({id:'erp.update_customer',enabled:true,connectionId:'finance',roles:['manager']})});
  assert.equal(response.status,200);
  response=await fetch(origin+'/api/approver',{method:'POST',headers,body:JSON.stringify({teamId:'T111',userId:'U222',role:'manager',scopes:['erp:write']})});
  assert.equal(response.status,200);
  assert.equal(s.policy.canApprove({actor:'slack:T111:U222',plan:{steps:[{tool:'erp.update_customer'}]},registry:s.registry}),true);
  response=await fetch(origin+'/api/config',{headers:{'X-Admin-Key':consoleServer.key}});const data=await response.json();
  assert.equal(data.connections.length,1);assert.equal(data.slackUsers.length,1);assert.equal(data.capabilities[0].policy.enabled,true);
 }finally{if(consoleServer)await consoleServer.close();s.done()}
});
