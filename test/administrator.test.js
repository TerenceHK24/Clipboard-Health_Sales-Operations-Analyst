import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeConfig } from '../src/config.js';
import { plan, administratorAssessment } from '../src/reconcile.js';
import { ReviewService } from '../src/service.js';
import { Store } from '../src/store.js';
import { account, parent, website, config, MockClient } from '../fixtures/example.js';

const name = 'Jordan Rivera';
const person = (id, personName, title = 'Administrator', status = 'Active', accountId = 'facility-1') => ({
  id, account_id: accountId, name: personName, title, status,
  email: `${id}@example.test`, phone: '(555) 123-9090',
});
const facility = (overrides = {}) => ({
  ...website().locations[0], administrator: name, ...overrides,
});
const makeWebsite = (...locations) => ({ ...website(), locations });
const data = (contacts = [], locations = [facility()], accounts = [parent(), account()]) => ({
  website: makeWebsite(...locations), accounts, contacts,
});
const findAdmin = result => result.proposals.find(row => row.kind === 'admin_contact');

function context(t, rows = data()) {
  const dir = mkdtempSync(join(tmpdir(), 'bellhaven-admin-test-'));
  const store = new Store(dir, 'administrator-review-tests');
  const client = new MockClient(rows.accounts, rows.contacts);
  const service = new ReviewService({ config, store, client, readWebsite: async () => structuredClone(rows.website) });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, client, service };
}
const approval = item => ({ decision: 'approve', revision: item.revision, reviewer: 'QA reviewer' });

test('matching active administrator is reported as matched, without proposing a write', () => {
  const result = plan(data([person('p1', name)]), config);
  assert.equal(findAdmin(result), undefined);
  assert.equal(result.matches[0].administratorCheck.status, 'matched');
  assert.deepEqual(result.matches[0].administratorCheck.crmActive, [name]);
});

test('different CRM administrator creates an explicit approval proposal with source comparison', () => {
  const result = plan(data([person('old', 'Morgan Lee')]), config);
  const item = findAdmin(result);
  assert.equal(result.matches[0].administratorCheck.status, 'approval_required');
  assert.match(result.matches[0].result, /Administrator approval required/);
  assert.match(item.reason, /Jordan Rivera/);
  assert.match(item.reason, /Morgan Lee/);
  assert.deepEqual(item.steps.map(s => s.method), ['POST', 'PATCH']);
  assert.equal(item.steps[0].body.name, name);
  assert.deepEqual(item.steps[1].body, { status: 'Inactive' });
});

test('administrator mismatch approval adds correct contact and inactivates old; scans alone never write', async t => {
  const { client, store, service } = context(t, data([person('old', 'Morgan Lee')]));
  await service.scan();
  assert.equal(client.writes.length, 0);
  const item = store.list().find(p => p.kind === 'admin_contact');
  assert.ok(item);
  await service.decide(item.id, approval(item));
  const contacts = await client.list('contacts');
  const active = contacts.filter(c => c.title === 'Administrator' && c.status === 'Active');
  assert.equal(active.length, 1);
  assert.equal(active[0].name, name);
  assert.equal(contacts.find(c => c.id === 'old').email, 'old@example.test');
  assert.equal(contacts.find(c => c.id === 'old').status, 'Inactive');
  await service.scan();
  assert.equal(store.list().filter(p => p.kind === 'admin_contact' && p.status === 'pending').length, 0);
  assert.equal(service.view().latest.matches[0].administratorCheck.status, 'matched');
});

test('existing contact with website name but another job title is promoted after approval, not duplicated', async t => {
  const contacts = [person('old', 'Morgan Lee'), person('target', name, 'Care Director')];
  const { client, service, store } = context(t, data(contacts));
  await service.scan();
  const item = store.list().find(p => p.kind === 'admin_contact');
  assert.ok(item);
  assert.deepEqual(item.steps.map(s => [s.method, s.id || 'new']), [['PATCH', 'target'], ['PATCH', 'old']]);
  assert.deepEqual(item.steps[0].body, { title: 'Administrator' });
  assert.equal(client.writes.length, 0);
  await service.decide(item.id, approval(item));
  const updated = await client.getContact('target');
  assert.equal(updated.title, 'Administrator');
  assert.equal(updated.name, name);
  assert.equal(updated.email, 'target@example.test');
  assert.equal(updated.phone, '(555) 123-9090');
  assert.equal((await client.getContact('old')).status, 'Inactive');
  assert.equal(client.writes.some(w => w.method === 'POST'), false);
  await service.scan();
  assert.equal(store.list().filter(p => p.kind === 'admin_contact' && p.status === 'pending').length, 0);
});

test('an inactive existing person is activated and assigned Administrator title only on approval', async t => {
  const contacts = [person('old', 'Morgan Lee'), person('target', name, 'Nurse Director', 'Inactive')];
  const { client, service, store } = context(t, data(contacts));
  await service.scan();
  const item = store.list().find(p => p.kind === 'admin_contact');
  assert.deepEqual(item.steps[0].body, { title: 'Administrator', status: 'Active' });
  await service.decide(item.id, approval(item));
  const updated = await client.getContact('target');
  assert.equal(updated.title, 'Administrator');
  assert.equal(updated.status, 'Active');
  assert.equal((await client.getContact('old')).status, 'Inactive');
});

test('correct website administrator with an additional active administrator proposes only inactivation', () => {
  const result = plan(data([person('current', name), person('old', 'Morgan Lee')]), config);
  const item = findAdmin(result);
  assert.equal(result.matches[0].administratorCheck.status, 'approval_required');
  assert.deepEqual(item.steps.map(s => [s.method, s.id, s.body]), [['PATCH', 'old', { status: 'Inactive' }]]);
});

test('two matching CRM contacts are not silently chosen or duplicated', () => {
  const result = plan(data([person('a', name), person('b', name)]), config);
  assert.equal(findAdmin(result), undefined);
  assert.equal(result.matches[0].administratorCheck.status, 'manual_review');
  assert.ok(result.notices.some(n => n.includes('administrator identity needs manual verification')));
});

test('two different-role CRM contacts with same name require manual review rather than POST', () => {
  const result = plan(data([person('a', name, 'Director'), person('b', name, 'Nurse')]), config);
  assert.equal(findAdmin(result), undefined);
  assert.equal(result.matches[0].administratorCheck.status, 'manual_review');
});

test('similar personal names or nicknames are flagged for manual identity review, not duplicated', () => {
  const result = plan(data([person('old', 'Jordana Rivera')]), config);
  assert.equal(findAdmin(result), undefined);
  assert.equal(result.matches[0].administratorCheck.status, 'manual_review');
  assert.match(result.matches[0].administratorCheck.message, /first initial and surname/);
});

test('missing published administrator is unknown, not falsely marked as matched and not overwritten', () => {
  const result = plan(data([person('old', 'Morgan Lee')], [facility({ administrator: '' })]), config);
  assert.equal(findAdmin(result), undefined);
  assert.equal(result.matches[0].administratorCheck.status, 'unavailable');
});

test('a new or changed administrator roster blocks approval before any write', async t => {
  const { client, service, store } = context(t, data([person('old', 'Morgan Lee')]));
  await service.scan();
  const item = store.list().find(p => p.kind === 'admin_contact');
  client.contactRows.set('someone-new', person('someone-new', 'Unrelated Admin'));
  await assert.rejects(service.decide(item.id, approval(item)), /roster changed/);
  assert.equal(client.writes.length, 0);
  assert.equal(store.get(item.id).status, 'blocked');
});

test('when a different-role copy appears after scan, creation is rejected before any write', async t => {
  const { client, service, store } = context(t, data([person('old', 'Morgan Lee')]));
  await service.scan();
  const item = store.list().find(p => p.kind === 'admin_contact');
  client.contactRows.set('new-copy', person('new-copy', name, 'Director'));
  await assert.rejects(service.decide(item.id, approval(item)), /roster changed/);
  assert.equal(client.writes.length, 0);
});

test('administrator title alternatives remain configurable, not facility-specific', () => {
  const custom = makeConfig({ siteUrl: config.siteUrl, apiUrl: config.apiUrl,
    administratorTitles: ['Administrator', 'Facility Administrator'] });
  const result = plan(data([person('a', name, 'Facility Administrator')]), custom);
  assert.equal(result.matches[0].administratorCheck.status, 'matched');
  assert.equal(findAdmin(result), undefined);
});

test('CHOW defers administrator contact changes and preserves old account contacts', () => {
  const row = account({ parent_id: 'other-parent', lifetime_revenue: 500, outstanding_ar: 10 });
  const result = plan(data([person('old', 'Morgan Lee')], [facility()], [parent(), row]), config);
  assert.equal(result.matches[0].administratorCheck.status, 'deferred');
  assert.equal(findAdmin(result), undefined);
  assert.ok(result.proposals.some(p => p.kind === 'chow'));
});

test('inactive facility defers administrator contact changes until facility account is reviewed', () => {
  const result = plan(data([person('old', 'Morgan Lee')], [facility()], [parent(), account({ status: 'Inactive' })]), config);
  assert.equal(result.matches[0].administratorCheck.status, 'deferred');
  assert.equal(findAdmin(result), undefined);
});

test('administrator differences across facilities remain grouped but individually approved', async t => {
  const a = facility();
  const b = facility({ name: 'Sample Village', address: '12 River Ave', city: 'Riverton', zip: '45678', administrator: 'Avery Jones',
    source_url: config.siteUrl + '/communities/sample-village' });
  const secondAccount = account({ id: 'facility-2', name: b.name, billing_street: b.address, billing_city: b.city, billing_zip: b.zip });
  const oldA = person('old-a', 'Morgan Lee');
  const oldB = person('old-b', 'Taylor Smith', 'Administrator', 'Active', 'facility-2');
  const { store, service, client } = context(t, data([oldA, oldB], [a, b], [parent(), account(), secondAccount]));
  await service.scan();
  const proposals = store.list().filter(p => p.kind === 'admin_contact' && p.status === 'pending');
  assert.equal(proposals.length, 2);
  assert.equal(proposals[0].groupKey, proposals[1].groupKey);
  const groupKey = proposals[0].groupKey;
  assert.equal(client.writes.length, 0);
  const response = await service.decideGroup({ groupKey, members: proposals.map(p => ({ id: p.id, revision: p.revision })), decision: 'approve', reviewer: 'QA reviewer' });
  assert.equal(response.applied, 2);
  const contacts = await client.list('contacts');
  assert.equal(contacts.filter(c => c.status === 'Active' && c.title === 'Administrator').length, 2);
  await service.scan();
  assert.equal(store.list().filter(p => p.kind === 'admin_contact' && p.status === 'pending').length, 0);
});
