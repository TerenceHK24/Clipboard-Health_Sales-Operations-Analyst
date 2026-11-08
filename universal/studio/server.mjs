/** Local-first Operations Studio. No framework, secret, or arbitrary JS in the browser.
 * All sensitive actions require the localhost session key plus same-origin protection.
 */
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {analyzeDataset,reconcileDatasets,profileDataset,suggestMappings,observationsForAgent} from '../discovery/engine.mjs';
import {PROVIDERS} from '../platform/provider-catalog.mjs';
import {loadRestDataset} from '../platform/sources.mjs';
import {registerTemplate,validateTemplate} from '../connectors/templates.mjs';
const FILES={'/':'index.html','/app.js':'app.js','/styles.css':'styles.css'};
const MIME={'html':'text/html','js':'text/javascript','css':'text/css'};
const requireValue=(v,msg)=>{if(!v)throw Error(msg)};
const cleanedError=e=>String(e?.message||'Request failed').replace(/(?:bh_|sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}/g,'[REDACTED]').slice(0,250);
const fixedHost=/^127\.0\.0\.1:\d{1,5}$/;
function isKey(value,key){const x=Buffer.from(typeof value==='string'?value:''),y=Buffer.from(key);return x.length===y.length&&timingSafeEqual(x,y)}
function bodyReader(req,max=1600000){return (async()=>{
  if(req.headers['content-type']?.split(';')[0]!=='application/json')throw Error('Content-Type must be application/json');
  const chunks=[];let total=0;for await(const chunk of req){total+=chunk.length;if(total>max)throw Error('Payload exceeds size limit');chunks.push(chunk)}
  const b=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(!b||typeof b!=='object'||Array.isArray(b))throw Error('JSON object required');
  return b;
})();}
export async function startOperationsStudio({runtime,policyStore,registry,sourceCatalog,queue,templates,vault=null,credentialResolver,
  connectionProbes={},ai=null,slackGateway=null,oauthBroker=null,port=4321,tenantId,host='127.0.0.1',adminScopes=[]}){
  requireValue(runtime&&policyStore&&registry&&sourceCatalog&&queue&&templates&&tenantId,'Studio dependencies required');
  if(host!=='127.0.0.1')throw Error('Studio admin UI is loopback-only; use trusted SSO proxy for remote enterprise access');
  const key=randomBytes(32).toString('hex');
  const localActor='local:administrator';
  const safeCaps=()=>registry.list().map(cap=>({...cap,policy:policyStore.binding(cap.id)}));
  const allFindings=()=>runtime.journal.list(tenantId);
  const summarize=()=>{
    const findings=allFindings();return {tenant:tenantId,findings,
      counts:Object.fromEntries(['discovered','investigating','approved','applied','rejected','dismissed','blocked'].map(st=>[st,findings.filter(f=>f.state===st).length])),
      sources:sourceCatalog.list(),connections:policyStore.snapshot(registry).connections,capabilities:safeCaps(),
      approvers:policyStore.slackUsers(),providers:PROVIDERS,templates:templates.list(),jobs:queue.list(tenantId).slice(0,60),
      aiConfigured:!!ai&&(typeof ai.isConfigured==='function'?ai.isConfigured():true),aiSettings:policyStore.snapshot(registry).aiSettings,slackConfigured:!!slackGateway,oauthAvailable:!!oauthBroker,encryptedSources:!!sourceCatalog.db,vaultAvailable:!!vault};
  };
  const stampRef=ref=>{
    const str=String(ref);const hit=/^([a-z][a-z0-9_-]{1,59}):(row|profile):(.+)$/.exec(str);
    if(!hit)return str;
    const src=sourceCatalog.get(hit[1]);return src?.profile?.dataDigest?`${hit[1]}@${src.profile.dataDigest}:${hit[2]}:${hit[3]}`:str;
  };
  const validateEvidenceFresh=refs=>refs.every(ref=>{
    const hit=/^([a-z][a-z0-9_-]{1,59})@([a-f0-9]{64}):/.exec(ref);
    return !hit || sourceCatalog.get(hit[1])?.profile?.dataDigest===hit[2];
  });
  const emitFindings=items=>{
    const entries=items.map(x=>runtime.discover({type:x.type,summary:x.summary,evidenceRefs:x.evidenceRefs.map(stampRef),
      confidence:x.confidence||'unknown',explanation:x.explanation||''}));
    return {created:entries.filter(x=>!x.repeated).length,repeated:entries.filter(x=>x.repeated).length,findings:entries.map(x=>x.id)};
  };
  const routes={
    '/api/import':async b=>sourceCatalog.put({id:b.id,title:b.title,rows:b.rows,kind:'import'}),
    '/api/load-rest':async b=>{
      const c=policyStore.connection(b.connectionId);
      requireValue(c&&c.state==='verified','Verified connection required');
      requireValue(typeof c.settings?.baseUrl==='string','IT must configure a trusted REST base URL');
      const url=new URL(b.path||'/',c.settings.baseUrl);
      requireValue(url.origin===new URL(c.settings.baseUrl).origin,'Cross-origin source URL blocked');
      const rows=await loadRestDataset({url:url.href,secretRef:c.secret_ref,credentialResolver,extract:b.extract||'rows'});
      return sourceCatalog.put({id:b.id,title:b.title,rows,kind:'rest'});
    },
    '/api/analyze':async b=>{const source=sourceCatalog.get(b.id);requireValue(source,'Unknown source');return {source:b.id,...emitFindings(analyzeDataset({sourceId:b.id,rows:source.rows,primaryKey:b.key||null}).findings)}},
    '/api/compare':async b=>{
      const left=sourceCatalog.get(b.left),right=sourceCatalog.get(b.right);requireValue(left&&right,'Both sources must exist');
      const output=reconcileDatasets({left:left.rows,right:right.rows,leftId:b.left,rightId:b.right,
        leftKey:b.leftKey,rightKey:b.rightKey,fields:b.fields||[]});
      return {suggestedMappings:suggestMappings(left.profile,right.profile),compared:output.compared,...emitFindings(output.findings)};
    },
    '/api/ai-discover':async b=>{
      requireValue(ai?.discover,'Configure an AI provider before requesting discovery');
      const chosen=b.sourceId?sourceCatalog.list().filter(s=>s.id===b.sourceId):sourceCatalog.list();
      requireValue(chosen.length,'Import at least one source first');
      // Deliberately send only field statistics and labels; raw entity values never leave this host.
      const observations=chosen.flatMap(s=>s.profile.fields.map(f=>({ref:`${s.id}:profile:${f.key}`,
        summary:`Source ${s.id}, field ${f.key}, type=${f.type}, null rate=${f.nullRate}, uniqueness=${f.uniqueRatio}, records=${s.profile.rowCount}`}))).slice(0,100);
      return emitFindings(await ai.discover(observations));
    },
    '/api/ai-config':async b=>policyStore.setAiSettings({...b,actor:localActor}),
    '/api/decision1':async b=>{runtime.decideDiscovery(b.id,{decision:b.decision,actor:localActor});return {ok:true}},
    '/api/plan':async b=>{const plan=runtime.proposePlan(b.findingId,{title:b.title,explanation:b.explanation||'',steps:b.steps,author:localActor});return {plan}},
    '/api/ai-plan':async b=>{
      requireValue(ai?.plans,'Configure AI provider to generate action plans');
      const finding=runtime.journal.get(b.findingId);requireValue(finding?.tenant===tenantId,'Unknown finding');
      const allowed=registry.list().filter(c=>policyStore.binding(c.id)?.enabled);
      const plans=await ai.plans({...finding.data,id:finding.id},allowed);
      const created=plans.map(p=>runtime.proposePlan(b.findingId,{...p,author:'agent'}));return {plans:created};
    },
    '/api/decision2':async b=>{const decision=b.decision;requireValue(['approve','reject'].includes(decision),'Invalid decision');
      const f=runtime.journal.get(b.findingId);requireValue(f?.tenant===tenantId&&validateEvidenceFresh(f.data.evidenceRefs),'Evidence changed; rerun discovery before approval');
      await runtime.decidePlan(b.findingId,{planId:b.planId,decision,actor:localActor,context:{scopes:adminScopes}});
      return {ok:true,state:decision==='approve'?'approved':'rejected'};
    },
    '/api/execute':async b=>{
      const finding=runtime.journal.get(b.findingId);
      requireValue(finding?.tenant===tenantId&&finding.state==='approved'&&validateEvidenceFresh(finding.data.evidenceRefs),'An approved plan with current evidence is required');
      const job=queue.enqueue({tenant:tenantId,kind:'execute-plan',payload:{findingId:finding.id,planId:finding.selected_plan},dedupeKey:`execute:${finding.id}:${finding.selected_plan}`});
      return {job:{id:job.id,state:job.state}};
    },
    '/api/queue-drain':async()=>({processed:await queue.drain({
      'execute-plan':async job=>{
        const f=runtime.journal.get(job.payload.findingId);
        requireValue(f?.tenant===tenantId&&f.selected_plan===job.payload.planId,'Selected plan changed');
        await runtime.execute(f.id);
      },
      ...(slackGateway?{'slack-decision':job=>slackGateway.processQueuedDecision(job,runtime)}:{})
    })}),
    '/api/connection':async b=>policyStore.upsertConnection({id:b.id,provider:b.provider,displayName:b.displayName,secretRef:b.secretRef||null,
      scopes:b.scopes||[],settings:b.settings||{},actor:localActor}),
    '/api/connection-test':async b=>{
      const c=policyStore.connection(b.id);requireValue(c,'Unknown connection');
      const probe=connectionProbes[c.provider];requireValue(typeof probe==='function','No verified test implementation for this provider');
      try{requireValue(await probe(c,credentialResolver),'Connector probe did not confirm successful connection');
        policyStore.setConnectionState(c.connector_id,'verified',localActor);
      }catch(e){policyStore.setConnectionState(c.connector_id,'needs_attention',localActor);throw e}
      return {id:c.connector_id,state:'verified'};
    },
    '/api/capability':async b=>policyStore.upsertCapability({id:b.id,connectionId:b.connectionId||null,enabled:b.enabled===true,
      roles:b.roles||['admin'],actor:localActor,registry}),
    '/api/approver':async b=>{policyStore.setSlackUser({...b,actor:localActor});return {ok:true}},
    '/api/secret':async b=>{requireValue(vault,'Configure OPS_AGENT_MASTER_KEY before storing credentials');
      requireValue(typeof b.ref==='string'&&b.ref.startsWith('vault://'),'Use a vault:// reference');
      return vault.set(b.ref,b.value);
    },
    '/api/oauth-start':async b=>{requireValue(oauthBroker,'OAuth requires an encrypted credential vault');
      return oauthBroker.begin({connectorId:b.connectionId,redirectUri:`${origin}/oauth/callback`});
    },
    '/api/template':async b=>{
      const m=validateTemplate(b);requireValue(!registry.get(m.id),'Use a fresh capability ID; changes require a new reviewed version');
      requireValue(policyStore.connection(m.connectionId),'Unknown connection');
      registerTemplate({registry,manifest:m,policyStore,credentialResolver});
      templates.set(m);return {id:m.id,registered:true};
    },
    '/api/slack-publish':async b=>{
      requireValue(slackGateway,'Slack is not connected. Configure and verify the Slack app first');
      return slackGateway.publish({channel:b.channel,findingId:b.findingId,planId:b.planId,runtime,
        risk:b.risk||'Needs review',affected:Math.max(1,Number(b.affected)||1)});
    },
  };
  const server=createServer(async(req,res)=>{
    const send=(code,obj)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY'});res.end(JSON.stringify(obj))};
    try{
      if(!fixedHost.test(req.headers.host||''))return send(403,{error:'Invalid local host'});
      const pathname=new URL(req.url,`http://${req.headers.host}`).pathname;
      if(req.method==='GET'&&pathname==='/oauth/callback'){
        requireValue(oauthBroker,'OAuth not configured');
        const u=new URL(req.url,`http://${req.headers.host}`);
        if(u.searchParams.has('error'))throw Error('OAuth authorization denied; provider returned an error');
        await oauthBroker.callback({state:u.searchParams.get('state'),code:u.searchParams.get('code')});
        res.writeHead(302,{Location:'/?oauth=connected','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
        res.end();return;
      }
      if(req.method==='GET'&&FILES[pathname]){
        const fname=FILES[pathname],file=await readFile(new URL(`./${fname}`,import.meta.url));
        res.writeHead(200,{'Content-Type':`${MIME[fname.split('.').at(-1)]}; charset=utf-8`,'Cache-Control':'no-store',
          'Content-Security-Policy':"default-src 'none'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",'X-Content-Type-Options':'nosniff'});
        res.end(file);return;
      }
      if(!isKey(req.headers['x-studio-key'],key))return send(401,{error:'Open the private Studio URL printed in your terminal'});
      if(req.method==='GET'&&pathname==='/api/state')return send(200,summarize());
      if(req.method==='GET'&&pathname==='/api/evidence'){
        const id=new URL(req.url,`http://${req.headers.host}`).searchParams.get('id');
        const f=allFindings().find(x=>x.id===id);if(!f)return send(404,{error:'Finding not found'});
        const refs=f.data.evidenceRefs||[],entries=[];
        for(const ref of refs.slice(0,24)){
          const hit=/^([a-z][a-z0-9_-]{1,59})@([a-f0-9]{64}):(row|profile):(.+)$/.exec(ref);
          if(!hit){entries.push({ref,note:'External evidence reference; not loaded locally'});continue}
          const source=sourceCatalog.get(hit[1]);
          if(!source||source.profile.dataDigest!==hit[2]){entries.push({ref,note:'Source snapshot changed; original values unavailable'});continue}
          if(hit[3]==='row'){const index=Number(hit[4]);entries.push({ref,value:Number.isSafeInteger(index)&&index>=0?source.rows[index]:null})}
          else entries.push({ref,value:source.profile.fields.find(x=>x.key===hit[4])||null});
        }
        return send(200,{entries});
      }
      if(req.method==='GET'&&pathname==='/api/audit'){
        const id=new URL(req.url,`http://${req.headers.host}`).searchParams.get('id');
        if(!id || !allFindings().some(f=>f.id===id))return send(404,{error:'Finding not found'});
        return send(200,{events:runtime.journal.history(id)});
      }
      if(req.method!=='POST'||!routes[pathname])return send(404,{error:'Not found'});
      if(req.headers.origin!==`http://${req.headers.host}`)return send(403,{error:'Cross-site requests blocked'});
      const body=await bodyReader(req);
      if(pathname!=='/api/secret' && /"(?:apiKey|password|secret|authorization|accessToken|refreshToken)"\s*:/i.test(JSON.stringify(body)))
        throw Error('Credentials must be entered through the encrypted vault, never as plan arguments');
      const data=await routes[pathname](body);send(200,{ok:true,...(data&&typeof data==='object'?data:{value:data})});
    }catch(e){send(400,{error:cleanedError(e)})}
  });
  await new Promise((ok,fail)=>{server.once('error',fail);server.listen(port,host,ok)});
  const origin=`http://${host}:${server.address().port}`;
  return {server,origin,key,url:`${origin}/#${key}`,close:()=>new Promise((ok,fail)=>server.close(e=>e?fail(e):ok()))};
}
