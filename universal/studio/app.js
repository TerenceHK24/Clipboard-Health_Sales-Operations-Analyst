'use strict';
/** No third-party frontend JS. All untrusted source data is rendered via textContent. */
const $=id=>document.getElementById(id);
const key=location.hash.slice(1)||sessionStorage.getItem('ops-studio-key');
if(location.hash){sessionStorage.setItem('ops-studio-key',key);history.replaceState(null,'',location.pathname)}
let state=null,view='overview',toastTimeout=null;
const n=(tag,value=null,className='')=>{const el=document.createElement(tag);if(value!==null)el.textContent=String(value);if(className)el.className=className;return el};
const el=(id)=>$(id);
const lines=x=>String(x||'').split(',').map(y=>y.trim()).filter(Boolean);
const status=x=>{const sp=n('span',String(x||'unknown').replaceAll('_',' '),'smallstatus');sp.classList.add(x||'unknown');return sp};
const formattedDate=x=>{try{return new Date(x).toLocaleString()}catch{return x||''}};
const toast=(msg,kind='ok')=>{const t=$('toast');t.textContent=msg;t.className=`toast show ${kind==='error'?'error':''}`;clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>t.className='toast',4300)};
async function request(path,body){
 const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'X-Studio-Key':key||'',...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 let result;try{result=await response.json()}catch{throw Error(`Unexpected HTTP ${response.status}`)}
 if(!response.ok)throw Error(result.error||`HTTP ${response.status}`);return result;
}
async function operation(path,data,message='Saved'){
 try{const r=await request(path,data);await refresh();toast(message);return r}
 catch(e){toast(e.message,'error');return null}
}
async function refresh(){state=await request('/api/state');$('workspace').textContent=state.tenant;
 $('encryption-indicator').textContent=state.encryptedSources?'Encrypted source storage':'Ephemeral source mode';
 $('nav-count').textContent=state.findings.filter(f=>['discovered','investigating','approved'].includes(f.state)).length;
 renderOverview();renderSources();renderFindings();renderIntegrations();renderGovernance();renderActivity();
}
function changeView(next){view=next;document.querySelectorAll('.page').forEach(x=>x.classList.toggle('active',x.id===`view-${next}`));
 document.querySelectorAll('.navitem').forEach(x=>x.classList.toggle('active',x.dataset.view===next));
 const names={overview:'Operations overview',discover:'Data sources & discovery',findings:'Findings & approvals',integrations:'Connected systems',governance:'Governance & access',activity:'Audit activity'};
 $('page-title').textContent=names[next];$('breadcrumb').textContent=`WORKSPACE / ${next.toUpperCase()}`;window.scrollTo(0,0);
}
function addEmpty(container,msg){const p=n('p',msg,'empty');container.append(p)}
function row(symbol,title,subtitle,badge=null,handler=null){const r=n('div',null,'item-row');
 r.append(n('span',symbol,'item-symbol'));const body=n('div',null,'item-text');body.append(n('strong',title),n('small',subtitle));r.append(body);
 if(badge)r.append(status(badge));if(handler){r.style.cursor='pointer';r.addEventListener('click',handler)}return r;
}
function renderOverview(){
 for(const key of ['discovered','investigating','approved','applied'])$(`metric-${key}`).textContent=state.counts[key]||0;
 const find=$('recent-findings');find.replaceChildren();
 for(const f of state.findings.slice(0,5))find.append(row('◇',f.data.summary,`${f.data.type} · ${formattedDate(f.updated_at)}`,f.state,()=>openFinding(f.id)));
 if(!find.childElementCount)addEmpty(find,'No findings yet. Import data and run a comparison to generate evidence-backed signals.');
 const conn=$('recent-connections');conn.replaceChildren();for(const c of state.connections.slice(0,6))conn.append(row('↔',c.display_name,`${c.provider} · ${c.connector_id}`,c.state));
 if(!conn.childElementCount)addEmpty(conn,'No live systems configured. The demo is fully local and does not require credentials.');
}
function choose(sel,items,old=null,placeholder=null){const before=old||sel.value;sel.replaceChildren();
 if(placeholder){const opt=n('option',placeholder);opt.value='';sel.append(opt)}
 for(const item of items){const opt=n('option',item.title||item.name||item.id);opt.value=item.id;sel.append(opt)}
 if(items.some(x=>x.id===before))sel.value=before;
}
function renderSources(){const list=$('source-list');list.replaceChildren();
 for(const s of state.sources){const card=n('div',null,'source-card');const cnt=n('span',String(s.profile.rowCount),'count');card.append(cnt,n('b',s.title),n('small',`${s.id} · ${s.kind}`),n('small',`${s.profile.fields.length} fields · ${formattedDate(s.updated_at)}`));list.append(card)}
 if(!list.childElementCount)addEmpty(list,'No data sources loaded. Import a sample or connect a verified REST API.');
 choose($('source-a'),state.sources);choose($('source-b'),state.sources,state.sources[1]?.id);
 const connected=state.connections.filter(x=>x.state==='verified');choose($('rest-connections'),connected,null,'Select verified connection');
 updateKeyChoices('source-a','key-a');updateKeyChoices('source-b','key-b');
}
function updateKeyChoices(sourceId,keyId){const id=$(sourceId).value,src=state?.sources.find(x=>x.id===id),fields=src?.profile.fields||[];
 const select=$(keyId),before=select.value;select.replaceChildren();for(const field of fields){const opt=n('option',field.key);opt.value=field.key;select.append(opt)}
 if(fields.some(x=>x.key===before))select.value=before;else{const match=fields.find(x=>x.semantic.includes('id')||/id|code|key/i.test(x.key));if(match)select.value=match.key;}}
function renderFindings(){const list=$('findings-list'),filter=$('finding-filter').value;list.replaceChildren();
 const findings=state.findings.filter(x=>filter==='all'||x.state===filter);
 $('finding-count').textContent=`${findings.length} findings`;
 for(const f of findings){const wrap=n('div',null,'finding-card');const content=n('div',null,'finding-body');content.append(n('strong',f.data.summary),
   n('small',`${f.data.type} · ${f.data.evidenceRefs.length} evidence refs · ${formattedDate(f.updated_at)}`));
 wrap.append(n('span','◇','item-symbol'),content,status(f.state),n('span','›','chevron'));wrap.addEventListener('click',()=>openFinding(f.id));list.append(wrap)}
 if(!list.childElementCount)addEmpty(list,'Nothing matches this filter. Run a new discovery or change the status selection.');
}
function renderIntegrations(){
 if(state.aiSettings){const f=$('ai-form');f.elements.provider.value=state.aiSettings.provider;f.elements.model.value=state.aiSettings.model;f.elements.approvalContext.checked=state.aiSettings.approvalContext}
 $('providers-count').textContent=`${state.providers.length} catalog entries`;
 const grid=$('provider-grid');grid.replaceChildren();for(const p of state.providers){const cell=n('div',null,'provider');cell.append(n('b',p.name),n('small',`${p.group} · ${p.auth}`),status(p.status));grid.append(cell)}
 choose($('provider-select'),state.providers);choose($('capability-options'),state.capabilities);
 choose($('capability-connections'),state.connections,null,'No connection binding');
 const table=$('connections-table');table.replaceChildren();if(!state.connections.length){addEmpty(table,'No integrations connected. Configure a connection and use Test to verify its read-only API.')}else{
  const t=n('table'),head=n('thead'),tr=n('tr');for(const h of ['Connection','Provider','State','Permissions','Actions'])tr.append(n('th',h));head.append(tr);t.append(head);const body=n('tbody');
  for(const c of state.connections){const tr=n('tr');tr.append(n('td',c.display_name),n('td',c.provider));const cell=n('td');cell.append(status(c.state));tr.append(cell,n('td',(c.requested_scopes||[]).join(', ')||'—'));const actions=n('td');const btn=n('button','Test connection','btn subtle');btn.addEventListener('click',()=>operation('/api/connection-test',{id:c.connector_id},'Connection test completed'));actions.append(btn);if(c.settings?.oauth&&state.oauthAvailable){const connect=n('button','Connect OAuth','btn soft');connect.addEventListener('click',async()=>{try{const result=await request('/api/oauth-start',{connectionId:c.connector_id});location.href=result.authorizationUrl}catch(e){toast(e.message,'error')}});actions.append(connect)}tr.append(actions);body.append(tr)}t.append(body);table.append(t)
 }
 const caps=$('capability-list');caps.replaceChildren();for(const c of state.capabilities)caps.append(row('⌘',c.id,`${c.mode} · ${(c.requiredScopes||[]).join(', ')||'no extra scope'}`,c.policy?.enabled?'verified':'unverified'));
 if(!caps.childElementCount)addEmpty(caps,'No installed capabilities. Add a REST tool template or use the synthetic demo.');
}
function renderGovernance(){const list=$('approvers-list');list.replaceChildren();for(const p of state.approvers)list.append(row('♧',p.slack_user_id,`${p.team_id} · ${p.role} · ${(p.scopes||[]).join(', ')}`));
 if(!list.childElementCount)addEmpty(list,'No Slack approvers assigned. IT can add an authorized user above.');
}
function renderActivity(){const list=$('jobs-list');list.replaceChildren();
 for(const job of state.jobs)list.append(row('◌',`${job.kind} · ${job.id.slice(0,12)}`,`${formattedDate(job.updated_at)}${job.error?' · '+job.error:''}`,job.state));
 if(!list.childElementCount)addEmpty(list,'No durable jobs yet. Approval and execution events appear here.');
}
function dialogClose(){$('dialog').hidden=true;$('dialog-content').replaceChildren();$('dialog-actions').replaceChildren()}
function dialog(title){$('dialog').hidden=false;const content=$('dialog-content');content.replaceChildren();content.append(n('h2',title));$('dialog-actions').replaceChildren();return content}
function dialogButton(text,callback,variant='subtle'){const b=n('button',text,`btn ${variant}`);b.addEventListener('click',async()=>{b.disabled=true;try{await callback()}finally{b.disabled=false}});$('dialog-actions').append(b);return b}
function detail(content,label,value){content.append(n('h3',label),n('p',value||'—'))}
function code(content,value){content.append(n('pre',typeof value==='string'?value:JSON.stringify(value,null,2)))}
function openFinding(id){const f=state.findings.find(x=>x.id===id);if(!f)return;
 const content=dialog(f.data.summary);content.append(status(f.state));detail(content,'Investigation',`${f.data.explanation||'Anomaly requiring investigation'}\nConfidence: ${f.data.confidence}`);
 detail(content,'Evidence references',(f.data.evidenceRefs||[]).join(' · '));
 const plans=f.data.plans||[];
 if(plans.length){content.append(n('h3','Proposed resolution plans'));for(const p of plans){const row=n('div',null,'item-row');const text=n('div',null,'item-text');text.append(n('strong',p.title),n('small',`${p.steps.length} step(s) · ${p.id.slice(0,14)}`));row.append(text);const btn=n('button','Review plan','btn subtle');btn.addEventListener('click',()=>openPlan(id,p.id));row.append(btn);content.append(row)}}
 dialogButton('Close',dialogClose);
 dialogButton('View source records',async()=>{const result=await request('/api/evidence?id='+encodeURIComponent(id));const section=dialog('Original evidence · local source');
  detail(section,'Private evidence','These values are shown only inside this authenticated local workspace and are not automatically sent to any AI provider.');
  for(const item of result.entries){section.append(n('h3',item.ref));code(section,item.note||item.value||'Not available')}dialogButton('Back',()=>openFinding(id));},'soft');
 if(f.state==='discovered'){
  dialogButton('Monitor only',async()=>{await operation('/api/decision1',{id,decision:'monitor'},'Monitoring decision saved');dialogClose()},'subtle');
  dialogButton('Dismiss',async()=>{await operation('/api/decision1',{id,decision:'dismiss'},'Finding dismissed');dialogClose()},'subtle');
  dialogButton('Investigate',async()=>{await operation('/api/decision1',{id,decision:'investigate'},'Investigation enabled');openFinding(id)},'primary');
 }
 if(f.state==='investigating'){
  dialogButton('Add custom plan',()=>editPlan(id),'primary');
  if(state.aiConfigured)dialogButton('Ask AI to propose',async()=>{const r=await operation('/api/ai-plan',{findingId:id},'AI plans proposed');if(r)openFinding(id)},'soft');
 }
 if(f.state==='approved')dialogButton('Queue approved execution',async()=>{const r=await operation('/api/execute',{findingId:id},'Execution queued');if(r)dialogClose()},'primary');
}
function editPlan(findingId){const content=dialog('Build a resolution plan');detail(content,'Exact scope','A plan is a list of registered tool calls. Unregistered tools and credentials are blocked. No tool executes at this stage.');
 const form=n('form');form.id='plan-editor';const title=n('input');title.placeholder='Plan title';title.required=true;title.value='Request follow-up on unusual data';form.append(n('h3','Plan title'),title);
 const textarea=n('textarea');textarea.rows=8;textarea.style.width='100%';textarea.style.font='12px/1.5 monospace';textarea.style.padding='12px';textarea.style.border='1px solid #dbe2e8';textarea.style.borderRadius='8px';
 const suggestion=state.capabilities.find(x=>x.policy?.enabled)||state.capabilities[0];
 textarea.value=JSON.stringify([{tool:suggestion?.id||'demo.notify',args:suggestion?.id==='demo.notify'?{message:'Investigate this finding'}:{id:'account-1',status:'Needs Review'},reason:'Investigate the evidence before changing records'}],null,2);
 form.append(n('h3','Steps: JSON array'),textarea);content.append(form);
 dialogButton('Cancel',dialogClose);dialogButton('Save proposed plan',async()=>{
  try{const steps=JSON.parse(textarea.value);const r=await operation('/api/plan',{findingId,title:title.value,steps},'Plan proposed');if(r){dialogClose();openFinding(findingId)}}catch(e){toast('Invalid plan: '+e.message,'error')}
 },'primary');
}
function openPlan(findingId,planId){const f=state.findings.find(x=>x.id===findingId),plan=f?.data.plans.find(x=>x.id===planId);if(!plan)return;
 const content=dialog(plan.title);content.append(status(f.state));detail(content,'Plan rationale',plan.explanation||'Review the exact operations below.');
 content.append(n('h3','Exact operations and arguments'));
 const list=n('ol',null,'step-list');for(const step of plan.steps){const li=n('li');li.append(n('b',`${step.mode.toUpperCase()} · ${step.tool}`),n('p',step.reason||''),n('pre',JSON.stringify(step.args,null,2)));list.append(li)}content.append(list);
 detail(content,'Approval boundary',`Plan ID ${plan.id} · ${plan.steps.length} step(s). Permissions and connector health are rechecked before execution.`);
 dialogButton('Back',()=>openFinding(findingId));
 if(f.state==='investigating'){
  dialogButton('Reject',()=>confirmDecision(findingId,planId,'reject'),'subtle');
  dialogButton('Approve…',()=>confirmDecision(findingId,planId,'approve'),'primary');
  if(state.slackConfigured)dialogButton('Send to Slack',()=>sendSlack(findingId,planId),'soft');
 }
 if(f.state==='approved'&&f.selected_plan===planId)dialogButton('Queue execution',async()=>{const r=await operation('/api/execute',{findingId},'Execution queued');if(r)dialogClose()},'primary');
}
function confirmDecision(findingId,planId,decision){const f=state.findings.find(x=>x.id===findingId),p=f?.data.plans.find(x=>x.id===planId);
 const content=dialog(decision==='approve'?'Confirm approval':'Confirm rejection');
 detail(content,'You are deciding on this exact plan',p.title);
 code(content,p.steps.map(s=>({tool:s.tool,mode:s.mode,args:s.args})));
 detail(content,'Authorization',decision==='approve'?'This confirms the listed operations. Only preinstalled, enabled and scoped capabilities are permitted. After approval, the backend worker will execute them and verify results.':'This records a rejection. No operations will execute.');
 dialogButton('Cancel',()=>openPlan(findingId,planId));
 dialogButton(decision==='approve'?'Confirm & execute':'Confirm rejection',async()=>{
  const r=await operation('/api/decision2',{findingId,planId,decision},decision==='approve'?'Approval recorded':'Plan rejected');
  if(!r)return;if(decision==='approve')await operation('/api/execute',{findingId},'Execution queued for verified worker');
  dialogClose();
 },decision==='approve'?'primary':'subtle');
}
function sendSlack(findingId,planId){const content=dialog('Request approval in Slack');detail(content,'Manager approval','The Slack card contains evidence, proposed steps, Approve/Reject confirmation, View Evidence and Ask Agent actions.');
 const label=n('label','Allowed Slack channel ID');const field=n('input');field.placeholder='C0123456789';field.style.width='100%';field.style.padding='11px';content.append(label,field);
 dialogButton('Cancel',dialogClose);dialogButton('Send approval card',async()=>{const r=await operation('/api/slack-publish',{findingId,planId,channel:field.value},'Slack approval card sent');if(r)dialogClose()},'primary')}
// Navigation and global event handlers.
document.querySelectorAll('[data-view]').forEach(x=>x.addEventListener('click',()=>changeView(x.dataset.view)));
document.querySelectorAll('[data-go]').forEach(x=>x.addEventListener('click',()=>changeView(x.dataset.go)));
$('refresh').addEventListener('click',()=>refresh().then(()=>toast('Workspace refreshed')).catch(e=>toast(e.message,'error')));
$('dialog-close').addEventListener('click',dialogClose);$('dialog').addEventListener('click',e=>{if(e.target===$('dialog'))dialogClose()});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('dialog').hidden)dialogClose()});
$('finding-filter').addEventListener('change',renderFindings);
$('load-sample').addEventListener('click',()=>{$('import-form').elements.id.value='sample_accounts';$('import-form').elements.title.value='Synthetic sample accounts';
 $('import-form').elements.rows.value=JSON.stringify([{id:'C1',name:'Example Office',status:'Active',city:'Edmonton'},{id:'C2',name:'Second Office',status:'Inactive',city:'Calgary'}],null,2)});
$('import-form').addEventListener('submit',async e=>{e.preventDefault();const f=e.target;let rows;try{rows=JSON.parse(f.elements.rows.value)}catch{toast('JSON is invalid','error');return}
 const r=await operation('/api/import',{id:f.elements.id.value,title:f.elements.title.value,rows},'Data source imported');if(r)f.reset()});
$('rest-source-form').addEventListener('submit',async e=>{e.preventDefault();const x=Object.fromEntries(new FormData(e.target));const r=await operation('/api/load-rest',x,'Remote data profiled');if(r)e.target.reset()});
for(const [a,b] of [['source-a','key-a'],['source-b','key-b']])$(a).addEventListener('change',()=>updateKeyChoices(a,b));
$('compare-form').addEventListener('submit',async e=>{e.preventDefault();const form=e.target;
 try {
  const pairs=lines(form.elements.fields.value).map(x=>{const parts=x.split(':').map(s=>s.trim());if(parts.length!==2||!parts[0]||!parts[1])throw Error('Use fieldA:fieldB format');return {left:parts[0],right:parts[1]}});
  const x=Object.fromEntries(new FormData(form));const r=await operation('/api/compare',{left:x.left,right:x.right,leftKey:x.leftKey,rightKey:x.rightKey,fields:pairs},'Comparison generated');
  if(r){changeView('findings');toast(`Found ${r.created} new patterns · ${r.repeated} previously known`)}
 } catch(error) { toast(error.message,'error'); }
});
$('analyze-one').addEventListener('click',async()=>{const id=$('source-a').value;if(!id)return toast('Select a source first','error');const r=await operation('/api/analyze',{id},'Single-source scan complete');if(r)changeView('findings')});
$('ai-discover').addEventListener('click',async()=>{if(!state.aiConfigured)return toast('No AI provider configured; add BYOK secret reference in your server configuration','error');
 if(!window.confirm('Send limited schema statistics (field names, counts, null rates; not raw rows) to the configured AI provider?'))return;
 const r=await operation('/api/ai-discover',{sourceId:$('source-a').value||undefined},'AI discovery completed');if(r)changeView('findings')});
const defaults={hubspot:['https://api.hubapi.com','/crm/v3/objects/companies?limit=1'],gmail:['https://gmail.googleapis.com','/gmail/v1/users/me/profile'],
 googlecalendar:['https://www.googleapis.com','/calendar/v3/users/me/calendarList?maxResults=1'],outlook:['https://graph.microsoft.com','/v1.0/me'],slack:['https://slack.com','/api/auth.test']};
$('provider-select').addEventListener('change',()=>{const v=defaults[$('provider-select').value];if(v){$('base-url').value=v[0];$('test-path').value=v[1]}});
$('connection-form').addEventListener('submit',async e=>{e.preventDefault();const x=Object.fromEntries(new FormData(e.target));const settings={};if(x.baseUrl)settings.baseUrl=x.baseUrl;if(x.testPath)settings.testPath=x.testPath;
 if(x.authorizationUrl||x.tokenUrl||x.clientId){settings.oauth={authorizationUrl:x.authorizationUrl,tokenUrl:x.tokenUrl,clientId:x.clientId,clientSecretRef:x.clientSecretRef||null,scopes:String(x.oauthScopes||'').split(/[,\s]+/).map(y=>y.trim()).filter(Boolean)}}
 await operation('/api/connection',{id:x.id,provider:x.provider,displayName:x.displayName,secretRef:x.secretRef||null,settings,scopes:lines(x.scopes)},'Connection saved; test before enabling tools')});
$('ai-form').addEventListener('submit',async e=>{e.preventDefault();const f=e.target,x=Object.fromEntries(new FormData(f));await operation('/api/ai-config',{provider:x.provider,model:x.model,secretRef:x.secretRef,approvalContext:f.elements.approvalContext.checked},'AI provider saved; install the optional AI SDK for live inference')});
$('secret-form').addEventListener('submit',async e=>{e.preventDefault();const f=e.target;const x=Object.fromEntries(new FormData(f));
 if(!state.vaultAvailable)return toast('Encrypted vault disabled; configure OPS_AGENT_MASTER_KEY','error');
 const r=await operation('/api/secret',x,'Secret encrypted and stored');f.elements.value.value='';if(r)f.reset()});
$('template-form').addEventListener('submit',async e=>{e.preventDefault();const x=Object.fromEntries(new FormData(e.target));
 const r=await operation('/api/template',{id:x.id,connectionId:x.connectionId,method:x.method,path:x.path,verifyPath:x.verifyPath||undefined,description:x.description,scopes:lines(x.scopes)},'Tool registered; enable under access policy');if(r)e.target.reset()});
$('capability-form').addEventListener('submit',async e=>{e.preventDefault();const f=e.target,x=Object.fromEntries(new FormData(f));
 await operation('/api/capability',{id:x.id,enabled:f.elements.enabled.checked,roles:lines(x.roles),connectionId:x.connectionId||null},'Tool policy updated')});
$('approver-form').addEventListener('submit',async e=>{e.preventDefault();const x=Object.fromEntries(new FormData(e.target));await operation('/api/approver',{teamId:x.teamId,userId:x.userId,role:x.role,scopes:lines(x.scopes)},'Approver added')});
$('drain-jobs').addEventListener('click',async()=>{await operation('/api/queue-drain',{},'Queued jobs processed')});
if(new URLSearchParams(location.search).get('oauth')==='connected'){history.replaceState(null,'',location.pathname);toast('OAuth token stored securely. Test the connection before enabling actions.')}
if(!key)toast('Open the private Studio URL printed in your terminal','error');
refresh().catch(e=>toast('Could not load workspace: '+e.message,'error'));
