import { hash, stable } from './config.js';
import { plan, guard, guardHash, websiteIdentity, identityScore, nameKey, needsChow, amount, appendNote, contactGuard, normalize } from './reconcile.js';

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
        const result = plan(snapshot, this.config, { manualLinks: this.store.manualLinks() });
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
    return { lastAttempt: this.store.latestAttempt(), latest: latest ? { at: latest.at, summary: latest.summary, company: latest.snapshot.website.company,
      coverage: latest.snapshot.website.coverage, matches: latest.result.matches, notices: latest.result.notices } : null,
      accountNames: Object.fromEntries((latest?.snapshot.accounts || []).map(a => [a[this.config.fields.id], a[this.config.fields.name]])),
      manualLinks: this.store.manualLinks(),
      matchChoices: latest?.snapshot.accounts.map(account => Object.fromEntries(
        ['id', 'name', 'street', 'city', 'state', 'care', 'parent', 'revenue', 'ar']
          .map(key => [key, account[this.config.fields[key]] ?? null]))) || [],
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
      if (decision !== 'reject' && this.store.latestAttempt()?.status === 'failed') throw new Error('The latest scan failed. Complete a successful scan before approving or resuming changes.');
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
  async decideGroup({ groupKey, members, decision, reviewer, note = '' }) {
    if (!['approve', 'reject'].includes(decision)) throw new Error('Group decisions must be Approve or Reject.');
    if (!groupKey || typeof reviewer !== 'string' || !reviewer.trim() || reviewer.length > 100 ||
        typeof note !== 'string' || note.length > 2000 || !Array.isArray(members) || !members.length) {
      throw new Error('Missing group, reviewer or member revisions.');
    }
    return this.store.withLock(async () => {
      const pending = this.store.list().filter(p => p.groupKey === groupKey && p.status === 'pending');
      const received = new Map(members.map(member => [member.id, member.revision]));
      if (members.length !== received.size || pending.length !== received.size ||
          pending.some(item => received.get(item.id) !== item.revision)) {
        throw new Error('The group changed since it was shown. Refresh before deciding. Nothing was written.');
      }
      if (decision === 'approve' && this.store.latestAttempt()?.status === 'failed') throw new Error('The latest scan failed. Scan successfully before approving changes.');
      // Public evidence is fetched once per batch; CRM targets are still checked individually.
      const website = decision === 'approve' && !this.verifyWebsite ? await this.readWebsite() : null;
      // A single explicit group approval is persisted against EVERY reviewed individual revision.
      for (const item of pending) {
        this.store.decision(item.id, `${decision}-group`, reviewer.trim(), `Group ${groupKey}. ${note}`);
        this.store.setStatus(item.id, decision === 'reject' ? 'rejected' : 'approved');
      }
      if (decision === 'reject') return { status: 'rejected', rejected: pending.length };
      const results = [];
      for (const item of pending) {
        try {
          await this.apply(item, website);
          this.store.setStatus(item.id, 'applied');
          this.store.decision(item.id, 'applied', reviewer.trim());
          results.push({ id: item.id, status: 'applied' });
        } catch (error) {
          this.store.setStatus(item.id, 'blocked', error.message);
          this.store.decision(item.id, 'blocked', reviewer.trim(), error.message);
          results.push({ id: item.id, status: 'blocked', error: error.message });
        }
      }
      return { status: results.some(r => r.status === 'blocked') ? 'partially_blocked' : 'applied',
        applied: results.filter(r => r.status === 'applied').length,
        blocked: results.filter(r => r.status === 'blocked').length, results };
    });
  }
  async manualMatch({ siteUrl, accountId, action, reviewer }) {
    if (!['link', 'unlink'].includes(action) || typeof reviewer !== 'string' || !reviewer.trim() || reviewer.length > 100) {
      throw new Error('An explicit manual match decision and reviewer are required.');
    }
    await this.store.withLock(async () => {
      const latest = this.store.latest();
      if (!latest || !latest.snapshot.website.locations.some(row => row.source_url === siteUrl)) throw new Error('Website facility is not in the latest complete scan.');
      const links = this.store.manualLinks();
      if (action === 'unlink') {
        if (!links[siteUrl]) throw new Error('No saved manual match found.');
        this.store.unlink(siteUrl, reviewer.trim());
        return;
      }
      const f = this.config.fields, accounts = latest.snapshot.accounts;
      const target = accounts.find(row => row[f.id] === accountId);
      const parent = latest.result.parent;
      if (!target || target[f.id] === parent?.[f.id] || target[f.duplicate] || target[f.chow] ||
          accounts.some(row => row[f.parent] === accountId)) throw new Error('Selected CRM record is not an eligible facility.');
      if (Object.entries(links).some(([url,id]) => url !== siteUrl && id === accountId)) throw new Error('CRM account is already manually matched to another website facility.');
      this.store.link(siteUrl, accountId, reviewer.trim());
    });
    // This persists a mapping only. The next scan remains read-only and needs fresh approval for any CRM write.
    return { linked: action === 'link', scan: await this.scan() };
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
    for (const check of item.contactGuards || []) {
      const current = await this.client.getContact(check.id);
      if (stable(contactGuard(current, this.config)) === stable(check.before)) continue;
      const ownSteps = item.steps.filter(step => step.resource === 'contacts' && step.method === 'PATCH' && step.id === check.id);
      const expected = { ...check.before };
      ownSteps.forEach(step => Object.assign(expected, step.body));
      if (!ownSteps.length || stable(contactGuard(current, this.config)) !== stable(expected)) {
        throw new Error(`CRM contact ${check.id} changed since the review. Refresh evidence before continuing.`);
      }
    }
    for (const check of item.checks) {
      const current = await this.client.get(check.id);
      if (guardHash(current, this.config) === hash(check.before)) continue;
      // A previously sent PATCH may have succeeded before its response/checkpoint was lost.
      const ownSteps = item.steps.filter(step => (step.resource || 'accounts') === 'accounts' && step.method === 'PATCH' && step.id === check.id);
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
  async apply(item, website = null) {
    this.store.setStatus(item.id, 'applying');
    if (item.website?.record_type === 'facility') {
      const saved = this.store.manualLinks()[item.website.source_url] || null;
      if (saved !== (item.website.manual_match_account_id || null)) {
        throw new Error('A verified manual identity mapping changed. This approval is stale; rescan first.');
      }
    }
    // Website evidence is re-read immediately before applying an approved plan.
    if (this.verifyWebsite) await this.verifyWebsite(item);
    else {
      const current = website || await this.readWebsite();
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
    if (item.steps[0]?.method === 'POST' && (item.steps[0].resource || 'accounts') === 'accounts') {
      const opId = hash(`${item.id}:0`), marker = `[review-op:${opId}]`;
      const found = (await this.client.list('accounts')).filter(a => String(a[f.note] || '').includes(marker));
      if (found.length > 1) throw new Error('Multiple accounts carry this operation marker; manual investigation is required.');
      if (found.length === 1) createdId = found[0][f.id];
    }
    await this.verifyGuards(item, createdId);
    // Before the first contact write, also detect new/removed administrator records.
    // Individual record guards alone cannot detect another administrator added after scanning.
    if (item.kind === 'admin_contact' && !item.steps.some((_, index) => this.store.operation(hash(`${item.id}:${index}`)))) {
      const cf = this.config.contactFields;
      const accountId = item.evidence.accounts[0][f.id];
      const relevant = (await this.client.list('contacts')).filter(contact =>
        contact[cf.account] === accountId &&
        (this.config.administratorTitles.some(title => normalize(contact[cf.title]) === normalize(title)) ||
          normalize(contact[cf.name]) === normalize(item.website.administrator)));
      const keys = rows => rows.map(row => contactGuard(row, this.config))
        .sort((a, b) => String(a[cf.id]).localeCompare(String(b[cf.id])));
      if (stable(keys(relevant)) !== stable(keys(item.evidence.contacts))) {
        throw new Error('CRM administrator roster changed since scanning. No contact changes were written; rescan and review.');
      }
    }
    for (const [index, step] of item.steps.entries()) {
      const opId = hash(`${item.id}:${index}`);
      const operation = this.store.operation(opId);
      const body = resolveBody(step.body, createdId);
      if (step.resource === 'contacts') {
        await this.applyContactStep(item, step, body, index, opId, operation);
        continue;
      }
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
    if (item.kind === 'admin_contact') {
      const cf = this.config.contactFields;
      const accountId = item.evidence.accounts[0][f.id];
      const activeAdmins = (await this.client.list('contacts')).filter(contact =>
        contact[cf.account] === accountId && normalize(contact[cf.status]) === 'active' &&
        this.config.administratorTitles.some(title => normalize(contact[cf.title]) === normalize(title)));
      if (activeAdmins.length !== 1 || normalize(activeAdmins[0][cf.name]) !== normalize(item.website.administrator)) {
        throw new Error('CRM administrator did not match the website after the approved contact operations. No additional changes will be attempted; inspect and rescan.');
      }
    }
  }
  async applyContactStep(item, step, body, index, opId, operation) {
    const cf = this.config.contactFields;
    if (item.kind !== 'admin_contact' || !item.website?.administrator) throw new Error('Unapproved contact operation.');
    const account = item.evidence.accounts[0];
    const accountId = account[this.config.fields.id];
    const existing = await this.client.list('contacts');
    const admins = existing.filter(c => c[cf.account] === accountId &&
      this.config.administratorTitles.some(title => normalize(title) === normalize(c[cf.title])));
    if (step.method === 'POST') {
      if (Object.keys(body).some(k => ![cf.account, cf.name, cf.title, cf.status].includes(k)) ||
        body[cf.account] !== accountId || body[cf.name] !== item.website.administrator ||
        !this.config.administratorTitles.some(title => normalize(title) === normalize(body[cf.title])) ||
        body[cf.status] !== 'Active') throw new Error('Only a website-verified administrator contact can be created.');
      // Matching people with OTHER job titles must also block an unexpected new POST.
      const candidates = existing.filter(c => c[cf.account] === accountId && normalize(c[cf.name]) === normalize(body[cf.name]));
      if (candidates.length > 1) throw new Error('Multiple matching CRM contacts; manual review required.');
      if (!operation && candidates.length) throw new Error('A matching person appeared since the scan; refresh the review rather than creating a duplicate.');
      let created = candidates[0];
      if (!created && operation) throw new Error('Previous contact create outcome is uncertain. No second POST was sent; check the CRM manually.');
      if (!created) {
        this.store.saveOperation(opId, item.id, index, 'sent', { method: 'POST', resource: 'contacts', body });
        try {
          created = await this.client.createContact(body);
          this.store.saveOperation(opId, item.id, index, 'unverified', { resource: 'contacts', method: 'POST', body, createdId: created[cf.id] });
          created = await this.client.getContact(created[cf.id]);
        } catch(error) {
          this.store.saveOperation(opId, item.id, index, 'uncertain', { resource: 'contacts', method: 'POST', body, error: error.message });
          throw error;
        }
      }
      if (!matches(created, body)) throw new Error('Administrator contact read-back differs from approved values.');
      this.store.saveOperation(opId, item.id, index, 'applied', { resource: 'contacts', method: 'POST', body, createdId: created[cf.id] });
      return;
    }
    const fields = Object.keys(body);
    if (step.method !== 'PATCH' || !fields.length || fields.some(key => ![cf.status, cf.title].includes(key)) ||
        (body[cf.status] && !['Active', 'Inactive'].includes(body[cf.status]))) {
      throw new Error('Administrator updates may only change the explicitly approved title and/or status.');
    }
    const check = item.contactGuards.find(c => c.id === step.id);
    if (!check || check.before[cf.account] !== accountId) throw new Error('Unapproved administrator contact target.');
    const sameWebsitePerson = normalize(check.before[cf.name]) === normalize(item.website.administrator);
    const originalAdministrator = this.config.administratorTitles.some(title => normalize(title) === normalize(check.before[cf.title]));
    if (!originalAdministrator && !sameWebsitePerson) throw new Error('Cannot change an unrelated CRM contact.');
    if (Object.hasOwn(body, cf.title) && (!sameWebsitePerson || !this.config.administratorTitles.some(title => normalize(title) === normalize(body[cf.title])))) {
      throw new Error('Only the website-verified person can receive the Administrator title.');
    }
    if (body[cf.status] === 'Active' && !sameWebsitePerson) throw new Error('Cannot activate a different person.');
    if (body[cf.status] === 'Inactive' && sameWebsitePerson) throw new Error('Cannot deactivate the current website administrator.');
    const current = await this.client.getContact(step.id);
    if (matches(current, body)) {
      if (stable(contactGuard(current,this.config)) !== stable({ ...check.before, ...body })) throw new Error('Contact identity or other fields changed since approval.');
      this.store.saveOperation(opId, item.id, index, 'applied', { resource: 'contacts', method: 'PATCH', body, targetId: step.id });
      return;
    }
    if (stable(contactGuard(current,this.config)) !== stable(check.before)) throw new Error('Contact changed immediately before writeback.');
    this.store.saveOperation(opId, item.id, index, 'sent', { resource: 'contacts', method: 'PATCH', body, targetId: step.id });
    try {
      await this.client.patchContact(step.id, body);
      const after = await this.client.getContact(step.id);
      if (stable(contactGuard(after,this.config)) !== stable({ ...check.before, ...body })) throw new Error('Contact read-back differs from approved patch.');
      this.store.saveOperation(opId, item.id, index, 'applied', { resource: 'contacts', method: 'PATCH', body, targetId: step.id });
    } catch(error) {
      this.store.saveOperation(opId, item.id, index, 'uncertain', { resource: 'contacts', method: 'PATCH', body, targetId: step.id, error: error.message });
      throw error;
    }
  }

}
