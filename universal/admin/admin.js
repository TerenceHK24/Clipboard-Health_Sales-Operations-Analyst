'use strict';
const key=location.hash.slice(1)||sessionStorage.getItem('universal-it-key');
if(location.hash){sessionStorage.setItem('universal-it-key',key);history.replaceState(null,'',location.pathname)}
const $=id=>document.getElementById(id);
const text=(parent,tag,value)=>{const n=document.createElement(tag);n.textContent=String(value??'');parent.append(n);return n};
const split=value=>String(value||'').split(',').map(s=>s.trim()).filter(Boolean);
let state=null;
async function api(path,body){const response=await fetch(path,{method:body?'POST':'GET',headers:{'X-Admin-Key':key||'',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok)throw Error(data.error||'Request failed');return data}
const notice=msg=>{$('feedback').textContent=msg};
async function refresh(){state=await api('/api/config');$('indicator').textContent=`Tenant ${state.tenant}`;
  const capList=$('capabilities'),connList=$('connections'),users=$('approvers');capList.replaceChildren();connList.replaceChildren();users.replaceChildren();
  const capSelect=$('capOptions');capSelect.replaceChildren();for(const c of state.capabilities){const opt=document.createElement('option');opt.value=c.id;opt.textContent=`${c.id} (${c.mode})`;capSelect.append(opt);const row=document.createElement('div');row.className='row';text(row,'strong',c.id);text(row,'small',c.policy?.enabled?`Enabled for ${(c.policy.approver_roles||[]).join(', ')}`:'Disabled');capList.append(row)}
  const conSelect=$('connectionOptions');conSelect.replaceChildren();const blank=document.createElement('option');blank.value='';blank.textContent='No connection binding';conSelect.append(blank);
  for(const c of state.connections){const row=document.createElement('div');row.className='row';text(row,'strong',`${c.display_name} · ${c.state}`);text(row,'small',`${c.provider} · ${c.has_secret_ref?'Vault ref configured':'Credential not configured'}`);const btn=document.createElement('button');btn.type='button';btn.className='secondary';btn.textContent='Test connection';btn.addEventListener('click',()=>apply('/api/test',{id:c.connector_id}));row.append(btn);connList.append(row);const opt=document.createElement('option');opt.value=c.connector_id;opt.textContent=c.display_name;conSelect.append(opt)}
  for(const u of state.slackUsers){const row=document.createElement('div');row.className='row';text(row,'strong',`${u.slack_user_id} · ${u.role}`);text(row,'small',`${u.team_id} · ${(u.scopes||[]).join(', ')}`);users.append(row)}
}
async function apply(path,values){try{notice('Saving…');await api(path,values);await refresh();notice('Saved. A configured connection is not active until its provider probe succeeds.')}catch(e){notice('Not saved: '+e.message)}}
$('connection').addEventListener('submit',event=>{event.preventDefault();const x=Object.fromEntries(new FormData(event.target));apply('/api/connection',{id:x.id,provider:x.provider,displayName:x.displayName,secretRef:x.secretRef||null,scopes:split(x.scopes)})});
$('capability').addEventListener('submit',event=>{event.preventDefault();const f=event.target,x=Object.fromEntries(new FormData(f));apply('/api/capability',{id:x.id,connectionId:x.connectionId||null,roles:split(x.roles),enabled:f.elements.enabled.checked})});
$('approver').addEventListener('submit',event=>{event.preventDefault();const x=Object.fromEntries(new FormData(event.target));apply('/api/approver',{teamId:x.teamId,userId:x.userId,role:x.role,scopes:split(x.scopes)})});
refresh().catch(e=>notice('Unable to connect: '+e.message));
