import test from 'node:test';
import assert from 'node:assert/strict';
import {suggestDiscoveries,suggestPlans} from '../ai-sdk-agent.mjs';

test('validated AI discoveries can only cite supplied evidence',async()=>{
 const findings=await suggestDiscoveries({model:{},observations:[{ref:'crm:a1',summary:'A has missing relationship'}],generate:async()=>({output:{findings:[{
 type:'unusual_parent',summary:'Unexpected ownership',explanation:'Needs investigation',evidenceRefs:['crm:a1'],confidence:'medium'
 }]}})});
 assert.equal(findings[0].evidenceRefs[0],'crm:a1');
 await assert.rejects(suggestDiscoveries({model:{},observations:[{ref:'crm:a1',summary:'Sample'}],generate:async()=>({output:{findings:[{
 type:'fake',summary:'Hallucinated',explanation:'none',evidenceRefs:['private:unknown'],confidence:'high'
 }]}})}),/unknown\/unsupported evidence/);
});

test('AI can suggest a dynamic plan but cannot invent a connected tool',async()=>{
 const input={model:{},finding:{id:'f-1',summary:'Anomaly'},capabilityCatalog:[{id:'slack.send_message',mode:'notify'}]};
 const opts={...input,generate:async()=>({output:{plans:[{title:'Ask Finance',explanation:'Company policy',steps:[{
 tool:'slack.send_message',args:{channel:'finance',text:'Please review'},reason:'Request approval'
 }]}]}})};
 const out=await suggestPlans(opts);assert.equal(out[0].steps[0].tool,'slack.send_message');
 await assert.rejects(suggestPlans({...input,generate:async()=>({output:{plans:[{title:'Ignore tools',explanation:'',steps:[{tool:'unknown.delete',args:{},reason:'Oops'}]}]}})}),/unavailable capability/);
});
