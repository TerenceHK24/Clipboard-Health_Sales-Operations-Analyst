'use strict';
const $ = id => document.getElementById(id);
let sessionKey = location.hash.slice(1) || sessionStorage.getItem('review-key');
if (location.hash) { sessionStorage.setItem('review-key', sessionKey); history.replaceState(null, '', location.pathname); }
let state = null, selectedId = null, selectedGroup = null, busy = false;
const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const pretty = value => value === null || value === undefined || value === '' ? 'Not provided' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const label = key => key.replaceAll('_', ' ').replace(/\b\w/g, char => char.toUpperCase());
function table(headers, rows) {
  const node = element('table'), head = element('thead'), tr = element('tr');
  headers.forEach(value => tr.append(element('th', value))); head.append(tr); node.append(head);
  const body = element('tbody');
  rows.forEach(row => { const tr = element('tr'); row.forEach((value, index) => tr.append(element('td', pretty(value), index === 2 ? 'after' : ''))); body.append(tr); });
  node.append(body); return node;
}
function message(text, error = false) { $('message').replaceChildren(element('div', text, error ? 'error' : 'notice')); }
async function request(path, body) {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', headers: {
    'X-Review-Key': sessionKey || '', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function sourceLink(url) {
  try { const parsed = new URL(url); if (!['https:', 'http:'].includes(parsed.protocol)) return element('span', 'No valid source link'); }
  catch { return element('span', 'No valid source link'); }
  const link = element('a', 'Open source evidence'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; return link;
}
function filtered() {
  const filter = $('filter').value, query = $('search').value.trim().toLowerCase();
  return state.proposals.filter(item => (filter === 'all' || (filter === 'blocked' ? ['blocked', 'approved', 'applying'].includes(item.status) : item.status === filter)) &&
    (!query || JSON.stringify(item).toLowerCase().includes(query)));
}
function render() {
  if (!state) return;
  const latest = state.latest;
  $('summary').replaceChildren(...[
    [latest?.summary.facilities ?? '—', 'Public facilities'],
    [latest?.summary.accounts ?? '—', 'CRM accounts inspected'],
    [state.proposals.filter(p => p.status === 'pending').length, 'Awaiting your review'],
    [state.proposals.filter(p => p.status === 'applied').length, 'Approved and verified'],
  ].map(([value, title]) => { const box = element('div', undefined, 'metric'); box.append(element('strong', value), element('span', title)); return box; }));
  $('company').replaceChildren();
  if (latest) {
    const company = latest.company, identity = element('div');
    identity.append(element('strong', company.name), element('small', 'Corporate parent · extracted from the public footer'),
      element('p', `${company.address}, ${company.city}, ${company.state}${company.zip ? ' ' + company.zip : ''}`),
      element('small', company.zip ? `Published ZIP: ${company.zip}` : 'ZIP not published; existing CRM postal data is preserved.'));
    const meta = element('div'); meta.append(sourceLink(company.source_url), element('p', `Last successful scan: ${new Date(latest.at).toLocaleString()}`, 'timestamp'));
    $('company').append(identity, meta);
  } else $('company').append(element('p', 'No scan yet. Set up the CRM token in your environment, then run a read-only scan.'));
  const items = filtered();
  const groups = new Map();
  for (const item of items) {
    const key = item.groupKey || item.kind;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  $('queue-count').textContent = `(${groups.size} groups / ${items.length} records)`;
  if (!groups.has(selectedGroup)) selectedGroup = groups.keys().next().value || null;
  $('queue').replaceChildren(...[...groups].map(([key, group]) => {
    const first = group[0], button = element('button', undefined, `queue-item${key === selectedGroup ? ' selected' : ''}`);
    button.append(element('span', first.groupLabel || label(first.kind), `pill ${first.kind}`),
      element('p', group.length > 1 ? `${group.length} accounts / changes` : first.title),
      element('small', `${label(first.status)} · ${[...new Set(group.flatMap(p => p.steps.flatMap(step => Object.keys(step.body))))].map(label).join(', ')}`));
    button.addEventListener('click', () => { selectedGroup = key; render(); });
    return button;
  }));
  if (!groups.size) $('queue').append(element('p', 'No items in this view.', 'muted'));
  const group = groups.get(selectedGroup) || [];
  if (group.length > 1) renderGroup(group);
  else renderDetail(group[0]);
  $('matches').replaceChildren();
  for (const match of latest?.matches || []) {
    const details = element('details', undefined, 'box');
    details.append(element('summary', `${match.name} — ${match.result}`));
    if (match.website) details.append(element('pre', JSON.stringify(match.website, null, 2)));
    if (match.careEquivalent) details.append(element('p', `Same care category: website “${match.careEquivalent.website}” = CRM “${match.careEquivalent.crm}” (no update).`, 'notice'));
    if (match.websiteAdministrator) details.append(element('p', `Administrator: website “${match.websiteAdministrator}”; CRM ${match.crmAdministrators?.map(c => `${c.name} (${c.status})`).join('; ') || 'none'}.`));
    if (match.account) details.append(element('pre', JSON.stringify(match.account, null, 2)));
    if (match.contacts?.length) { details.append(element('h3', 'Contacts (read-only)'), element('pre', JSON.stringify(match.contacts, null, 2))); }
    $('matches').append(details);
  }
  $('notices').replaceChildren(element('pre', JSON.stringify(latest?.coverage || {}, null, 2)),
    ...(latest?.notices || []).map(text => element('p', text)));
  $('audit').replaceChildren(table(['When', 'Reviewer', 'Decision', 'Proposal', 'Note'],
    state.audit.map(item => [new Date(item.at).toLocaleString(), item.reviewer, item.decision, item.proposal_id.slice(0, 12), item.note])));
}
function renderDetail(item, detail = $('detail'), insideGroup = false) {
  detail.replaceChildren();
  if (!item) { detail.append(element('div', 'No pending decision here. Use the filters to inspect previous decisions or run a new scan.', 'empty')); return; }
  detail.append(element('span', label(item.status), `pill ${item.status}`), element('h2', item.title), element('p', item.reason));
  if (item.kind === 'chow') detail.append(element('div', 'CHOW safeguard: create a new current account first. The old account keeps its parent, status, name, note, revenue, AR, and contacts. Only its current-account link changes.', 'warning'));
  if (item.error) detail.append(element('p', item.error, 'error'));
  const evidence = element('div', undefined, 'evidence');
  if (item.website) {
    const box = element('div', undefined, 'box'); box.append(element('h3', 'Website'), element('strong', item.website.name),
      element('p', `${item.website.address}, ${item.website.city}, ${item.website.state} ${item.website.zip || ''}`),
      element('p', item.website.care_offerings || 'Corporate office'),
      item.website.record_type === 'facility' ? element('p', `Website administrator: ${item.website.administrator || 'Not published'}`) : element('span', ''),
      sourceLink(item.website.source_url)); evidence.append(box);
  }
  const f = state.fields;
  for (const account of item.evidence.accounts) {
    const box = element('div', undefined, 'box'); box.append(element('h3', account[f.name]), element('small', `Account ${account[f.id]}`),
      element('p', `${account[f.street] || ''}, ${account[f.city] || ''}, ${account[f.state] || ''}`),
      element('small', `Parent: ${account[f.parent] || 'None'} · Status: ${account[f.status]}`),
      element('p', `Lifetime revenue: ${pretty(account[f.revenue])} · Outstanding AR: ${pretty(account[f.ar])}`)); evidence.append(box);
  }
  detail.append(evidence, element('h3', 'Exact approved operations'));
  item.steps.forEach((step, index) => {
    const resource = step.resource || 'accounts';
    detail.append(element('p', `${index + 1}. ${step.method} ${step.id ? `${resource} ${step.id}` : `new ${resource}`}`));
    const before = (resource === 'contacts' ? item.contactGuards : item.checks).find(check => check.id === step.id)?.before || {};
    detail.append(table(['Field', 'Before', 'After'], Object.entries(step.body).map(([key, value]) =>
      [label(key), before[key], value === '$created_id' ? 'Verified ID of the account created in step 1' : value])));
    if (step.method === 'POST' && resource === 'accounts') detail.append(element('small', 'The new account note receives a deterministic operation marker and source URL for recovery.', 'muted'));
    if (step.method === 'POST' && resource === 'contacts') detail.append(element('small', 'No email or phone is invented for the new administrator contact. Existing contacts are preserved.', 'muted'));
  });
  if (item.evidence.contacts.length) {
    const contacts = element('details'); contacts.append(element('summary', 'Existing contact context and history'), element('pre', JSON.stringify(item.evidence.contacts, null, 2))); detail.append(contacts);
  }
  if (item.operations?.length) {
    const journal = element('details'); journal.append(element('summary', 'Write-ahead journal / recovery details'), element('pre', JSON.stringify(item.operations, null, 2))); detail.append(journal);
  }
  if (item.website?.record_type === 'facility') renderManualMatch(item, detail);
  if ((!insideGroup && (item.status === 'pending' || ['blocked', 'approved', 'applying'].includes(item.status))) ||
      (insideGroup && ['blocked','approved','applying'].includes(item.status))) {
    const noteLabel = element('label', 'Decision note (optional)'), note = element('textarea'); note.rows = 2; note.maxLength = 2000; noteLabel.append(note); detail.append(noteLabel);
    const actions = element('div', undefined, 'actions');
    const choices = item.status === 'pending' ? [['approve', 'Approve and write to CRM'], ['reject', 'Reject — no CRM write']]
      : [['retry', 'Resume approved operation safely']];
    for (const [action, title] of choices) {
      const button = element('button', title, action === 'reject' ? 'secondary' : ''); button.disabled = busy;
      button.addEventListener('click', async () => {
        const reviewer = $('reviewer').value.trim();
        if (!reviewer) { message('Enter a reviewer name before deciding.', true); $('reviewer').focus(); return; }
        const prompt = action === 'reject' ? `Reject this proposal? Nothing will be written to the CRM.`
          : `${title}?\n\n${item.title}\n\nOnly the operations shown above are authorized. Current website and CRM evidence will be checked again.`;
        if (!confirm(prompt)) return;
        await run(async () => { await request(`/api/proposals/${item.id}/decision`, { decision: action, revision: item.revision, reviewer, note: note.value });
          message(action === 'reject' ? 'Rejection saved. This unchanged proposal will not reappear as pending.' : 'Approved operation completed and verified.'); });
      }); actions.append(button);
    }
    detail.append(actions);
  }
}

function renderManualMatch(item, detail) {
  const choices = state.matchChoices || [], links = state.manualLinks || {};
  const box = element('details', undefined, 'box');
  const current = links[item.website.source_url];
  box.append(element('summary', current ? 'Verified manual CRM match — change / remove' : 'All identity fields changed? Manually match the existing CRM account'));
  box.append(element('p', 'If name, address, phone and parent all changed, an algorithm cannot safely infer identity from care type alone. Select the verified account ID and run a fresh read-only scan. This step NEVER writes to CRM.', 'muted'));
  const select = element('select'); select.append(element('option', 'Choose CRM account…'));
  select.firstChild.value = '';
  for (const row of choices) {
    const option = element('option', `${row.name} · ${row.street || ''}, ${row.city || ''} ${row.state || ''} · parent ${row.parent || 'none'} · ID ${row.id}`);
    option.value = row.id;
    if (row.id === current) option.selected = true;
    select.append(option);
  }
  const choiceLabel = element('label', 'Verified existing CRM account'); choiceLabel.append(select); box.append(choiceLabel);
  const actions = element('div', undefined, 'actions');
  const link = element('button', 'Record manual match and run read-only scan');
  link.disabled = busy;
  link.addEventListener('click', async () => {
    const reviewer = $('reviewer').value.trim();
    if (!reviewer || !select.value) { message('Choose an account ID and enter the reviewer name.', true); return; }
    const record = choices.find(c => c.id === select.value);
    if (!confirm(`Record a verified identity match?\n\nWebsite: ${item.website.name}\nCRM: ${record?.name} (${select.value})\n\nNo CRM data will be changed. A new reconciliation must be approved separately.`)) return;
    await run(async () => { await request('/api/manual-match', { action: 'link', siteUrl: item.website.source_url, accountId: select.value, reviewer }); message('Verified manual identity saved; fresh reconciliation proposals are ready for review.'); });
  });
  actions.append(link);
  if (current) {
    const unlink = element('button', 'Remove manual identity link', 'secondary');
    unlink.addEventListener('click', async () => {
      const reviewer = $('reviewer').value.trim(); if (!reviewer) { message('Enter reviewer name.', true); return; }
      if (!confirm('Remove this saved identity mapping and run a read-only scan?')) return;
      await run(async () => { await request('/api/manual-match', { action: 'unlink', siteUrl: item.website.source_url, reviewer }); message('Manual identity link removed.'); });
    }); actions.append(unlink);
  }
  box.append(actions); detail.append(box);
}
function preview(item) {
  return item.steps.map(step => {
    const before = (step.resource === 'contacts' ? item.contactGuards : item.checks).find(c => c.id === step.id)?.before || {};
    return Object.entries(step.body).map(([key, after]) => `${label(key)}: ${pretty(before[key])} → ${pretty(after)}`).join('; ');
  }).join(' / ');
}
function renderGroup(group) {
  const detail = $('detail'); detail.replaceChildren();
  const kind = group[0].groupLabel || label(group[0].kind);
  detail.append(element('span', `${group.length} proposed records`, 'pill'), element('h2', kind),
    element('p', 'This group contains changes of the same kind and fields. Each account and its exact changes are listed below. Approval authorizes every listed operation; unchanged or stale groups are rejected without writing.'));
  if (group.some(item => ['chow','duplicate','reparent'].includes(item.kind))) detail.append(element('div',
    'High-impact group: verify each account identity, parent, revenue and outstanding AR. CHOW and duplicate cases cannot be treated as simple field corrections.', 'warning'));
  detail.append(table(['Account / facility', 'Change type', 'Exactly proposed'], group.map(item => [item.title, label(item.kind), preview(item)])));
  const accordions = element('div', undefined, 'group-children');
  for (const item of group) {
    const panel = element('details', undefined, 'box');
    panel.append(element('summary', `${item.title} — evidence and full write plan`));
    const inside = element('div', undefined, 'group-member');
    renderDetail(item, inside, true);
    panel.append(inside); accordions.append(panel);
  }
  detail.append(accordions);
  const completeGroup = state.proposals.filter(item => item.groupKey === group[0].groupKey && item.status === 'pending').length === group.length;
  if (!completeGroup && group.every(item=>item.status==='pending')) detail.append(element('div', 'Search results show only part of this group. Clear the search before bulk approving or rejecting.', 'warning'));
  if (completeGroup && group.every(item => item.status === 'pending')) {
    const noteLabel = element('label', 'One decision note applied to all members'), note = element('textarea');
    note.rows = 2; note.maxLength = 2000; noteLabel.append(note); detail.append(noteLabel);
    const actions = element('div', undefined, 'actions');
    for (const [decision,title] of [['approve',`Approve all ${group.length} reviewed changes`],['reject',`Reject all ${group.length} reviewed changes`]]) {
      const button = element('button', title, decision === 'reject' ? 'secondary' : '');
      button.addEventListener('click', async () => {
        const reviewer = $('reviewer').value.trim(); if (!reviewer) { message('Enter reviewer name to make a decision.', true); return; }
        if (!confirm(`${decision.toUpperCase()} ${group.length} specific account proposals?\n\n${kind}\n\nReview the complete account-by-account preview above. Approval may perform multiple CRM writes; failed members stay blocked, and successful members are individually journaled.`)) return;
        await run(async () => {
          const result = await request('/api/groups/decision', { groupKey: group[0].groupKey, members: group.map(p => ({ id:p.id, revision:p.revision })), decision, reviewer, note:note.value });
          message(decision === 'reject' ? `Rejected ${result.rejected} proposals.` : `Applied ${result.applied}, blocked ${result.blocked}; review the audit journal for each record.`, result.blocked > 0);
        });
      }); actions.append(button);
    }
    detail.append(actions);
  }
}

async function refresh() { state = await request('/api/state'); render(); }
async function run(callback) {
  if (busy) return;
  busy = true; document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try { await callback(); }
  catch (error) { message(error.message, true); }
  finally { busy = false; try { await refresh(); } catch (error) { message(error.message, true); }
    document.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
}
$('filter').addEventListener('change', render); $('search').addEventListener('input', render);
$('refresh').addEventListener('click', () => run(refresh));
$('scan').addEventListener('click', () => run(async () => {
  message('Reading the public website and CRM. This scan cannot write to the CRM.');
  const result = await request('/api/scan', {}); message(`Scan complete: ${result.added} new proposals, ${result.pending} pending, ${result.remembered} previous decisions retained.`);
}));
refresh().catch(error => message(error.message, true));
