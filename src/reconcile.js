import { hash } from './config.js';

export const normalize = value => String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
export const nameKey = value => normalize(value).replace(/\bparent account\b/g, '')
  .replace(/\bhealthcare\b/g, 'health care').replace(/\bcentre\b/g, 'center').trim();
const STREET_WORDS = { street: 'st', road: 'rd', avenue: 'ave', boulevard: 'blvd', drive: 'dr',
  lane: 'ln', court: 'ct', highway: 'hwy', parkway: 'pkwy', north: 'n', south: 's', east: 'e', west: 'w' };
export const streetKey = value => normalize(value).split(' ').map(word => STREET_WORDS[word] || word).join(' ');
export const phoneKey = value => String(value ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
const careKey = value => [...new Set(String(value ?? '').split(/[|;,]/).map(normalize).filter(Boolean))].sort().join('|');
const text = value => value === undefined || value === null ? '' : String(value).trim();

export function amount(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}
export function needsChow(account, config) {
  const revenue = amount(account[config.fields.revenue]), ar = amount(account[config.fields.ar]);
  return revenue === null || ar === null ? null : revenue > 0 && ar > 0;
}
/** Compare the documented business fields, not unstable transport timestamps. */
export function guard(account, config) {
  return Object.fromEntries(Object.values(config.fields).map(key => [key, account[key] ?? null]));
}
export const guardHash = (account, config) => hash(guard(account, config));
export function websiteIdentity(row) {
  const keys = ['record_type', 'name', 'address', 'city', 'state', 'zip', 'care_offerings', 'administrator', 'phone', 'source_url'];
  return Object.fromEntries(keys.map(key => [key, row[key] ?? null]));
}
export function identityScore(site, account, config) {
  const f = config.fields;
  const place = normalize(site.city) === normalize(account[f.city]) && normalize(site.state) === normalize(account[f.state]);
  if (!site.city || !site.state || !place) return 0;
  const name = nameKey(site.name) === nameKey(account[f.name]);
  const phone = Boolean(phoneKey(site.phone)) && phoneKey(site.phone) === phoneKey(account[f.phone]);
  const street = Boolean(streetKey(site.address)) && streetKey(site.address) === streetKey(account[f.street]);
  if (street) return 100 + Number(name) * 20 + Number(phone) * 10;
  if (name && phone) return 95;
  if (name) return 85; // A possible relocation: the reviewer sees the complete address change.
  if (phone) return 65;
  const a = new Set(nameKey(site.name).split(' ')), b = new Set(nameKey(account[f.name]).split(' '));
  const similarity = [...a].filter(word => b.has(word)).length / new Set([...a, ...b]).size;
  return similarity >= 0.75 ? 50 : 0;
}

function sameFacility(a, b, config) {
  const f = config.fields;
  if (!a[f.street] || streetKey(a[f.street]) !== streetKey(b[f.street]) ||
      normalize(a[f.city]) !== normalize(b[f.city]) || normalize(a[f.state]) !== normalize(b[f.state])) return false;
  const sameName = nameKey(a[f.name]) === nameKey(b[f.name]);
  const samePhone = Boolean(phoneKey(a[f.phone])) && phoneKey(a[f.phone]) === phoneKey(b[f.phone]);
  // Co-located but differently named/categorized services are not automatically duplicates.
  return (sameName || samePhone) && careKey(a[f.care]) === careKey(b[f.care]);
}
export function appendNote(existing, addition) {
  const value = text(existing);
  return value.includes(addition) ? value : [value, addition].filter(Boolean).join('\n');
}
function desiredFields(site, config) {
  const f = config.fields;
  const pairs = [[f.name, site.name], [f.street, site.address], [f.city, site.city],
    [f.state, site.state], [f.zip, site.zip], [f.phone, site.phone], [f.care, site.care_offerings]];
  // Missing public information is not permission to erase existing CRM data.
  return Object.fromEntries(pairs.filter(([, value]) => value !== null && value !== undefined && text(value) !== ''));
}
function differences(account, desired, config) {
  const f = config.fields, patch = {};
  for (const [key, value] of Object.entries(desired)) {
    const same = key === f.phone ? phoneKey(account[key]) === phoneKey(value)
      : key === f.care ? careKey(account[key]) === careKey(value)
      : key === f.street ? streetKey(account[key]) === streetKey(value)
      : normalize(account[key]) === normalize(value);
    if (!same) patch[key] = value;
  }
  return patch;
}
function proposal(key, kind, title, website, accounts, steps, reason, config, contacts = []) {
  const checks = accounts.map(account => ({ id: account[config.fields.id], before: guard(account, config) }));
  const identity = { key, kind, website: website ? websiteIdentity(website) : null, checks, steps };
  const id = hash(identity);
  const approvedSteps = steps.map((step, index) => step.method === 'POST' ? { ...step, body: { ...step.body,
    [config.fields.note]: appendNote(step.body[config.fields.note],
      `[review-op:${hash(`${id}:${index}`)}] Source: ${website?.source_url || config.siteUrl}`),
  } } : step);
  return { id, key, kind, title, website, checks, steps: approvedSteps, reason,
    evidence: { accounts, contacts }, revision: hash({ ...identity, steps: approvedSteps }) };
}
function patchStep(account, body, config) {
  return { method: 'PATCH', id: account[config.fields.id], body };
}

export function validateAccounts(accounts, config) {
  const f = config.fields;
  const required = ['id', 'name', 'parent', 'street', 'city', 'state', 'status', 'revenue', 'ar'];
  for (const account of accounts) {
    for (const key of required) {
      if (!Object.hasOwn(account, f[key])) throw new Error(`Account response is missing mapped field '${f[key]}'. Check the API field mapping; no changes were proposed.`);
    }
    if (!account[f.id] || !account[f.name]) throw new Error('Account IDs and names must be present.');
  }
}

/** Pure planning: this function cannot perform API writes. */
export function plan(snapshot, config) {
  const { website, accounts, contacts = [] } = snapshot;
  validateAccounts(accounts, config);
  if (!website.complete || !website.company || !website.locations.length) throw new Error('A complete website snapshot including the corporate footer is required.');
  const f = config.fields, proposals = [], matches = [], notices = [];
  const company = website.company;
  const parents = accounts.filter(a => !a[f.parent] && !a[f.duplicate] && !a[f.chow] &&
    nameKey(a[f.name]) === nameKey(company.name));
  if (parents.length !== 1) {
    if (!parents.length) {
      const body = { ...desiredFields(company, config), [f.status]: 'Active' };
      proposals.push(proposal(`parent:${company.source_url}`, 'create_parent', `Create ${company.name} parent account`, company, [],
        [{ method: 'POST', body }], 'No unambiguous parent account matches the corporate identity extracted from the footer. Facilities wait until this parent exists.', config));
    } else notices.push('Multiple parent accounts match the corporate identity. Resolve the parent ambiguity before facility changes.');
    return { proposals, matches, notices, parent: null };
  }
  const parent = parents[0], parentId = parent[f.id];
  const parentDesired = desiredFields(company, config);
  delete parentDesired[f.name]; // A CRM "(Parent Account)" suffix is a designation, not a stale brand name.
  delete parentDesired[f.care];
  const parentPatch = differences(parent, parentDesired, config);
  if (Object.keys(parentPatch).length) proposals.push(proposal(`parent:${parentId}`, 'update_parent', 'Update corporate office details', company,
    [parent], [patchStep(parent, parentPatch, config)], 'Only fields actually published in the corporate footer are suggested. An unpublished ZIP is left unchanged.', config));

  const referencedParents = new Set(accounts.map(a => a[f.parent]).filter(Boolean));
  const eligible = accounts.filter(a => a[f.id] !== parentId && !referencedParents.has(a[f.id]) && !a[f.duplicate] && !a[f.chow]);
  const used = new Set(), potential = new Set();
  const decisions = website.locations.map(site => {
    const candidates = eligible.map(account => ({ account, score: identityScore(site, account, config) }))
      .filter(item => item.score >= 50).sort((a, b) => b.score - a.score || text(a.account[f.id]).localeCompare(text(b.account[f.id])));
    candidates.forEach(item => potential.add(item.account[f.id]));
    if (!candidates.length) return { site, candidates, kind: 'new' };
    const top = candidates[0];
    if (top.score < 85) return { site, candidates, kind: 'ambiguous' };
    const competing = candidates.filter(item => item.score >= 85);
    const duplicates = competing.length > 1 && competing.every(item => item.account[f.parent] === top.account[f.parent] && sameFacility(top.account, item.account, config));
    if (competing.length > 1 && !duplicates &&
        !(top.score > competing[1].score && nameKey(top.account[f.name]) === nameKey(site.name))) {
      return { site, candidates, kind: 'ambiguous' };
    }
    const group = duplicates ? competing.map(item => item.account) : [top.account];
    // Prefer the account carrying receivables/history, never a more convenient empty copy.
    group.sort((a, b) => (amount(b[f.ar]) ?? -1) - (amount(a[f.ar]) ?? -1) ||
      (amount(b[f.revenue]) ?? -1) - (amount(a[f.revenue]) ?? -1) ||
      Number(b[f.status] === 'Active') - Number(a[f.status] === 'Active') || text(a[f.id]).localeCompare(text(b[f.id])));
    return { site, candidates, kind: 'matched', account: group[0], duplicates: group.slice(1) };
  });
  const claims = new Map();
  for (const item of decisions.filter(d => d.kind === 'matched')) {
    for (const account of [item.account, ...item.duplicates]) claims.set(account[f.id], (claims.get(account[f.id]) || 0) + 1);
  }
  for (const item of decisions) {
    const { site, candidates } = item;
    if (item.kind === 'matched' && [item.account, ...item.duplicates].some(a => claims.get(a[f.id]) > 1)) item.kind = 'ambiguous';
    if (item.kind === 'ambiguous') {
      notices.push(`${site.name}: ambiguous identity; no create, merge, or re-parent was inferred.`);
      for (const { account } of candidates) {
        used.add(account[f.id]);
        const note = appendNote(account[f.note], `Identity requires review against ${site.source_url}; multiple or weak matches prevent an automatic recommendation.`);
        const body = { [f.status]: 'Needs Review', [f.note]: note };
        if (account[f.status] !== 'Needs Review' || note !== account[f.note]) proposals.push(proposal(
          `ambiguous:${site.source_url}:${account[f.id]}`, 'flag_ambiguous', `Review identity: ${account[f.name]}`, site,
          [account], [patchStep(account, body, config)], 'Approval only flags this account. It does not assert a match or change its parent.', config));
      }
      matches.push({ name: site.name, result: 'Ambiguous', source_url: site.source_url });
      continue;
    }
    if (item.kind === 'new') {
      const body = { ...desiredFields(site, config), [f.parent]: parentId, [f.status]: 'Active' };
      proposals.push(proposal(`create:${site.source_url}`, 'create', `Create ${site.name}`, site, [parent],
        [{ method: 'POST', body }], 'No candidate was found across the complete CRM account inventory, including other parents.', config));
      matches.push({ name: site.name, result: 'Missing CRM account', source_url: site.source_url });
      continue;
    }
    const account = item.account, accountId = account[f.id];
    const accountContacts = contacts.filter(contact => contact.account_id === accountId);
    used.add(accountId);
    const patch = differences(account, desiredFields(site, config), config);
    const wrongParent = account[f.parent] !== parentId;
    const financialGate = needsChow(account, config);
    if (wrongParent && financialGate === null) {
      notices.push(`${site.name}: billing values are missing/invalid; ownership changes are blocked.`);
      matches.push({ name: site.name, result: 'Blocked: invalid billing data', account_id: accountId, source_url: site.source_url });
      continue;
    }
    if (wrongParent && financialGate) {
      const body = { ...desiredFields(site, config), [f.parent]: parentId, [f.status]: 'Active' };
      proposals.push(proposal(`ownership:${accountId}:${parentId}`, 'chow', `CHOW: ${site.name}`, site, [account, parent], [
        { method: 'POST', body },
        patchStep(account, { [f.chow]: '$created_id' }, config),
      ], 'Revenue history AND outstanding AR are positive. Create a new current account; the only change to the old record is chow_current_account. Its parent, name, status, note, billing, and contacts are preserved.', config, accountContacts));
    } else {
      if (wrongParent) patch[f.parent] = parentId;
      if (account[f.status] === 'Inactive') {
        patch[f.status] = 'Needs Review';
        patch[f.note] = appendNote(account[f.note], `Public facility exists at ${site.source_url}, but the CRM account is Inactive. Verify status before activation.`);
      }
      if (Object.keys(patch).length) proposals.push(proposal(`facility:${site.source_url}:${accountId}`, wrongParent ? 'reparent' : 'update',
        `${wrongParent ? 'Re-parent and reconcile' : 'Update'} ${site.name}`, site, [account, ...(wrongParent ? [parent] : [])],
        [patchStep(account, patch, config)], wrongParent
          ? 'Revenue history or outstanding AR is zero, so this existing account may be re-parented after approval.'
          : 'Public fields differ from the matched account. Unpublished fields, financial values, and contacts are not overwritten.', config, accountContacts));
    }
    for (const loser of item.duplicates) {
      used.add(loser[f.id]);
      // A survivor moving to another parent must be settled before duplicate disposition.
      if (wrongParent) { notices.push(`${loser[f.name]}: possible duplicate; resolve ownership first.`); continue; }
      const body = { [f.status]: 'Inactive', [f.duplicate]: accountId,
        [f.note]: appendNote(loser[f.note], `Duplicate of ${accountId}, supported by ${site.source_url}. Billing history and contacts remain on this record; no merge or deletion is performed.`) };
      proposals.push(proposal(`duplicate:${loser[f.id]}:${accountId}`, 'duplicate', `Mark duplicate: ${loser[f.name]}`, site,
        [loser, account], [patchStep(loser, body, config)], 'Same normalized address and matching identity/care evidence under the same parent. The survivor is selected using receivables and revenue history. Review all evidence before approval.', config,
        contacts.filter(contact => [loser[f.id], accountId].includes(contact.account_id))));
    }
    const admins = accountContacts.filter(c => normalize(c.title) === 'administrator' && c.status === 'Active');
    if (site.administrator && !admins.some(c => nameKey(c.name) === nameKey(site.administrator))) {
      notices.push(`${site.name}: website administrator '${site.administrator}' needs contact verification. Existing names/emails are not renamed or reassigned automatically.`);
    }
    matches.push({ name: site.name, result: wrongParent ? (financialGate ? 'CHOW required' : 'Wrong parent') : Object.keys(patch).length ? 'Field differences' : 'Matched',
      account_id: accountId, source_url: site.source_url, website: site, account, contacts: accountContacts });
  }
  for (const account of accounts) {
    if (account[f.parent] !== parentId || used.has(account[f.id]) || potential.has(account[f.id]) || account[f.chow] || account[f.duplicate]) continue;
    const note = appendNote(account[f.note], `Not found in complete public-site discovery at ${config.siteUrl}. Closure and new ownership are unconfirmed; investigate before changing ownership or deactivating.`);
    if (account[f.status] === 'Needs Review' && note === account[f.note]) continue;
    proposals.push(proposal(`absent:${account[f.id]}`, 'missing_from_site', `Not on website: ${account[f.name]}`, null, [account],
      [patchStep(account, { [f.status]: 'Needs Review', [f.note]: note }, config)],
      'Absence is a review signal, not evidence of closure or another owner. Parent and financial fields remain unchanged.', config,
      contacts.filter(contact => contact.account_id === account[f.id])));
  }
  return { proposals, matches, notices, parent: guard(parent, config) };
}
