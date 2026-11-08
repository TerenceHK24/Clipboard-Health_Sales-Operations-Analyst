/** Run a complete self-hosted local-first agent with a real optional Slack callback.
 * Never installs external SaaS credentials or exposes the admin UI to the internet.
 */
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {CapabilityRegistry,SqliteJournal,GovernedAgentRuntime} from '../core.mjs';
import {SourceCatalog} from '../platform/sources.mjs';
import {LocalVault,parseMasterKey,makeCredentialResolver} from '../platform/vault.mjs';
import {DurableQueue} from '../platform/queue.mjs';
import {OAuthBroker,createOAuthCredentialResolver} from '../platform/oauth.mjs';
import {CompanyPolicyStore} from '../admin/policy-store.mjs';
import {ConnectorTemplateStore,registerTemplate} from '../connectors/templates.mjs';
import {probeConnection} from '../connectors/probes.mjs';
import {RichSlackApprovalGateway,SlackApprovalStore} from '../adapters/slack-workflow.mjs';
import {createSlackInteractionHandler} from '../adapters/slack-receiver.mjs';
import {startOperationsStudio} from './server.mjs';
import {suggestDiscoveries,suggestPlans,createOwnKeyModel,answerReviewQuestion} from '../ai/ai-sdk-agent.mjs';
import {readFile} from 'node:fs/promises';
const log=(...args)=>console.log(...args);
const tenant=process.env.OPS_AGENT_TENANT||'my-company';
const dataDir=resolve(process.env.OPS_AGENT_DATA_DIR||join(homedir(),'.universal-operations',tenant));
const key=parseMasterKey(process.env.OPS_AGENT_MASTER_KEY||'');
if(!key&&!process.argv.includes('--demo'))throw Error('Company mode requires OPS_AGENT_MASTER_KEY (64 hex chars). Use --demo for synthetic local testing.');
const adminScopes=(process.env.OPS_AGENT_ADMIN_SCOPES||(process.argv.includes('--demo')?'demo:read,demo:write,demo:notify':'')).split(',').map(x=>x.trim()).filter(Boolean);
const policyStore=new CompanyPolicyStore(join(dataDir,'policy.sqlite'),tenant);
const journal=new SqliteJournal(join(dataDir,'journal.sqlite'),{key});
const sources=new SourceCatalog({path:join(dataDir,'sources.sqlite'),tenant,key});
const vault=key?new LocalVault({path:join(dataDir,'vault.sqlite'),tenant,key}):null;
const resolveRaw=makeCredentialResolver({vault});
const resolveCredential=vault?createOAuthCredentialResolver({vault,resolveRaw}):resolveRaw;
const oauthBroker=vault?new OAuthBroker({vault,policyStore,resolveRaw}):null;
const queue=new DurableQueue(join(dataDir,'queue.sqlite'));
const approvalStore=new SlackApprovalStore(join(dataDir,'slack.sqlite'));
const templates=new ConnectorTemplateStore(join(dataDir,'templates.sqlite'),tenant);
const registry=new CapabilityRegistry();
const demoRows=new Map([['account-1',{id:'account-1',name:'Example customer',status:'Inactive'}]]);
registry.register({id:'demo.read_customer',description:'Read a synthetic example customer',mode:'read',requiredScopes:['demo:read'],
  validate:a=>typeof a?.id==='string',execute:async a=>structuredClone(demoRows.get(a.id)||null)})
  .register({id:'demo.update_customer',description:'Change a synthetic customer record',mode:'write',requiredScopes:['demo:write'],
    validate:a=>typeof a?.id==='string'&&typeof a?.status==='string'&&a.status.length<40,
    execute:async a=>{demoRows.set(a.id,{...demoRows.get(a.id),...a});return {ok:true}},
    verify:async a=>demoRows.get(a.id)?.status===a.status})
  .register({id:'demo.notify',description:'Synthetic manager notification',mode:'notify',requiredScopes:['demo:notify'],
    validate:a=>typeof a?.message==='string'&&a.message.length<400,
    execute:async a=>({accepted:true,messageId:'synthetic'}),verify:async(_a,r)=>r.accepted===true});
for(const m of templates.list()){
  try{registerTemplate({registry,manifest:m,policyStore,credentialResolver:resolveCredential})}
  catch(error){log('A connector could not be restored; needs admin attention:',m.id,error.message)}
}
const isAuthorized=(actor,plan)=>{
  if(typeof actor!=='string'||!plan?.steps?.length)return false;
  if(actor.startsWith('slack:'))return policyStore.canApprove({actor,plan,registry});
  if(actor!=='local:administrator')return false;
  const allowed=new Set(adminScopes);
  return plan.steps.every(step=>{
    const cap=registry.get(step.tool),binding=policyStore.binding(step.tool);
    if(!cap||!binding?.enabled || !binding.approver_roles.includes('admin'))return false;
    if(binding.connection_id && policyStore.connection(binding.connection_id)?.state!=='verified')return false;
    return cap.requiredScopes.every(scope=>allowed.has(scope));
  });
};
const runtime=new GovernedAgentRuntime({registry,journal,tenantId:tenant,
  canApprove:async({actor,plan,finding})=>isAuthorized(actor,plan)&&evidenceFresh(finding?.evidenceRefs),
  canExecute:async({actor,plan,finding})=>isAuthorized(actor,plan)&&evidenceFresh(finding?.evidenceRefs)});
function evidenceFresh(refs=[]){return refs.every(ref=>{
  const m=/^([a-z][a-z0-9_-]{1,59})@([a-f0-9]{64}):/.exec(ref);
  return !m||sources.get(m[1])?.profile?.dataDigest===m[2];
})}
if(process.argv.includes('--demo')){
  if(!policyStore.binding('demo.update_customer')){
    for(const [id,scopes] of [['demo.read_customer',['demo:read']],['demo.update_customer',['demo:write']],['demo.notify',['demo:notify']]])
      policyStore.upsertCapability({id,enabled:true,roles:['admin'],actor:'demo-setup',registry});
    log('Enabled synthetic demo capabilities only. Real services remain disconnected.');
  }
  if(!sources.list().some(x=>x.id==='demo_crm')){
    sources.put({id:'demo_crm',title:'Demo CRM',kind:'demo',rows:[{id:'C1',name:'Example Facility',status:'Inactive',parent_id:'P1'},{id:'C2',name:'Other Office',status:'Active',parent_id:'P1'}]});
    sources.put({id:'demo_erp',title:'Demo Accounting',kind:'demo',rows:[{id:'C1',name:'Example Facility',status:'Active',parent_id:'P2'},{id:'C2',name:'Other Office',status:'Active',parent_id:'P1'}]});
  }
}
const envAi=(process.env.OPS_AI_PROVIDER&&process.env.OPS_AI_MODEL&&process.env.OPS_AI_SECRET_REF)?
  {provider:process.env.OPS_AI_PROVIDER,model:process.env.OPS_AI_MODEL,secretRef:process.env.OPS_AI_SECRET_REF,
   approvalContext:process.env.OPS_AI_ALLOW_APPROVAL_CONTEXT==='1'}:null;
const aiConfig=()=>policyStore.aiSettings()||envAi;
const aiModel=async()=>{
  const conf=aiConfig();if(!conf)throw Error('No AI provider configured. Add your own AI key in Integrations.');
  return createOwnKeyModel({provider:conf.provider,modelId:conf.model,apiKey:await resolveCredential(conf.secretRef)});
};
const ai={isConfigured:()=>!!aiConfig(),
  discover:async obs=>suggestDiscoveries({model:await aiModel(),observations:obs}),
  plans:async(f,c)=>suggestPlans({model:await aiModel(),finding:f,capabilityCatalog:c}),
  answer:async p=>answerReviewQuestion({model:await aiModel(),...p})};
const slackVars=['OPS_SLACK_BOT_TOKEN_REF','OPS_SLACK_SIGNING_SECRET_REF','OPS_SLACK_TEAM_ID','OPS_SLACK_CHANNELS'];
const slackEnabled=slackVars.every(k=>!!process.env[k]);
let slackGateway=null,slackServer=null;
if(slackEnabled){
  const [botToken,signingSecret]=await Promise.all([resolveCredential(process.env.OPS_SLACK_BOT_TOKEN_REF),resolveCredential(process.env.OPS_SLACK_SIGNING_SECRET_REF)]);
  slackGateway=new RichSlackApprovalGateway({botToken,signingSecret,teamId:process.env.OPS_SLACK_TEAM_ID,tenantId:tenant,
    approvalStore,policyStore,registry,queue,allowedChannels:process.env.OPS_SLACK_CHANNELS.split(',').map(x=>x.trim()),
    answerQuestion:async({question,finding,plan})=>{
      if(!ai.isConfigured())return `Evidence: ${finding.evidenceRefs.join(', ')}. The plan contains ${plan.steps.length} step(s). No AI follow-up provider is connected.`;
      if(!aiConfig()?.approvalContext)return 'AI follow-up is configured but not authorized to receive approval summaries. Ask IT to review the evidence disclosure setting.';
      return ai.answer({question,finding,plan});
    }});
}
queue.quarantineInterrupted();
let working=false;
const drain=async()=>{if(working)return;working=true;try{
  await queue.drain({
    'execute-plan':async job=>{
      const f=journal.get(job.payload.findingId);
      if(f?.tenant!==tenant||f.state!=='approved'||f.selected_plan!==job.payload.planId)throw Error('Approved plan is no longer valid');
      await runtime.execute(f.id);
    },
    ...(slackGateway?{'slack-decision':job=>slackGateway.processQueuedDecision(job,runtime)}:{})
  });
}finally{working=false}};
const tick=setInterval(()=>drain().catch(e=>log('Queue worker error:',String(e?.message||e).slice(0,100))),1500);
const probes=Object.fromEntries(['demo','rest','slack','hubspot','gmail','outlook','googlecalendar','salesforce'].map(id=>[id,(c,resolver)=>probeConnection(c,resolver)]));
const port=Number(process.env.OPS_AGENT_PORT||4321);
const app=await startOperationsStudio({runtime,policyStore,registry,sourceCatalog:sources,queue,templates,vault,
  credentialResolver:resolveCredential,connectionProbes:probes,ai,slackGateway,oauthBroker,port,tenantId:tenant,adminScopes});
log(`\nUniversal Operations Agent — ${process.argv.includes('--demo')?'Synthetic demo':'Company mode'}\n${app.url}`);
log(`\nTenant: ${tenant} | Sources: ${sources.db?'encrypted persistent':'ephemeral memory'} | AI: ${ai.isConfigured()?'configured':'not configured'} | Slack: ${slackGateway?'configured':'not configured'}`);
log('Local admin access key is in the URL fragment. Treat it as sensitive. Use Ctrl+C to stop.\n');
if(slackGateway&&process.env.OPS_SLACK_WEBHOOK_PORT){
  const handler=createSlackInteractionHandler({gateway:slackGateway,runtime,onBackgroundError:e=>log('Slack webhook error:',String(e?.message||e).slice(0,120))});
  slackServer=createServer(handler);
  await new Promise((ok,fail)=>{slackServer.once('error',fail);slackServer.listen(Number(process.env.OPS_SLACK_WEBHOOK_PORT),'0.0.0.0',ok)});
  log('Slack webhook listener running. Configure HTTPS/TLS at your reverse proxy for /slack/interactions.');
}
let stopped=false;
const stop=async()=>{if(stopped)return;stopped=true;clearInterval(tick);
  if(slackServer)await new Promise(ok=>slackServer.close(ok));await app.close();
  templates.close();approvalStore.close();queue.close();sources.close();vault?.close();journal.close();policyStore.close();
};
process.on('SIGINT',()=>{stop().then(()=>process.exit(0)).catch(console.error)});
process.on('SIGTERM',()=>{stop().then(()=>process.exit(0)).catch(console.error)});
