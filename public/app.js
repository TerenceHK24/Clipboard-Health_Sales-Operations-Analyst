'use strict';
const $ = id => document.getElementById(id);
let sessionKey = location.hash.slice(1) || sessionStorage.getItem('review-key');
if (location.hash) { sessionStorage.setItem('review-key', sessionKey); history.replaceState(null, '', location.pathname); }
let state = null, selectedId = null, busy = false;
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
  $('queue-count').textContent = `(${items.length})`;
  if (!items.some(item => item.id === selectedId)) selectedId = items[0]?.id || null;
  $('queue').replaceChildren(...items.map(item => {
    const button = element('button', undefined, `queue-item${item.id === selectedId ? ' selected' : ''}`);
    button.append(element('span', label(item.kind), `pill ${item.kind}`), element('p', item.title), element('small', label(item.status)));
    button.addEventListener('click', () => { selectedId = item.id; render(); }); return button;
  }));
  if (!items.length) $('queue').append(element('p', 'No items in this view.', 'muted'));
  renderDetail(state.proposals.find(item => item.id === selectedId));
  $('matches').replaceChildren();
  for (const match of latest?.matches || []) {
    const details = element('details', undefined, 'box');
    details.append(element('summary', `${match.name} — ${match.result}`));
    if (match.website) details.append(element('pre', JSON.stringify(match.website, null, 2)));
    if (match.account) details.append(element('pre', JSON.stringify(match.account, null, 2)));
    if (match.contacts?.length) { details.append(element('h3', 'Contacts (read-only)'), element('pre', JSON.stringify(match.contacts, null, 2))); }
    $('matches').append(details);
  }
  $('notices').replaceChildren(element('pre', JSON.stringify(latest?.coverage || {}, null, 2)),
    ...(latest?.notices || []).map(text => element('p', text)));
  $('audit').replaceChildren(table(['When', 'Reviewer', 'Decision', 'Proposal', 'Note'],
    state.audit.map(item => [new Date(item.at).toLocaleString(), item.reviewer, item.decision, item.proposal_id.slice(0, 12), item.note])));
}
function renderDetail(item) {
  const detail = $('detail'); detail.replaceChildren();
  if (!item) { detail.append(element('div', 'No pending decision here. Use the filters to inspect previous decisions or run a new scan.', 'empty')); return; }
  detail.append(element('span', label(item.status), `pill ${item.status}`), element('h2', item.title), element('p', item.reason));
  if (item.kind === 'chow') detail.append(element('div', 'CHOW safeguard: create a new current account first. The old account keeps its parent, status, name, note, revenue, AR, and contacts. Only its current-account link changes.', 'warning'));
  if (item.error) detail.append(element('p', item.error, 'error'));
  const evidence = element('div', undefined, 'evidence');
  if (item.website) {
    const box = element('div', undefined, 'box'); box.append(element('h3', 'Website'), element('strong', item.website.name),
      element('p', `${item.website.address}, ${item.website.city}, ${item.website.state} ${item.website.zip || ''}`),
      element('p', item.website.care_offerings || 'Corporate office'), sourceLink(item.website.source_url)); evidence.append(box);
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
    detail.append(element('p', `${index + 1}. ${step.method} ${step.id ? `account ${step.id}` : 'new account'}`));
    const before = item.checks.find(check => check.id === step.id)?.before || {};
    detail.append(table(['Field', 'Before', 'After'], Object.entries(step.body).map(([key, value]) =>
      [label(key), before[key], value === '$created_id' ? 'Verified ID of the account created in step 1' : value])));
    if (step.method === 'POST') detail.append(element('small', 'The new account note also receives a deterministic operation marker and source URL for safe recovery.', 'muted'));
  });
  if (item.evidence.contacts.length) {
    const contacts = element('details'); contacts.append(element('summary', 'Contact context — no automatic edits'), element('pre', JSON.stringify(item.evidence.contacts, null, 2))); detail.append(contacts);
  }
  if (item.operations?.length) {
    const journal = element('details'); journal.append(element('summary', 'Write-ahead journal / recovery details'), element('pre', JSON.stringify(item.operations, null, 2))); detail.append(journal);
  }
  if (item.status === 'pending' || ['blocked', 'approved', 'applying'].includes(item.status)) {
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
