/** BYOK example: npm install in this directory first. No token is stored. */
import {promptSecret} from './prompt-secret.mjs';
import {createOwnKeyModel,suggestDiscoveries,suggestPlans} from './ai-sdk-agent.mjs';
const provider=process.argv[2]||'openai';
const modelId=process.argv[3];
if(!modelId){console.error('Usage: node example.mjs openai <your-model-id>');process.exit(1)}
const apiKey=await promptSecret();
const model=await createOwnKeyModel({provider,modelId,apiKey});
const observations=[
 {ref:'crm:a1',summary:'Synthetic CRM record status Inactive'},
 {ref:'billing:invoice-2',summary:'Synthetic billing record has new issued invoice for same entity'}
];
const findings=await suggestDiscoveries({model,observations});
console.log(JSON.stringify({findings},null,2));
if(findings.length){
  const plans=await suggestPlans({model,finding:{id:'demo-only',...findings[0]},capabilityCatalog:[{id:'notification.draft_message',mode:'read',description:'Draft a notification without sending'}]});
  console.log('Suggestions only. No action can execute without installation, permission and explicit review.');
  console.log(JSON.stringify({plans},null,2));
}
