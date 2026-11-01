import { hash, stable } from './config.js';
import { plan, guard, guardHash, websiteIdentity, identityScore, nameKey, needsChow, amount, appendNote } from './reconcile.js';

const matches = (account, body) => Object.entries(body).every(([key, value]) => stable(account[key] ?? null) === stable(value ?? null));
const resolveBody = (body, createdId) => Object.fromEntries(Object.entries(body).map(([key, value]) => {
  if (value === '$created_id' && !createdId) throw new Error('The new CHOW account has not been verified.');
  return [key, value === '$created_id' ? createdId : value];
}));

export class ReviewService {
  constructor({ config, client, store, readWebsite, verifyWebsite }) {
    Object.assign(this, { config, client, store, readWebsite, verifyWebsite });
  }
  async scan() {
    return this.store.withLock(async () => {
      try {
        const website = await this.readWebsite();
        this.checkCoverage(website);
        // Search the whole CRM, not only q=brand or children of the current parent.
        const accounts = await this.client.list('accounts');
        const contacts = await this.client.list('contacts');
        const snapshot = { website, accounts, contacts };
        const result = plan(snapshot, this.config);
        return this.store.publish(snapshot, result);
      } catch (error) {
        this.store.recordRun('failed', { error: error.message });
        throw error;
      }
    });
  }
  checkCoverage(website) {
    if (!website.complete) throw new Error('Incomplete public-site discovery; no reconciliation is allowed.');
    const previous = this.store.latest()?.snapshot.website.locations.length;
    if (previous && website.locations.length < previous * (1 - this.config.maxDropFraction)) {
      throw new Error('Facility count dropped beyond maxDropFraction. Investigate website coverage before proposing removals; adjust the configured threshold only after verification.');
    }
  }
  view() {
    const latest = this.store.latest();
    return { latest: latest ? { at: latest.at, summary: latest.summary, company: latest.snapshot.website.company,
      coverage: latest.snapshot.website.coverage, matches: latest.result.matches, notices: latest.result.notices } : null,
      proposals: this.store.list().map(p => ({ ...p, operations: this.store.operations(p.id) })), audit: this.store.audit() };
  }
  async decide(id, { decision, revision, reviewer, note = '' }) {
    if (!['approve', 'reject', 'retry'].includes(decision)) throw new Error('Unknown decision.');
    if (typeof reviewer !== 'string' || !reviewer.trim() || reviewer.length > 100 || typeof note !== 'string' || note.length > 2000) {
      throw new Error('A reviewer name is required (max 100 characters); notes are limited to 2,000 characters.');
    }
    return this.store.withLock(async () => {
      const item = this.store.get(id);
      if (!item || item.revision !== revision) throw new Error('This proposal is missing or stale. Refresh the review page.');
      if (['applied', 'rejected'].includes(item.status)) return { status: item.status, alreadyDecided: true };
      if (decision === 'retry') {
        if (!['approved', 'applying', 'blocked'].includes(item.status)) throw new Error('Only an already-approved operation can be resumed.');
      } else if (item.status !== 'pending') throw new Error('Only pending proposals can be approved or rejected.');
      this.store.decision(id, decision, reviewer.trim(), note);
      if (decision === 'reject') { this.store.setStatus(id, 'rejected'); return { status: 'rejected' }; }
      // Persist explicit approval BEFORE any network write. Daily scans never call apply().
      this.store.setStatus(id, 'approved');
      try {
        await this.apply(item);
        this.store.setStatus(id, 'applied');
        this.store.decision(id, 'applied', reviewer.trim());
        return { status: 'applied' };
      } catch (error) {
        this.store.setStatus(id, 'blocked', error.message);
        this.store.decision(id, 'blocked', reviewer.trim(), error.message);
        throw error;
      }
    });
  }
  assertBody(item, step, body, current) {
    const f = this.config.fields;
    const allowed = new Set(['name', 'parent', 'street', 'city', 'state', 'zip', 'phone', 'care', 'status', 'note', 'duplicate', 'chow'].map(key => f[key]));
    if (Object.keys(body).some(key => !allowed.has(key))) throw new Error('A write contains unsupported or financial fields.');
    if (body[f.status] && !['Active', 'Inactive', 'Needs Review'].includes(body[f.status])) throw new Error('Invalid account status.');
    if (step.method === 'POST') {
      if (!body[f.name] || (item.kind !== 'create_parent' && !body[f.parent])) throw new Error('Creation is missing a name or parent.');
      if (body[f.duplicate] || body[f.chow]) throw new Error('New accounts cannot inherit duplicate/CHOW links.');
      return;
    }
    if (item.kind === 'chow') {
      if (Object.keys(body).length !== 1 || !body[f.chow] || body[f.chow] === step.id) throw new Error('CHOW may only set the old account\'s current-account link.');
      if (needsChow(current, this.config) !== true && !matches(current, body)) throw new Error('Billing conditions changed; the CHOW decision needs a fresh review.');
    }
    if (Object.hasOwn(body, f.parent)) {
      if (item.kind !== 'reparent' || needsChow(current, this.config) !== false) throw new Error('Direct re-parenting is blocked by billing history or invalid billing data.');
    }
    if (item.kind === 'duplicate' && (body[f.status] !== 'Inactive' || !body[f.duplicate] || body[f.duplicate] === step.id)) {
      throw new Error('Duplicate disposition must identify a different survivor and mark the losing copy Inactive.');
    }
    if (['missing_from_site', 'flag_ambiguous'].includes(item.kind) &&
        (body[f.status] !== 'Needs Review' || Object.keys(body).some(key => ![f.status, f.note].includes(key)))) {
      throw new Error('An uncertain identity/absence may only flag status and append a note.');
    }
  }
  async verifyGuards(item, createdId) {
    for (const check of item.checks) {
      const current = await this.client.get(check.id);
      if (guardHash(current, this.config) === hash(check.before)) continue;
      // A previously sent PATCH may have succeeded before its response/checkpoint was lost.
      const ownSteps = item.steps.filter(step => step.method === 'PATCH' && step.id === check.id);
      const expectedAfter = { ...check.before };
      let resolvable = true;
      for (const step of ownSteps) {
        if (Object.values(step.body).includes('$created_id') && !createdId) { resolvable = false; break; }
        Object.assign(expectedAfter, resolveBody(step.body, createdId));
      }
      if (resolvable && ownSteps.length && stable(guard(current, this.config)) === stable(expectedAfter)) continue;
      throw new Error(`CRM account ${check.id} changed since review. No further writes were attempted; scan again and review the fresh evidence.`);
    }
  }
  async apply(item) {
    this.store.setStatus(item.id, 'applying');
    // Website evidence is re-read immediately before applying an approved plan.
    if (this.verifyWebsite) await this.verifyWebsite(item);
    else {
      const current = await this.readWebsite();
      this.checkCoverage(current);
      if (item.website) {
        const observed = item.website.record_type === 'company' ? current.company
          : current.locations.find(location => location.source_url === item.website.source_url);
        if (!observed || hash(websiteIdentity(observed)) !== hash(websiteIdentity(item.website))) throw new Error('Website evidence changed; scan again before approving a replacement proposal.');
      } else if (item.kind === 'missing_from_site') {
        const account = item.evidence.accounts[0];
        if (current.locations.some(location => identityScore(location, account, this.config) >= 50)) throw new Error('The previously absent account now has a website candidate; scan again.');
      }
    }
    const f = this.config.fields;
    let createdId = this.store.operation(hash(`${item.id}:0`))?.createdId;
    // Recover a lost create response before checking the old CHOW link on a retry.
    if (item.steps[0]?.method === 'POST') {
      const opId = hash(`${item.id}:0`), marker = `[review-op:${opId}]`;
      const found = (await this.client.list('accounts')).filter(a => String(a[f.note] || '').includes(marker));
      if (found.length > 1) throw new Error('Multiple accounts carry this operation marker; manual investigation is required.');
      if (found.length === 1) createdId = found[0][f.id];
    }
    await this.verifyGuards(item, createdId);
    for (const [index, step] of item.steps.entries()) {
      const opId = hash(`${item.id}:${index}`);
      const operation = this.store.operation(opId);
      const body = resolveBody(step.body, createdId);
      if (step.method === 'POST') {
        const marker = `[review-op:${opId}]`;
        body[f.note] = appendNote(body[f.note], `${marker} Source: ${item.website?.source_url || this.config.siteUrl}`);
        this.assertBody(item, step, body);
        const all = await this.client.list('accounts');
        const recovered = all.filter(a => String(a[f.note] || '').includes(marker));
        if (recovered.length > 1) throw new Error('Duplicate operation markers found; no further writes are safe.');
        let created = recovered[0];
        if (!created && operation) {
          // A server without documented idempotency cannot guarantee exactly-once POST.
          // Failure-closed is safer than creating a second account after an ambiguous timeout.
          throw new Error('The previous create has an uncertain outcome and its marker is not visible. No second POST was sent. Verify the CRM manually before resolving this case.');
        }
        if (!created) {
          const ignore = new Set(item.kind === 'chow' ? [item.steps[1].id] : []);
          const conflict = all.some(a => !ignore.has(a[f.id]) && !a[f.duplicate] && !a[f.chow] &&
            (item.kind === 'create_parent' ? !a[f.parent] && nameKey(a[f.name]) === nameKey(item.website.name)
              : identityScore(item.website, a, this.config) >= 85));
          if (conflict) throw new Error('A potential matching account appeared before creation. Scan again; no new account was created.');
          this.store.saveOperation(opId, item.id, index, 'sent', { method: 'POST', body });
          try {
            created = await this.client.create(body);
            createdId = created[f.id];
            this.store.saveOperation(opId, item.id, index, 'unverified', { method: 'POST', body, createdId });
            created = await this.client.get(createdId);
          } catch (error) {
            this.store.saveOperation(opId, item.id, index, 'uncertain', { method: 'POST', body, createdId, error: error.message });
            throw error;
          }
        }
        if (!matches(created, body) || amount(created[f.revenue]) !== 0 || amount(created[f.ar]) !== 0) {
          throw new Error('The created account could not be verified (including zero initial billing). The old account was not modified; inspect the created record.');
        }
        createdId = created[f.id];
        this.store.saveOperation(opId, item.id, index, 'applied', { method: 'POST', body, createdId });
      } else if (step.method === 'PATCH') {
        const current = await this.client.get(step.id);
        this.assertBody(item, step, body, current);
        if (matches(current, body)) {
          this.store.saveOperation(opId, item.id, index, 'applied', { method: 'PATCH', body, targetId: step.id });
          continue;
        }
        const check = item.checks.find(entry => entry.id === step.id);
        if (!check || guardHash(current, this.config) !== hash(check.before)) throw new Error('The target changed immediately before writeback; refusing to overwrite it.');
        if (item.kind === 'chow') {
          const newAccount = await this.client.get(createdId);
          if (!matches(newAccount, item.steps[0].body)) throw new Error('The new CHOW account changed; the old link was not written.');
        }
        this.store.saveOperation(opId, item.id, index, 'sent', { method: 'PATCH', body, targetId: step.id });
        try {
          await this.client.patch(step.id, body);
          const after = await this.client.get(step.id);
          const expected = { ...check.before, ...body };
          if (stable(guard(after, this.config)) !== stable(expected)) throw new Error('Read-back differs from the approved patch, or an unrelated business field changed. Inspect the CRM; no additional writes were attempted.');
          this.store.saveOperation(opId, item.id, index, 'applied', { method: 'PATCH', body, targetId: step.id });
        } catch (error) {
          this.store.saveOperation(opId, item.id, index, 'uncertain', { method: 'PATCH', body, targetId: step.id, error: error.message });
          throw error;
        }
      } else throw new Error('Only POST and PATCH operations are permitted after approval.');
    }
  }
}
