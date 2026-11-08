/** Provider-neutral, human-governed discovery and execution kernel.
 * The agent can only suggest plans. This module alone authorizes side effects.
 * No Slack / CRM / model provider appears in this kernel.
 */
import { createHash, randomUUID,randomBytes,createCipheriv,createDecipheriv } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

const json = value => JSON.stringify(value, (_key, val) => val, 0);
export const fingerprint = value => createHash('sha256').update(json(sortKeys(value))).digest('hex');
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, sortKeys(value[k])]));
  return value;
}
function ensure(test, message) { if (!test) throw new Error(message); }
const clone = value => structuredClone(value);
// Credentials are runtime-only. A generated plan must never become a secret vault.
function hasCredential(value) {
  if (Array.isArray(value)) return value.some(hasCredential);
  if (value && typeof value === 'object') return Object.entries(value).some(([key, child]) =>
    /(?:^|[_-])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|bearer|credential)(?:$|[_-])/i.test(key) || hasCredential(child));
  return typeof value === 'string' && /\bbh_[A-Za-z0-9_-]{14,}\b/.test(value);
}

/** Runtime-only action executors; the LLM sees list() metadata, never callbacks or credentials. */
export class CapabilityRegistry {
  #items = new Map();
  register({ id, description, mode = 'read', requiredScopes = [], validate = () => true, execute, verify }) {
    ensure(typeof id === 'string' && /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/.test(id), 'Invalid namespaced capability ID');
    ensure(!this.#items.has(id), `Duplicate capability ${id}`);
    ensure(['read', 'write', 'notify'].includes(mode), 'Invalid capability mode');
    ensure(typeof execute === 'function' && typeof validate === 'function', 'Capability requires executor and validator');
    ensure(Array.isArray(requiredScopes) && requiredScopes.every(s => typeof s === 'string'), 'Invalid scope manifest');
    if (mode !== 'read') ensure(typeof verify === 'function', 'Side-effect capabilities require read-back verification');
    this.#items.set(id, Object.freeze({ id, description, mode, requiredScopes, validate, execute, verify }));
    return this;
  }
  list() { return [...this.#items.values()].map(({ id, description, mode, requiredScopes }) => ({ id, description, mode, requiredScopes })); }
  get(id) { return this.#items.get(id); }
  async read(id, args, context) {
    const cap = this.get(id);
    ensure(cap && cap.mode === 'read', `No read capability ${id}`);
    ensure(cap.validate(args), `Invalid arguments for ${id}`);
    return cap.execute(clone(args), context);
  }
}

/** Durable decisions and operation receipts. Does not store API keys. */
export class SqliteJournal {
  #key;
  constructor(filePath,{key=null}={}) {
    if(key&&(!Buffer.isBuffer(key)||key.length!==32))throw Error('Journal encryption requires a 32-byte key');
    this.#key=key?Buffer.from(key):null;
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filePath);
    try { chmodSync(filePath, 0o600); } catch { /* Windows uses ACLs. */ }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS findings(
        id TEXT PRIMARY KEY, tenant TEXT NOT NULL, fingerprint TEXT NOT NULL,
        data TEXT NOT NULL, discovery_decision TEXT, state TEXT NOT NULL,
        selected_plan TEXT, approved_by TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS actions(
        id TEXT PRIMARY KEY, finding_id TEXT NOT NULL, step_index INTEGER NOT NULL,
        state TEXT NOT NULL, receipt TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events(
        id TEXT PRIMARY KEY, finding_id TEXT NOT NULL, event TEXT NOT NULL,
        actor TEXT NOT NULL, timestamp TEXT NOT NULL, details TEXT
      );
    `);
  }
  close() { this.db.close();this.#key?.fill(0); }
  #encode(value,domain,id){
    const payload=json(value);
    if(!this.#key)return payload;
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.#key,iv);
    cipher.setAAD(Buffer.from(`${domain}:${id}`));
    const encrypted=Buffer.concat([cipher.update(payload,'utf8'),cipher.final()]);
    return `enc:v1:${Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64')}`;
  }
  #decode(value,domain,id){
    if(!value.startsWith('enc:v1:'))return JSON.parse(value);
    if(!this.#key)throw Error('Encrypted journal requires OPS_AGENT_MASTER_KEY');
    const buf=Buffer.from(value.slice(7),'base64');
    if(buf.length<29)throw Error('Corrupt journal cipher');
    const cipher=createDecipheriv('aes-256-gcm',this.#key,buf.subarray(0,12));
    cipher.setAAD(Buffer.from(`${domain}:${id}`));cipher.setAuthTag(buf.subarray(12,28));
    return JSON.parse(Buffer.concat([cipher.update(buf.subarray(28)),cipher.final()]).toString('utf8'));
  }
  get(id) {
    const row = this.db.prepare('SELECT * FROM findings WHERE id=?').get(id);
    return row ? { ...row, data: this.#decode(row.data,'finding',id) } : null;
  }
  save(record) {
    this.db.prepare(`INSERT INTO findings VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data, discovery_decision=excluded.discovery_decision,
      state=excluded.state, selected_plan=excluded.selected_plan,
      approved_by=excluded.approved_by, updated_at=excluded.updated_at`).run(
        record.id, record.tenant, record.fingerprint, this.#encode(record.data,'finding',record.id), record.discovery_decision,
        record.state, record.selected_plan, record.approved_by, new Date().toISOString());
  }
  event(findingId, event, actor, details = null) {
    this.db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?)').run(
      randomUUID(), findingId, event, actor, new Date().toISOString(), details ? this.#encode(details,'event',findingId) : null);
  }
  action(id) { return this.db.prepare('SELECT * FROM actions WHERE id=?').get(id) || null; }
  actionSet(id, findingId, step, state, receipt = null) {
    this.db.prepare(`INSERT INTO actions VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state,receipt=excluded.receipt,updated_at=excluded.updated_at`).run(
        id, findingId, step, state, receipt ? this.#encode(receipt,'receipt',id) : null, new Date().toISOString());
  }
  history(findingId) { return this.db.prepare('SELECT event, actor, timestamp FROM events WHERE finding_id=? ORDER BY timestamp').all(findingId); }
  list(tenant,limit=300) { return this.db.prepare('SELECT id,tenant,discovery_decision,state,selected_plan,approved_by,updated_at,data FROM findings WHERE tenant=? ORDER BY updated_at DESC LIMIT ?').all(tenant,limit).map(row=>({...row,data:this.#decode(row.data,'finding',row.id)})); }
}

export class GovernedAgentRuntime {
  constructor({ registry, journal, canApprove = () => false, canExecute = () => true, tenantId }) {
    ensure(registry && journal && tenantId, 'Registry, journal and tenantId are required');
    Object.assign(this, { registry, journal, canApprove, canExecute, tenantId });
  }
  /** The only accepted discovery input is an evidence-supported hypothesis. */
  discover({ type, summary, evidenceRefs, confidence = 'unknown', explanation = '' }) {
    ensure(typeof type === 'string' && type.length > 2, 'Discovery type required');
    ensure(typeof summary === 'string' && summary.length > 4, 'Discovery summary required');
    ensure(Array.isArray(evidenceRefs) && evidenceRefs.length > 0 && evidenceRefs.every(x => typeof x === 'string' && x.trim()), 'Evidence references required');
    ensure(!hasCredential({ type, summary, evidenceRefs, explanation }), 'Never store credentials in findings');
    ensure(['unknown', 'low', 'medium', 'high'].includes(confidence), 'Unknown confidence label');
    const evidence = [...new Set(evidenceRefs)].sort();
    const digest = fingerprint({ tenant: this.tenantId, type, evidence });
    const id = `finding-${digest.slice(0,24)}`;
    const existing = this.journal.get(id);
    if (existing) return { ...existing, repeated: true };
    const record = {
      id, tenant: this.tenantId, fingerprint: digest,
      data: { type, summary, evidenceRefs: evidence, confidence, explanation, plans: [] },
      discovery_decision: null, state: 'discovered', selected_plan: null, approved_by: null
    };
    this.journal.save(record);
    this.journal.event(id, 'discovered', 'agent', { evidenceCount: evidence.length });
    return record;
  }
  /** Decision 1: accepting a pattern authorizes investigation, NEVER any write. */
  decideDiscovery(id, { decision, actor }) {
    const f = this.#finding(id);
    ensure(['investigate', 'monitor', 'dismiss'].includes(decision), 'Invalid discovery decision');
    ensure(typeof actor === 'string' && actor.trim(), 'Actor required');
    ensure(!['executing', 'applied'].includes(f.state), 'Already executing/applied');
    f.discovery_decision = decision;
    f.state = decision === 'dismiss' ? 'dismissed' : 'investigating';
    this.journal.save(f);
    this.journal.event(id, `decision1:${decision}`, actor);
    return f;
  }
  /** Agent or human proposes a plan using actual registered capabilities. No fixed remedies. */
  proposePlan(id, { title, explanation = '', steps, author = 'agent' }) {
    const f = this.#finding(id);
    ensure(f.discovery_decision === 'investigate', 'Decision 1 must allow investigation before generating action plans');
    ensure(f.state === 'investigating', 'Findings with approved actions require a new review');
    ensure(typeof title === 'string' && title.trim() && Array.isArray(steps) && steps.length && steps.length <= 20, 'Invalid plan');
    const validated = steps.map((s, index) => {
      ensure(s && typeof s.tool === 'string' && s.args && typeof s.args === 'object' && !Array.isArray(s.args), `Invalid step ${index}`);
      const cap = this.registry.get(s.tool);
      ensure(cap, `Tool ${s.tool} has not been installed/approved as a connector`);
      ensure(!hasCredential(s.args), `Credentials must be supplied by a trusted runtime resolver, never inside plan args`);
      ensure(cap.validate(s.args), `Invalid input to ${s.tool}`);
      ensure(typeof s.reason === 'string' && s.reason.trim(), `Missing justification for ${s.tool}`);
      return { tool: s.tool, args: clone(s.args), reason: s.reason, mode: cap.mode };
    });
    const planId = `plan-${fingerprint({ finding: id, title, validated }).slice(0,24)}`;
    const plan = { id: planId, title, explanation, steps: validated, digest: fingerprint(validated), author };
    if (!f.data.plans.some(p => p.id === planId)) f.data.plans.push(plan);
    this.journal.save(f);
    this.journal.event(id, 'plan-proposed', author, { planId, stepCount: validated.length });
    return plan;
  }
  /** Decision 2: explicit human approval of a specific, immutable plan. */
  async decidePlan(id, { planId, decision, actor, context = {} }) {
    const f = this.#finding(id);
    ensure(typeof actor === 'string' && actor.trim(), 'Actor required');
    ensure(['approve', 'reject'].includes(decision), 'Unknown plan decision');
    ensure(f.discovery_decision === 'investigate', 'Discovery not accepted');
    ensure(f.state === 'investigating', 'Decision already applied to finding');
    const plan = f.data.plans.find(p => p.id === planId);
    ensure(plan, 'Selected plan missing or stale');
    if (decision === 'approve') {
      ensure(await this.canApprove({ tenant: this.tenantId, actor, plan: clone(plan), finding: clone(f.data), context }), 'Approver not authorized for the proposed scope');
      for (const step of plan.steps) {
        const cap = this.registry.get(step.tool);
        ensure(cap && cap.mode === step.mode && cap.validate(step.args), 'Plan capability changed. Re-review required');
        const scopes = new Set(context.scopes || []);
        ensure(cap.requiredScopes.every(scope => scopes.has(scope)), `Missing authorized scope for ${step.tool}`);
      }
    }
    f.selected_plan = planId;
    f.approved_by = decision === 'approve' ? actor : null;
    f.state = decision === 'approve' ? 'approved' : 'rejected';
    this.journal.save(f);
    this.journal.event(id, `decision2:${decision}`, actor, { planId });
    return f;
  }
  /** After an approved Slack/Teams/dashboard decision, the backend performs only the exact plan. */
  async execute(id, { context = {} } = {}) {
    const f = this.#finding(id);
    ensure(f.state === 'approved' || f.state === 'blocked', 'No approved plan to execute');
    const plan = f.data.plans.find(p => p.id === f.selected_plan);
    ensure(plan && plan.digest === fingerprint(plan.steps), 'Approved plan has changed');
    if (f.state === 'blocked') throw new Error('Blocked operations require manual investigation and a new approval');
    ensure(await this.canExecute({tenant:this.tenantId,actor:f.approved_by,plan:clone(plan),finding:clone(f.data),context}), 'Approval or execution permission was revoked');
    f.state = 'executing'; this.journal.save(f);
    for (const [index, step] of plan.steps.entries()) {
      const cap = this.registry.get(step.tool);
      const op = fingerprint({ tenant: this.tenantId, plan: plan.id, step: index, args: step.args });
      const prior = this.journal.action(op);
      if (prior?.state === 'verified') continue;
      if (prior) {
        f.state = 'blocked'; this.journal.save(f);
        throw new Error(`Step ${index} has an uncertain outcome. Inspect and verify before retrying.`);
      }
      if (!cap || cap.mode !== step.mode || !cap.validate(step.args)) {
        f.state = 'blocked'; this.journal.save(f);
        throw new Error(`Capability ${step.tool} changed after approval`);
      }
      try {
        ensure(await this.canExecute({tenant:this.tenantId,actor:f.approved_by,plan:clone(plan),finding:clone(f.data),context}), 'Execution permission revoked before next step');
        this.journal.actionSet(op, id, index, 'sent');
        const result = await cap.execute(clone(step.args), { ...context, tenantId: this.tenantId, approvedBy: f.approved_by, operationId: op });
        if (cap.mode !== 'read') {
          const verified = await cap.verify(clone(step.args), result, { ...context, operationId: op });
          ensure(verified === true, `Read-back / delivery verification failed for ${step.tool}`);
        }
        this.journal.actionSet(op, id, index, 'verified', { verified: true });
        this.journal.event(id, 'step:verified', 'runtime', { index, tool: step.tool });
      } catch (err) {
        f.state = 'blocked'; this.journal.save(f);
        this.journal.event(id, 'step:blocked', 'runtime', { index, tool: step.tool, reason: String(err.message).slice(0,160) });
        throw err;
      }
    }
    f.state = 'applied'; this.journal.save(f);
    this.journal.event(id, 'plan:applied', 'runtime', { planId: plan.id });
    return f;
  }
  #finding(id) {
    const f = this.journal.get(id);
    ensure(f && f.tenant === this.tenantId, 'Finding not found in this tenant');
    return f;
  }
}
