import test from 'node:test';
import assert from 'node:assert/strict';
import {CapabilityRegistry,SqliteJournal,GovernedAgentRuntime} from '../core.mjs';
import {registerMcpCapabilities} from '../adapters/mcp.mjs';
import {registerRestCapability} from '../adapters/rest.mjs';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';

test('MCP tool discovery does not automatically give permission to execute tools',async()=>{
 let invoked=0;const client={listTools:async()=>({tools:[{name:'search',description:'Search'},{name:'deleteAll',description:'Destructive'}]}),callTool:async()=>{invoked++;return {items:[]}}};
 const registry=new CapabilityRegistry();const installed=await registerMcpCapabilities({registry,client,namespace:'company',policies:{search:{enabled:true,mode:'read',validate:()=>true}}});
 assert.deepEqual(installed,['mcp.company.search']);assert.equal(registry.get('mcp.company.deleteall'),undefined);
 await registry.read(installed[0],{},{});assert.equal(invoked,1);
});

test('MCP side effects are denied without an independent verifier',async()=>{
 const client={listTools:async()=>({tools:[{name:'update'}]})};const registry=new CapabilityRegistry();
 await assert.rejects(registerMcpCapabilities({registry,client,namespace:'company',policies:{update:{enabled:true,mode:'write',validate:()=>true}}}),/read-back verification/);
});

test('REST connector keeps token in runtime, restricts endpoint and verifies effectful writes',async()=>{
 const calls=[],registry=new CapabilityRegistry();
 registerRestCapability({registry,id:'crm.patch_customer',description:'Patch verified account',baseUrl:'https://crm.example.test',method:'PATCH',path:'/api/accounts/{id}',
   scopes:['crm:write'],validate:a=>a.id==='abc'&&typeof a.body?.name==='string',credentialResolver:async context=>context?.secrets?.crm,
   verify:async (_args,result)=>result?.status==='verified',fetchImpl:async(url,opts)=>{
    calls.push({url:url.toString(),auth:opts.headers.Authorization,body:opts.body});return {ok:true,json:async()=>({status:'verified'})};
   }});
 const dir=mkdtempSync(join(tmpdir(),'test-rest-'));const journal=new SqliteJournal(join(dir,'db.sqlite'));
 try{
  const rt=new GovernedAgentRuntime({registry,journal,tenantId:'tenant',canApprove:({actor})=>actor==='manager'});
  const f=rt.discover({type:'address_mismatch',summary:'Account name requires correction',evidenceRefs:['source:a','crm:abc']});
  rt.decideDiscovery(f.id,{decision:'investigate',actor:'auditor'});
  const p=rt.proposePlan(f.id,{title:'Update account',steps:[{tool:'crm.patch_customer',args:{id:'abc',body:{name:'Corrected'}},reason:'Verified authoritative source'}]});
  await rt.decidePlan(f.id,{planId:p.id,decision:'approve',actor:'manager',context:{scopes:['crm:write']}});
  await rt.execute(f.id,{context:{secrets:{crm:'in-memory-token'}}});
  assert.equal(calls.length,1);assert.match(calls[0].url,/\/api\/accounts\/abc$/);
  assert.equal(calls[0].auth,'Bearer in-memory-token');
  const dbBytes=journal.db.prepare('SELECT data FROM findings').all().map(x=>x.data).join('');assert.ok(!dbBytes.includes('in-memory-token'));
 }finally{journal.close();rmSync(dir,{recursive:true,force:true})}
});
