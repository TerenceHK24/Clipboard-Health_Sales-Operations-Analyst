/** Company-owned connection manifests, RBAC and tool policies.
 * This store MUST NOT contain access tokens, API keys or passwords.
 * A secretRef is a locator interpreted by a separately authenticated vault or local prompt.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

const json = v => JSON.stringify(v);
const parse = s => JSON.parse(s);
const ID = /^[a-z][a-z0-9_-]{1,62}$/;
const CAP = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;
const SLACK = /^[A-Z0-9_-]{2,40}$/;
function check(condition, reason) { if (!condition) throw Error(reason); }
function strArray(x, regex, label) {
  check(Array.isArray(x) && x.length <= 60 && x.every(v=>typeof v==='string' && regex.test(v)), `Invalid ${label}`);
  return [...new Set(x)];
}
const SCOPERE = /^[a-zA-Z0-9:_.*-]{2,100}$/;
const ROLE = /^[a-z][a-z0-9_-]{1,40}$/;
import {validateOAuthSettings} from '../platform/oauth.mjs';
const REF = /^(?:vault:\/\/[a-zA-Z0-9/_-]{3,180}|env:\/\/[A-Z][A-Z0-9_]{2,79})$/;

export class CompanyPolicyStore {
  constructor(path, tenant) {
    check(typeof tenant === 'string' && ID.test(tenant), 'Invalid tenant');
    mkdirSync(dirname(path), {recursive:true, mode:0o700});
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS company_connections(
        tenant TEXT NOT NULL, connector_id TEXT NOT NULL, provider TEXT NOT NULL,
        display_name TEXT NOT NULL, secret_ref TEXT, requested_scopes TEXT NOT NULL,
        state TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(tenant,connector_id));
      CREATE TABLE IF NOT EXISTS company_capabilities(
        tenant TEXT NOT NULL, capability_id TEXT NOT NULL, enabled INTEGER NOT NULL,
        connection_id TEXT, approver_roles TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(tenant,capability_id));
      CREATE TABLE IF NOT EXISTS company_slack_roles(
        tenant TEXT NOT NULL, team_id TEXT NOT NULL, slack_user_id TEXT NOT NULL,
        role TEXT NOT NULL, scopes TEXT NOT NULL,
        PRIMARY KEY(tenant,team_id,slack_user_id));
      CREATE TABLE IF NOT EXISTS company_ai_settings(tenant TEXT PRIMARY KEY,provider TEXT NOT NULL,model TEXT NOT NULL,secret_ref TEXT NOT NULL,approval_context INTEGER NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_audit(
        id INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL, actor TEXT NOT NULL,
        event TEXT NOT NULL, at TEXT NOT NULL, summary TEXT NOT NULL);
    `);
    const columns=this.db.prepare('PRAGMA table_info(company_connections)').all();
    if(!columns.some(c=>c.name==='settings'))this.db.exec("ALTER TABLE company_connections ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'");
    try { chmodSync(path,0o600); } catch { /* Windows ACLs */ }
    this.tenant = tenant;
  }
  close() { this.db.close(); }
  #audit(actor,event,summary) {
    check(typeof actor==='string' && actor.length >= 2 && actor.length <= 100, 'Admin identity required');
    this.db.prepare('INSERT INTO admin_audit(tenant,actor,event,at,summary) VALUES (?,?,?,?,?)')
      .run(this.tenant,actor,event,new Date().toISOString(),summary);
  }
  connection(id) { const r=this.db.prepare('SELECT * FROM company_connections WHERE tenant=? AND connector_id=?').get(this.tenant,id); return r?{...r,requested_scopes:parse(r.requested_scopes),settings:parse(r.settings||'{}')}:null; }
  connections() { return this.db.prepare('SELECT * FROM company_connections WHERE tenant=? ORDER BY connector_id').all(this.tenant).map(r=>({...r,requested_scopes:parse(r.requested_scopes),settings:parse(r.settings||'{}')})); }
  upsertConnection({id, provider, displayName, secretRef = null, scopes = [], settings = {}, actor}) {
    check(typeof actor==='string' && actor.length>=2 && actor.length<=100,'Admin identity required');
    check(typeof id==='string' && ID.test(id), 'Invalid connector ID');
    check(typeof provider==='string' && ID.test(provider), 'Invalid provider');
    check(typeof displayName==='string' && displayName.trim() && displayName.length <= 100, 'Invalid name');
    check(secretRef===null || (typeof secretRef==='string' && REF.test(secretRef)), 'Use a vault:// reference, never paste a key');
    const requested=strArray(scopes, SCOPERE, 'scopes');
    check(settings&&typeof settings==='object'&&!Array.isArray(settings)&&Object.keys(settings).every(k=>['baseUrl','testPath','oauth'].includes(k)),'Only approved non-secret connection settings are allowed');
    if(settings.baseUrl){const u=new URL(settings.baseUrl);check((u.protocol==='https:'||(u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)))&&!u.username&&!u.password&&!u.search&&!u.hash,'Invalid REST base URL')}
    if(settings.oauth)settings={...settings,oauth:validateOAuthSettings(settings.oauth)};
    if(settings.testPath)check(typeof settings.testPath==='string'&&settings.testPath.startsWith('/')&&!settings.testPath.startsWith('//')&&!settings.testPath.includes('..')&&!settings.testPath.includes('#'),'Invalid fixed probe path');
    // Reference configuration does not establish a live connection: verify with adapter separately.
    this.db.prepare(`INSERT INTO company_connections(tenant,connector_id,provider,display_name,secret_ref,requested_scopes,state,updated_at,settings) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant,connector_id)
      DO UPDATE SET provider=excluded.provider,display_name=excluded.display_name,
      secret_ref=excluded.secret_ref,requested_scopes=excluded.requested_scopes,state='unverified',updated_at=excluded.updated_at`)
      .run(this.tenant,id,provider,displayName.trim(),secretRef,json(requested),'unverified',new Date().toISOString(),json(settings));
    this.#audit(actor,'connection.configure',`${id}:${provider} (credentials not stored)`);
    return this.connection(id);
  }
  setConnectionState(id, state, actor) {
    check(typeof actor==='string' && actor.length>=2 && actor.length<=100,'Admin identity required');
    check(['verified','needs_attention','unverified'].includes(state),'Invalid connection state');
    const x=this.db.prepare('UPDATE company_connections SET state=?,updated_at=? WHERE tenant=? AND connector_id=?')
      .run(state,new Date().toISOString(),this.tenant,id);
    check(x.changes===1,'Unknown connection');
    this.#audit(actor,'connection.status',`${id}:${state}`);
  }
  binding(id) { const x=this.db.prepare('SELECT * FROM company_capabilities WHERE tenant=? AND capability_id=?').get(this.tenant,id);return x?{...x,enabled:!!x.enabled,approver_roles:parse(x.approver_roles)}:null; }
  bindings() { return this.db.prepare('SELECT * FROM company_capabilities WHERE tenant=? ORDER BY capability_id').all(this.tenant).map(x=>({...x,enabled:!!x.enabled,approver_roles:parse(x.approver_roles)})); }
  upsertCapability({id,enabled=false,connectionId=null,roles=['manager'],actor,registry}) {
    check(typeof actor==='string' && actor.length>=2 && actor.length<=100,'Admin identity required');
    check(typeof id==='string' && CAP.test(id), 'Invalid capability ID');
    check(registry?.get(id), 'Only a preinstalled capability may be enabled');
    check(typeof enabled==='boolean', 'Enabled must be Boolean');
    check(connectionId===null || this.connection(connectionId), 'Unknown connector');
    const allowed=strArray(roles, ROLE,'roles');
    check(allowed.length>0,'At least one approval role required');
    this.db.prepare(`INSERT INTO company_capabilities VALUES (?,?,?,?,?,?) ON CONFLICT(tenant,capability_id)
      DO UPDATE SET enabled=excluded.enabled,connection_id=excluded.connection_id,
      approver_roles=excluded.approver_roles,updated_at=excluded.updated_at`)
      .run(this.tenant,id,enabled?1:0,connectionId,json(allowed),new Date().toISOString());
    this.#audit(actor,'capability.configure',`${id} enabled=${enabled}`);
    return this.binding(id);
  }
  setSlackUser({teamId,userId,role='manager',scopes=[],actor}) {
    check(typeof actor==='string' && actor.length>=2 && actor.length<=100,'Admin identity required');
    check(typeof teamId==='string' && SLACK.test(teamId), 'Invalid Slack workspace');
    check(typeof userId==='string' && SLACK.test(userId), 'Invalid Slack user');
    check(ROLE.test(role), 'Invalid role');
    const scopeList=strArray(scopes,SCOPERE,'scopes');
    this.db.prepare(`INSERT INTO company_slack_roles VALUES (?,?,?,?,?) ON CONFLICT(tenant,team_id,slack_user_id)
      DO UPDATE SET role=excluded.role,scopes=excluded.scopes`)
      .run(this.tenant,teamId,userId,role,json(scopeList));
    this.#audit(actor,'slack.assign',`${teamId}:${userId} role=${role}`);
  }
  slackUsers() { return this.db.prepare('SELECT * FROM company_slack_roles WHERE tenant=?').all(this.tenant).map(r=>({...r,scopes:parse(r.scopes)})); }
  principal(teamId,userId) {
    const r=this.db.prepare('SELECT * FROM company_slack_roles WHERE tenant=? AND team_id=? AND slack_user_id=?')
      .get(this.tenant,teamId,userId);
    return r?{actor:`slack:${teamId}:${userId}`,tenant:this.tenant,role:r.role,scopes:parse(r.scopes)}:null;
  }
  /** Call this from the host's runtime.canApprove; never trust role/scopes from Slack payload. */
  canApprove({actor,plan,registry}) {
    const user=this.db.prepare('SELECT * FROM company_slack_roles WHERE tenant=?').all(this.tenant)
      .find(row=>`slack:${row.team_id}:${row.slack_user_id}`===actor);
    if(!user) return false;
    const scopes=new Set(parse(user.scopes));
    for(const step of plan.steps){
      const cap=registry.get(step.tool), binding=this.binding(step.tool);
      if(!cap || !binding?.enabled || !binding.approver_roles.includes(user.role)) return false;
      if(binding.connection_id && this.connection(binding.connection_id)?.state!=='verified') return false;
      if(!cap.requiredScopes.every(scope=>scopes.has(scope))) return false;
    }
    return true;
  }
  aiSettings(){
    const row=this.db.prepare('SELECT * FROM company_ai_settings WHERE tenant=?').get(this.tenant);
    return row?{provider:row.provider,model:row.model,secretRef:row.secret_ref,approvalContext:!!row.approval_context}:null;
  }
  setAiSettings({provider,model,secretRef,approvalContext=false,actor}){
    check(['openai','anthropic'].includes(provider),'Unsupported AI provider');
    check(typeof model==='string'&&/^[a-zA-Z0-9_.:/-]{2,160}$/.test(model),'Invalid AI model ID');
    check(typeof secretRef==='string'&&REF.test(secretRef),'AI key must be a vault/env secret reference');
    check(typeof approvalContext==='boolean','Invalid approval disclosure setting');
    this.db.prepare('INSERT INTO company_ai_settings VALUES(?,?,?,?,?,?) ON CONFLICT(tenant) DO UPDATE SET provider=excluded.provider,model=excluded.model,secret_ref=excluded.secret_ref,approval_context=excluded.approval_context,updated_at=excluded.updated_at')
      .run(this.tenant,provider,model,secretRef,approvalContext?1:0,new Date().toISOString());
    this.#audit(actor,'ai.configure',`${provider} model configured; raw key not stored`);
    return {provider,model,hasSecretRef:true,approvalContext};
  }
  snapshot(registry) {
    const list=registry.list();
    return {tenant:this.tenant,aiSettings:this.aiSettings()?{provider:this.aiSettings().provider,model:this.aiSettings().model,hasSecretRef:true,approvalContext:this.aiSettings().approvalContext}:null,connections:this.connections().map(({secret_ref,...rest})=>({...rest,has_secret_ref:!!secret_ref})),
      capabilities:list.map(cap=>({...cap,policy:this.binding(cap.id)})),slackUsers:this.slackUsers()};
  }
}
