/** Offline end-to-end demonstration. Does NOT talk to any external system or LLM. */
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CapabilityRegistry,SqliteJournal,GovernedAgentRuntime} from '../core.mjs';

const dir=mkdtempSync(join(tmpdir(),'universal-agent-demo-'));
const customer={id:'sample-customer',status:'Inactive'};
const registry=new CapabilityRegistry()
  .register({id:'crm.read_customer',mode:'read',description:'Inspect customer information',validate:a=>typeof a.id==='string',execute:async()=>({...customer})})
  .register({id:'crm.update_customer',mode:'write',description:'Update a customer record after approval',requiredScopes:['crm:write'],
    validate:a=>a?.id==='sample-customer' && typeof a.status==='string',
    execute:async args=>{customer.status=args.status;return {...customer}},verify:async args=>customer.status===args.status});
const journal=new SqliteJournal(join(dir,'demo.sqlite'));
const runtime=new GovernedAgentRuntime({registry,journal,tenantId:'synthetic-demo',canApprove:({actor})=>actor==='demo-manager'});
try{
 const evidence=await registry.read('crm.read_customer',{id:'sample-customer'});
 const finding=runtime.discover({type:'unusual_lifecycle',summary:'Inactive record may still be operational',evidenceRefs:['crm:sample-customer'],explanation:'Illustrative hypothesis from local fixtures only'});
 console.log('DECISION 1: Finding needs investigation:',finding.data.summary);
 runtime.decideDiscovery(finding.id,{decision:'investigate',actor:'demo-analyst'});
 const plan=runtime.proposePlan(finding.id,{title:'Example update',explanation:'Illustrative plan; no company-specific final action is hard-coded in the runtime',steps:[{tool:'crm.update_customer',args:{id:evidence.id,status:'Active'},reason:'Synthetic demo validation'}]});
 console.log('DECISION 2: Reviewer approves exact plan:',plan.title);
 await runtime.decidePlan(finding.id,{planId:plan.id,decision:'approve',actor:'demo-manager',context:{scopes:['crm:write']}});
 console.log('Before backend execution:',JSON.stringify(evidence));
 await runtime.execute(finding.id);
 console.log('After verified execution:',JSON.stringify(customer));
 console.log('Audit events:',journal.history(finding.id).map(r=>r.event).join(' → '));
}finally{journal.close();rmSync(dir,{recursive:true,force:true})}
