/** Safe local demo. Only synthetic tool executors are installed here. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CapabilityRegistry } from '../core.mjs';
import { CompanyPolicyStore } from '../admin/policy-store.mjs';
import { startCompanyAdminConsole } from '../admin/console.mjs';
const registry=new CapabilityRegistry()
  .register({id:'demo.read_account',description:'Synthetic CRM account read',mode:'read',requiredScopes:['crm:read'],
    validate:a=>typeof a?.id==='string',execute:async a=>({id:a.id,name:'Example Company'})})
  .register({id:'demo.update_account',description:'Synthetic CRM account update (no real systems)',mode:'write',requiredScopes:['crm:write'],
    validate:a=>typeof a?.id==='string',execute:async a=>({...a,simulated:true}),verify:async (_a,r)=>r.simulated===true});
const journalPath=join(homedir(),'.universal-agent-demo','policy.sqlite');
const policyStore=new CompanyPolicyStore(journalPath,'example-company');
const app=await startCompanyAdminConsole({registry,policyStore,
  connectionProbes:{demo:async c=>c.provider==='demo'},port:4311});
console.log(`\nUniversal Agent · IT Console (synthetic demo only)\n${app.url}\n\nOnly demo connectors are available; no company CRM writes are possible.\nStop with Ctrl+C.`);
let stopped=false;
const stop=async()=>{if(stopped)return;stopped=true;await app.close();policyStore.close();process.exitCode=0};
process.on('SIGINT',()=>{stop().catch(console.error)});
process.on('SIGTERM',()=>{stop().catch(console.error)});
