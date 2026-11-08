import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {OAuthBroker,createOAuthCredentialResolver,validateOAuthSettings} from '../platform/oauth.mjs';
import {CompanyPolicyStore} from '../admin/policy-store.mjs';
import {LocalVault,parseMasterKey,makeCredentialResolver} from '../platform/vault.mjs';

test('OAuth authorization-code PKCE: client-specific state, encrypted exchange, one-time callback and refresh',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ops-oauth-')),key=parseMasterKey('a'.repeat(64)),tenant='customer';
 const vault=new LocalVault({path:join(dir,'vault.sqlite'),tenant,key}),policy=new CompanyPolicyStore(join(dir,'policy.sqlite'),tenant);
 const conf={authorizationUrl:'https://idp.example.test/authorize',tokenUrl:'https://idp.example.test/token',clientId:'public-client',
  clientSecretRef:'vault://oauth/client-secret',scopes:['customers.read','customers.write']};
 vault.set('vault://oauth/client-secret','VERY-PRIVATE-CLIENT-SECRET');
 policy.upsertConnection({id:'crm',provider:'rest',displayName:'CRM',settings:{baseUrl:'https://api.example.test',oauth:conf},actor:'it-admin'});
 const raw=makeCredentialResolver({vault});const sent=[];
 const broker=new OAuthBroker({vault,policyStore:policy,resolveRaw:raw,fetchImpl:async(url,opts)=>{
  sent.push({url:String(url),params:new URLSearchParams(opts.body)});
  return {ok:true,text:async()=>JSON.stringify({access_token:'sandbox_access_token_0001',refresh_token:'sandbox_refresh_token_0001',expires_in:1})};
 }});
 try{
  const initial=broker.begin({connectorId:'crm',redirectUri:'http://127.0.0.1:4321/oauth/callback'});
  const u=new URL(initial.authorizationUrl);assert.equal(u.searchParams.get('code_challenge_method'),'S256');
  assert.ok(u.searchParams.get('code_challenge'));assert.ok(u.searchParams.get('state'));
  assert.ok(!initial.authorizationUrl.includes('CLIENT-SECRET'));
  await assert.rejects(broker.callback({state:'invalid',code:'wrong'}),/state invalid/);
  const result=await broker.callback({state:u.searchParams.get('state'),code:'code_123'});
  assert.equal(result.state,'unverified');assert.equal(policy.connection('crm').secret_ref,'vault://oauth/crm');
  assert.equal(sent.length,1);assert.equal(sent[0].params.get('code_verifier').length>40,true);
  assert.equal(sent[0].params.get('client_secret'),'VERY-PRIVATE-CLIENT-SECRET');
  assert.ok(!readFileSync(join(dir,'vault.sqlite')).includes(Buffer.from('sandbox_access_token_0001')));
  await assert.rejects(broker.callback({state:u.searchParams.get('state'),code:'code_123'}),/state invalid/);
  const resolver=createOAuthCredentialResolver({vault,resolveRaw:raw,fetchImpl:async(_url,opts)=>{
   const q=new URLSearchParams(opts.body);assert.equal(q.get('grant_type'),'refresh_token');
   return {ok:true,json:async()=>({access_token:'sandbox_access_token_0002',expires_in:3600})};
  }});
  assert.equal(await resolver('vault://oauth/crm'),'sandbox_access_token_0002');
 }finally{vault.close();policy.close();rmSync(dir,{recursive:true,force:true})}
});
test('OAuth configuration rejects insecure endpoints, missing scopes and raw client secrets',()=>{
 assert.throws(()=>validateOAuthSettings({authorizationUrl:'http://evil.test/authorize',tokenUrl:'https://evil.test/token',clientId:'a',scopes:['a']}),/HTTPS/);
 assert.throws(()=>validateOAuthSettings({authorizationUrl:'https://idp.test/authorize',tokenUrl:'https://idp.test/token',clientId:'a',clientSecretRef:'plaintext',scopes:['a']}),/vault/);
});
