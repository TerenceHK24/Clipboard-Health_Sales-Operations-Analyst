/** Admin-certified REST action manifests. Tool IDs and HTTP endpoints are never model-generated at execution time. */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync,chmodSync } from 'node:fs';
import { dirname } from 'node:path';
const ID=/^[a-z][a-z0-9_-]{1,59}$/;
const CAP=/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;
const PARAM=/\{([a-zA-Z_][a-zA-Z_0-9]*)\}/g;
function check(v,m){if(!v)throw Error(m)}
export function validateTemplate(x){
  check(x && typeof x==='object' && !Array.isArray(x),'Invalid template');
  check(CAP.test(x.id),'Invalid capability ID');
  check(ID.test(x.connectionId),'Invalid connection ID');
  check(['GET','POST','PATCH','PUT'].includes(x.method),'Unsupported HTTP method');
  check(typeof x.path==='string' && x.path.startsWith('/')&&!x.path.startsWith('//')&&!x.path.includes('..')&&!x.path.includes('?')&&!x.path.includes('#'),'Invalid fixed relative path');
  check(x.path.length<320,'Path too long');
  check(typeof x.description==='string'&&x.description.trim()&&x.description.length<400,'Action description required');
  check(Array.isArray(x.scopes)&&x.scopes.length<=10&&x.scopes.every(y=>typeof y==='string'&&/^[a-zA-Z0-9:._*-]{2,100}$/.test(y)),'Invalid scopes');
  if(x.method!=='GET'){
    check(typeof x.verifyPath==='string'&&x.verifyPath.startsWith('/')&&!x.verifyPath.startsWith('//')&&!x.verifyPath.includes('..')&&!x.verifyPath.includes('?'),'Write actions require GET read-back path');
  }
  check(x.authHeader===undefined || ['bearer','x-api-key'].includes(x.authHeader),'Unapproved auth header');
  check(!('baseUrl' in x)&&!('apiKey' in x)&&!('token' in x),'Endpoint and credentials belong to the registered connection');
  return {id:x.id,connectionId:x.connectionId,method:x.method,path:x.path,verifyPath:x.verifyPath||null,
    description:x.description,scopes:x.scopes,authHeader:x.authHeader||'bearer'};
}
const serialize=v=>JSON.stringify(v);
export class ConnectorTemplateStore {
  constructor(path,tenant){check(ID.test(tenant),'Invalid tenant');mkdirSync(dirname(path),{recursive:true,mode:0o700});this.db=new DatabaseSync(path);this.tenant=tenant;
    this.db.exec('CREATE TABLE IF NOT EXISTS tool_templates(tenant TEXT NOT NULL,id TEXT NOT NULL,manifest TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(tenant,id))');try{chmodSync(path,0o600)}catch{}
  }
  list(){return this.db.prepare('SELECT manifest FROM tool_templates WHERE tenant=? ORDER BY id').all(this.tenant).map(r=>JSON.parse(r.manifest))}
  get(id){const row=this.db.prepare('SELECT manifest FROM tool_templates WHERE tenant=? AND id=?').get(this.tenant,id);return row?JSON.parse(row.manifest):null}
  set(value){const m=validateTemplate(value);this.db.prepare('INSERT INTO tool_templates VALUES (?,?,?,?) ON CONFLICT(tenant,id) DO UPDATE SET manifest=excluded.manifest,updated_at=excluded.updated_at').run(this.tenant,m.id,serialize(m),new Date().toISOString());return m}
  delete(id){return this.db.prepare('DELETE FROM tool_templates WHERE tenant=? AND id=?').run(this.tenant,id).changes===1}
  close(){this.db.close()}
}
function fixedOrigin(url){const u=new URL(url);check((u.protocol==='https:'||(u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)))&&!u.username&&!u.password&&!u.search&&!u.hash,'REST connection must use an HTTPS base URL');return u}
function endpoint(root,template,args){
  const pathname=template.replace(PARAM,(_m,key)=>{
    const v=args[key];if(!(typeof v==='string'||typeof v==='number')||!String(v).trim())throw Error(`Missing URL value ${key}`);
    const str=String(v);if(str.length>200)throw Error('Path parameter too long');return encodeURIComponent(str)
  });
  if(pathname.includes('{')||pathname.includes('}'))throw Error('Missing path variable');
  const u=new URL(pathname,root);check(u.origin===root.origin,'Cross-origin tool execution prohibited');return u;
}
async function readJson({url,method='GET',body,token,authHeader='bearer',fetchImpl=fetch}){
  const headers={Accept:'application/json'};
  if(token){if(authHeader==='bearer')headers.Authorization=`Bearer ${token}`;else headers['X-API-Key']=token;}
  if(body!==undefined)headers['Content-Type']='application/json';
  const response=await fetchImpl(url,{method,headers,redirect:'error',signal:AbortSignal.timeout(16000),...(body===undefined?{}:{body:serialize(body)})});
  if(!response.ok)throw Error(`Connector returned HTTP ${response.status}`);
  const raw=await response.text();if(raw.length>1500000)throw Error('Connector JSON response exceeded limit');
  return raw?JSON.parse(raw):{};
}
function deepSubset(actual,expected){
  if(typeof expected!=='object'||expected===null)return Object.is(actual,expected);
  if(!actual||typeof actual!=='object')return false;
  return Object.entries(expected).every(([key,value])=>deepSubset(actual[key],value));
}
export function registerTemplate({registry,manifest,policyStore,credentialResolver,fetchImpl=fetch}){
  const m=validateTemplate(manifest);
  const connection=policyStore.connection(m.connectionId);
  check(connection,'Connection ID must be configured in IT console');
  const settings=connection.settings||{};
  check(typeof settings.baseUrl==='string','Connection requires a trusted baseUrl in its configuration');
  const origin=fixedOrigin(settings.baseUrl);
  const mode=m.method==='GET'?'read':'write';
  registry.register({id:m.id,description:m.description,mode,requiredScopes:m.scopes,
    validate:args=>!!args&&typeof args==='object'&&!Array.isArray(args)&&
      (mode==='read'||(args.body && typeof args.body==='object'&&!Array.isArray(args.body)&&serialize(args.body).length<10000)),
    execute:async (args)=>{
      const c=policyStore.connection(m.connectionId);if(!c||c.state!=='verified')throw Error('Connector not verified or disabled');
      const credential=c.secret_ref?await credentialResolver(c.secret_ref):null;
      const url=endpoint(origin,m.path,args);
      return readJson({url,method:m.method,body:mode==='write'?args.body:undefined,token:credential,authHeader:m.authHeader,fetchImpl});
    },
    verify:mode==='read'?undefined:async (args,result)=>{
      const c=policyStore.connection(m.connectionId);if(c?.state!=='verified')throw Error('Connector no longer verified');
      const url=endpoint(origin,m.verifyPath,{...args,...result});
      const credential=c.secret_ref?await credentialResolver(c.secret_ref):null;
      const current=await readJson({url,token:credential,authHeader:m.authHeader,fetchImpl});
      // Only a strong read-back match is marked verified; otherwise block for manual inspection.
      return deepSubset(current,args.body);
    }
  });
  return m.id;
}
