from pathlib import Path
import json
r=Path('.')
(r/'src/decisions.js').write_text(r'''import { hash } from './config.js';

/** Stable decision identity: unchanged proposed corrections stay decided even
 * when an unrelated field changes. Full guards/revisions remain separate.
 */
export function decisionKey(item) {
  return hash({ key: item.key, kind: item.kind, manual: item.website?.manual_match_account_id || null,
    steps: item.steps.map(step => {
      const resource = step.resource || 'accounts';
      const check = (resource === 'contacts' ? item.contactGuards : item.checks)?.find(c => c.id === step.id);
      const body = Object.fromEntries(Object.entries(step.body).map(([key, value]) => [key,
        typeof value === 'string' ? value.replace(/(?:^|\n)\[review-op:[a-f0-9]{64}\] Source: [^\n]*/g, '').trim() : value
      ]).filter(([, value]) => value !== ''));
      return { resource, method: step.method, id: step.id || null, body,
        before: step.method === 'PATCH' ? Object.fromEntries(Object.keys(body).map(key => [key, check?.before[key] ?? null])) : null };
    }) });
}
''')
p=r/'src/store.js';s=p.read_text().replace("import { randomUUID } from 'node:crypto';", "import { randomUUID } from 'node:crypto';\nimport { decisionKey } from './decisions.js';")
a=s.index('  publish(snapshot, result) {');b=s.index('  async withLock(',a)
s=s[:a]+'''  latestAttempt() {
    const row = this.db.prepare("SELECT * FROM runs WHERE status IN ('complete','failed') ORDER BY rowid DESC LIMIT 1").get();
    return row ? { at: row.at, status: row.status, error: JSON.parse(row.data).error || null } : null;
  }
  publish(snapshot, result) {
    let added = 0, remembered = 0;
    const at = now(), activeIds = [], history = this.list();
    const decided = new Map(history.filter(p => !['pending', 'superseded'].includes(p.status))
      .map(p => [decisionKey(p), p]));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const item of result.proposals) {
        // Preserve older decision IDs and operation journals on upgrade.
        const prior = decided.get(decisionKey(item));
        if (prior) {
          activeIds.push(prior.id);
          this.db.prepare('UPDATE proposals SET last_seen=? WHERE id=?').run(at, prior.id);
          remembered++;
          continue;
        }
        activeIds.push(item.id);
        if (this.get(item.id)) {
          this.db.prepare("UPDATE proposals SET data=?,status='pending',error=NULL,last_seen=? WHERE id=?")
            .run(JSON.stringify(item), at, item.id);
        } else {
          this.db.prepare('INSERT INTO proposals VALUES(?,?,?,?,?,?,?)')
            .run(item.id, item.key, JSON.stringify(item), 'pending', null, at, at);
          added++;
        }
      }
      const active = new Set(activeIds);
      for (const old of history) if (old.status === 'pending' && !active.has(old.id)) this.setStatus(old.id, 'superseded');
      const pending = this.list().filter(p => p.status === 'pending').length;
      this.recordRun('complete', { snapshot, result: { ...result, proposals: activeIds }, summary: {
        facilities: snapshot.website.locations.length, accounts: snapshot.accounts.length,
        contacts: snapshot.contacts.length, added, remembered, pending } });
      this.db.exec('COMMIT');
      return { added, remembered, pending };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
'''+s[b:];p.write_text(s)
p=r/'src/service.js';s=p.read_text().replace('    return { latest: latest ?', '    return { lastAttempt: this.store.latestAttempt(), latest: latest ?')
s=s.replace('      manualLinks: this.store.manualLinks(),', "      accountNames: Object.fromEntries((latest?.snapshot.accounts || []).map(a => [a[this.config.fields.id], a[this.config.fields.name]])),\n      manualLinks: this.store.manualLinks(),")
s=s.replace('      this.store.decision(id, decision, reviewer.trim(), note);', "      if (decision !== 'reject' && this.store.latestAttempt()?.status === 'failed') throw new Error('The latest scan failed. Complete a successful scan before approving or resuming changes.');\n      this.store.decision(id, decision, reviewer.trim(), note);")
s=s.replace('      // A single explicit group approval', "      if (decision === 'approve' && this.store.latestAttempt()?.status === 'failed') throw new Error('The latest scan failed. Scan successfully before approving changes.');\n      // Public evidence is fetched once per batch; CRM targets are still checked individually.\n      const website = decision === 'approve' && !this.verifyWebsite ? await this.readWebsite() : null;\n      // A single explicit group approval")
s=s.replace('          await this.apply(item);', '          await this.apply(item, website);').replace('  async apply(item) {', '  async apply(item, website = null) {').replace('      const current = await this.readWebsite();', '      const current = website || await this.readWebsite();')
s=s.replace("item.steps.filter(step => step.method === 'PATCH' && step.id === check.id)", "item.steps.filter(step => (step.resource || 'accounts') === 'accounts' && step.method === 'PATCH' && step.id === check.id)")
p.write_text(s)
p=r/'src/reconcile.js';s=p.read_text().replace('includes(contact.account_id)', 'includes(contact[config.contactFields.account])').replace('contact.account_id === account[f.id]', 'contact[config.contactFields.account] === account[f.id]');p.write_text(s)
p=r/'public/index.html';s=p.read_text().replace('<section id="summary"', '<section id="scan-status" role="status" aria-live="polite"></section>\n<section id="summary"').replace('<span class="pill">Approval required</span>', '<span class="pill" id="version"></span><span class="pill">Approval required</span>');p.write_text(s)
p=r/'public/app.js';s=p.read_text().replace('selectedId = null, ', '')
s=s.replace('function render() {', '''const canApprove = () => Boolean(state?.latest) && state?.lastAttempt?.status !== 'failed';
function fieldValue(key, value) {
  const f = state.fields;
  return [f.parent, f.duplicate, f.chow].includes(key) && state.accountNames?.[value]
    ? `${state.accountNames[value]} (${value})` : value;
}
function render() {''')
s=s.replace('  const latest = state.latest;', '''  $('version').textContent = `v${state.version || 'unknown'}`;
  const latest = state.latest;
  const failed = state.lastAttempt?.status === 'failed';
  const statusText = failed
    ? `SCAN FAILED — no current reconciliation is available. ${state.lastAttempt.error}${latest ? ' Previous results are stale; approval is disabled until a successful scan.' : ' Zero proposals is not a finding of zero inconsistencies.'}`
    : latest ? 'SCAN SUCCEEDED — complete website, account and contact snapshots were compared.'
    : 'NOT SCANNED — no conclusion about inconsistencies has been made.';
  $('scan-status').replaceChildren(element('div', statusText, failed ? 'error' : 'notice'));''',1)
s=s.replace("[state.proposals.filter(p => p.status === 'pending').length, 'Awaiting your review'],", "[latest ? state.proposals.filter(p => p.status === 'pending').length : '—', 'Awaiting your review'],")
s=s.replace('    const key = item.groupKey || item.kind;', '    const key = `${item.groupKey || item.kind}:${item.status}`;')
s=s.replace("  if (!groups.size) $('queue').append(element('p', 'No items in this view.', 'muted'));", "  if (!groups.size) $('queue').append(element('p', failed ? 'Scan failed. No verified current result.' : !latest ? 'Run a scan before reviewing results.' : 'No items in this filter. Check matched facilities and previous decisions below.', 'muted'));")
s=s.replace("  if (!item) { detail.append(element('div', 'No pending decision here. Use the filters to inspect previous decisions or run a new scan.', 'empty')); return; }", "  if (!item) { detail.append(element('div', !canApprove() ? 'No verified current result. Run a successful read-only scan first.' : 'No pending decision in this view. Check matched facilities and previous decisions below.', 'empty')); return; }")
s=s.replace("Parent: ${account[f.parent] || 'None'}", "Parent: ${fieldValue(f.parent, account[f.parent]) || 'None'}")
s=s.replace("[label(key), before[key], value === '$created_id' ? 'Verified ID of the account created in step 1' : value]", "[label(key), fieldValue(key, before[key]), value === '$created_id' ? 'Verified ID of the account created in step 1' : fieldValue(key, value)]")
s=s.replace("  if ((!insideGroup && (item.status === 'pending' || ['blocked', 'approved', 'applying'].includes(item.status))) ||\n      (insideGroup && ['blocked','approved','applying'].includes(item.status))) {", "  if (['pending', 'blocked', 'approved', 'applying'].includes(item.status)) {")
s=s.replace('button.disabled = busy;', "button.disabled = busy || (action !== 'reject' && !canApprove());",1)
s=s.replace('${label(key)}: ${pretty(before[key])} → ${pretty(after)}', '${label(key)}: ${pretty(fieldValue(key, before[key]))} → ${pretty(fieldValue(key, after))}')
s=s.replace('Approval authorizes every listed operation; unchanged or stale groups are rejected without writing.', 'Approval authorizes every listed operation. Changed membership blocks a batch; stale members are blocked during individual rechecks.')
s=s.replace("      const button = element('button', title, decision === 'reject' ? 'secondary' : '');", "      const button = element('button', title, decision === 'reject' ? 'secondary' : '');\n      button.disabled = busy || (decision === 'approve' && !canApprove());")
s=s.replace("    document.querySelectorAll('button').forEach(button => { button.disabled = false; }); }", "    $('scan').disabled = false; $('refresh').disabled = false; }");p.write_text(s)
p=r/'src/review-server.js';s=p.read_text().replace('const publicRoot =', "const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));\nconst publicRoot =").replace('{ ...service.view(), fields }', '{ ...service.view(), fields, version }');p.write_text(s)
p=r/'package.json';d=json.loads(p.read_text());assert d['version']=='2.2.1';d['version']='2.3.0';d['scripts']['test']='node --test';d['scripts']['test:core']+=' test/contract.test.js';p.write_text(json.dumps(d,indent=2)+'\n')
