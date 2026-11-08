/** RFC 9700 style OAuth authorization-code + PKCE bootstrap for local IT onboarding.
 * Company registers its own client with provider. Client ID is public, client secret in vault.
 * OAuth state / PKCE verifier never reach LLMs, logs, or browser UI beyond opaque auth URL.
 */
import {randomBytes,createHash} from 'node:crypto';
const now=()=>Date.now();
const ensure=(v,m)=>{if(!v)throw Error(m)};
const isUrl=(value)=>{const u=new URL(value);ensure((u.protocol==='https:'||(u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)))&&!u.username&&!u.password&&!u.hash,'OAuth endpoints must be HTTPS or loopback');return u};
const scopes=x=>{ensure(Array.isArray(x)&&x.length>0&&x.length<30&&x.every(s=>typeof s==='string'&&s.length<160),'Invalid OAuth scope list');return x};
export function validateOAuthSettings(x){
 ensure(x&&typeof x==='object'&&!Array.isArray(x),'OAuth configuration required');
 const auth=isUrl(x.authorizationUrl),token=isUrl(x.tokenUrl);
 ensure(typeof x.clientId==='string'&&x.clientId.trim()&&x.clientId.length<350,'Client ID required');
 ensure(auth.search===''&&token.search==='','OAuth endpoints cannot include static query strings');
 ensure(x.clientSecretRef===undefined||x.clientSecretRef===null||/^(?:vault:\/\/[a-zA-Z0-9/_-]{3,180}|env:\/\/[A-Z][A-Z0-9_]{2,79})$/.test(x.clientSecretRef),'Client secret must be a vault/env reference');
 return {authorizationUrl:auth.href,tokenUrl:token.href,clientId:x.clientId,clientSecretRef:x.clientSecretRef||null,scopes:scopes(x.scopes)};
}
export class OAuthBroker{
 #pending=new Map();
 constructor({vault,policyStore,resolveRaw,fetchImpl=fetch}){
  ensure(vault&&policyStore&&typeof resolveRaw==='function','OAuth requires encrypted vault and configured policy');
  Object.assign(this,{vault,policyStore,resolveRaw,fetchImpl});
 }
 begin({connectorId,redirectUri}){
  const c=this.policyStore.connection(connectorId);
  ensure(c?.settings?.oauth,'Connection must have an OAuth client registration');
  const conf=validateOAuthSettings(c.settings.oauth);
  const target=new URL(redirectUri);ensure(target.protocol==='http:'&&target.hostname==='127.0.0.1'&&target.pathname==='/oauth/callback','Local OAuth callback must be 127.0.0.1');
  const state=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url');
  const challenge=createHash('sha256').update(verifier).digest('base64url');
  const authorize=new URL(conf.authorizationUrl);
  for(const [key,value] of Object.entries({response_type:'code',client_id:conf.clientId,redirect_uri:redirectUri,scope:conf.scopes.join(' '),state,code_challenge:challenge,code_challenge_method:'S256'}))authorize.searchParams.set(key,value);
  this.#pending.set(state,{connectorId,conf,verifier,redirectUri,expires:now()+600000});
  for(const [key,session] of this.#pending)if(session.expires<now())this.#pending.delete(key);
  return {authorizationUrl:authorize.href};
 }
 async callback({state,code}){
  const record=this.#pending.get(state);this.#pending.delete(state);
  ensure(record&&record.expires>now(),'OAuth state invalid, expired or already used');
  ensure(typeof code==='string'&&code.length>2&&code.length<5000,'Invalid authorization code');
  const params=new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:record.redirectUri,
    client_id:record.conf.clientId,code_verifier:record.verifier});
  if(record.conf.clientSecretRef)params.set('client_secret',await this.resolveRaw(record.conf.clientSecretRef));
  const r=await this.fetchImpl(record.conf.tokenUrl,{method:'POST',redirect:'error',headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:params.toString(),signal:AbortSignal.timeout(17000)});
  ensure(r.ok,`OAuth token endpoint returned HTTP ${r.status}`);
  const text=await r.text();ensure(text.length<25000,'Token response too large');const data=JSON.parse(text);
  ensure(typeof data.access_token==='string'&&data.access_token.length>8,'Provider did not return an access token');
  const ref=`vault://oauth/${record.connectorId}`;
  this.vault.set(ref,JSON.stringify({oauth:true,access_token:data.access_token,refresh_token:data.refresh_token||null,
    expires_at:Number.isFinite(Number(data.expires_in))?now()+Number(data.expires_in)*1000:0,
    token_url:record.conf.tokenUrl,client_id:record.conf.clientId,client_secret_ref:record.conf.clientSecretRef}));
  const c=this.policyStore.connection(record.connectorId);
  this.policyStore.upsertConnection({id:c.connector_id,provider:c.provider,displayName:c.display_name,secretRef:ref,
    scopes:c.requested_scopes,settings:c.settings,actor:'oauth:callback'});
  return {connectionId:record.connectorId,secretRef:ref,state:'unverified'};
 }
}
/** Production-capable lazy refresh for standard OAuth providers; no unverified writes. */
export function createOAuthCredentialResolver({vault,resolveRaw,fetchImpl=fetch}){
 const inFlight=new Map();
 return async ref=>{
  const raw=await resolveRaw(ref);
  let data;try{data=JSON.parse(raw)}catch{return raw}
  if(!data||data.oauth!==true)return raw;
  if(!data.expires_at || data.expires_at>now()+60000)return data.access_token;
  if(!data.refresh_token)throw Error('OAuth credential expired and refresh token unavailable; reconnect via IT Console');
  if(inFlight.has(ref))return inFlight.get(ref);
  const work=(async()=>{
    const params=new URLSearchParams({grant_type:'refresh_token',refresh_token:data.refresh_token,client_id:data.client_id});
    if(data.client_secret_ref)params.set('client_secret',await resolveRaw(data.client_secret_ref));
    const r=await fetchImpl(data.token_url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:params.toString(),signal:AbortSignal.timeout(17000)});
    if(!r.ok)throw Error('OAuth refresh failed; reconnect the provider');
    const payload=await r.json();if(typeof payload.access_token!=='string'||payload.access_token.length<8)throw Error('Invalid refreshed credential');
    const updated={...data,access_token:payload.access_token,refresh_token:payload.refresh_token||data.refresh_token,
      expires_at:Number.isFinite(Number(payload.expires_in))?now()+Number(payload.expires_in)*1000:0};
    vault.set(ref,JSON.stringify(updated));return updated.access_token;
  })();inFlight.set(ref,work);
  try{return await work}finally{inFlight.delete(ref)}
 };
}
