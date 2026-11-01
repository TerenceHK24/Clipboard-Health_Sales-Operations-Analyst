import test from 'node:test';
import assert from 'node:assert/strict';
import { plan, needsChow, amount, identityScore } from '../src/reconcile.js';
import { account, parent, website, snapshot, config } from '../fixtures/example.js';

test('a fully matched facility and corporate office need no changes', () => {
  const result = plan(snapshot(), config);
  assert.equal(result.proposals.length, 0);
  assert.equal(result.matches[0].result, 'Matched');
});
test('corporate address is compared without erasing unpublished ZIP', () => {
  const result = plan(snapshot([parent({ billing_street: '1 Old Avenue' }), account()]), config);
  assert.deepEqual(result.proposals[0].steps[0].body, { billing_street: '80 Corporate Road' });
});
test('missing parent is proposed first and facility creation waits', () => {
  const result = plan(snapshot([]), config);
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].kind, 'create_parent');
  assert.equal(result.proposals[0].steps[0].body.billing_zip, undefined);
});
test('outdated name matches by address, not a hard-coded facility list', () => {
  const result = plan(snapshot([parent(), account({ name: 'Prior Operator Lodge' })]), config);
  assert.equal(result.proposals[0].kind, 'update');
  assert.deepEqual(result.proposals[0].steps[0].body, { name: 'Example Residence' });
});
test('an unrelated brand in the directory is still a facility', () => {
  const site = website(); site.locations[0].name = 'Amber House';
  assert.equal(plan(snapshot([parent()], site), config).proposals[0].steps[0].body.name, 'Amber House');
});
test('a missing facility receives a create proposal under the discovered parent', () => {
  const result = plan(snapshot([parent()]), config);
  assert.equal(result.proposals[0].kind, 'create');
  assert.equal(result.proposals[0].steps[0].body.parent_id, parent().id);
});
test('accounts elsewhere in CRM are matched without brand search', () => {
  const row = account({ name: 'Prior Operator Lodge', parent_id: 'other-parent' });
  const result = plan(snapshot([parent(), row]), config);
  assert.equal(result.proposals[0].kind, 'reparent');
  assert.equal(result.proposals[0].steps[0].body.parent_id, parent().id);
});
for (const [revenue, ar, kind] of [[100, 20, 'chow'], [100, 0, 'reparent'], [0, 20, 'reparent'], [0, 0, 'reparent']]) {
  test(`ownership gate: revenue=${revenue}, AR=${ar} -> ${kind}`, () => {
    const row = account({ parent_id: 'old-parent', lifetime_revenue: revenue, outstanding_ar: ar });
    const item = plan(snapshot([parent(), row]), config).proposals[0];
    assert.equal(item.kind, kind);
    if (kind === 'chow') {
      assert.deepEqual(item.steps[1].body, { chow_current_account: '$created_id' });
      assert.ok(!('lifetime_revenue' in item.steps[0].body));
      assert.ok(!('outstanding_ar' in item.steps[0].body));
    }
  });
}
test('missing or invalid money never becomes zero', () => {
  for (const value of [null, undefined, '', true, -1, 'not-a-number']) assert.equal(amount(value), null);
  assert.equal(needsChow(account({ lifetime_revenue: null }), config), null);
  const result = plan(snapshot([parent(), account({ parent_id: 'old', outstanding_ar: null })]), config);
  assert.equal(result.proposals.length, 0);
  assert.match(result.notices[0], /blocked/);
});
test('duplicate survivor retains the receivables-bearing account', () => {
  const funded = account({ id: 'funded', lifetime_revenue: 200, outstanding_ar: 25 });
  const empty = account({ id: 'empty', note: 'Keep this note' });
  const item = plan(snapshot([parent(), funded, empty]), config).proposals.find(p => p.kind === 'duplicate');
  assert.equal(item.steps[0].id, 'empty');
  assert.equal(item.steps[0].body.duplicate_of_account, 'funded');
  assert.equal(item.steps[0].body.status, 'Inactive');
  assert.match(item.steps[0].body.note, /^Keep this note/);
});
test('co-located differently named services are not silently merged', () => {
  const result = plan(snapshot([parent(), account({ name: 'North Wing', phone: '', care_type: 'Memory Support' }),
    account({ id: 'other', name: 'South Wing', phone: '', care_type: 'Nursing' })]), config);
  assert.ok(!result.proposals.some(p => ['duplicate', 'create', 'chow', 'reparent'].includes(p.kind)));
  assert.ok(result.notices.some(n => /ambiguous/.test(n)));
});
test('one CRM account cannot be assigned to two public facilities', () => {
  const site = website(); site.locations.push({ ...site.locations[0], source_url: config.siteUrl + '/communities/second' });
  const result = plan(snapshot([parent(), account()], site), config);
  assert.ok(result.proposals.every(p => p.kind === 'flag_ambiguous'));
});
test('missing-site account is flagged, not deactivated or detached', () => {
  const extra = account({ id: 'absent', name: 'Remote Residence', billing_street: '99 Elm Lane', billing_city: 'Elsewhere', note: 'History' });
  const item = plan(snapshot([parent(), account(), extra]), config).proposals[0];
  assert.equal(item.kind, 'missing_from_site');
  assert.equal(item.steps[0].body.status, 'Needs Review');
  assert.ok(!('parent_id' in item.steps[0].body));
  assert.match(item.steps[0].body.note, /^History/);
});
test('resolved duplicates and old CHOW records are excluded from fresh matching', () => {
  const result = plan(snapshot([parent(), account(), account({ id: 'duplicate', duplicate_of_account: 'facility-1', status: 'Inactive' }),
    account({ id: 'old', chow_current_account: 'facility-1' })]), config);
  assert.equal(result.proposals.length, 0);
});
test('incomplete website snapshots cannot generate missing-site decisions', () => {
  const site = website(); site.complete = false;
  assert.throws(() => plan(snapshot([parent(), account()], site), config), /complete/);
});
test('timestamps do not alter decision fingerprints', () => {
  const a = snapshot([parent(), account({ name: 'Old Name', updated_at: 'yesterday' })]);
  const b = snapshot([parent(), account({ name: 'Old Name', updated_at: 'today' })]);
  b.website.fetchedAt = 'tomorrow';
  assert.equal(plan(a, config).proposals[0].id, plan(b, config).proposals[0].id);
});
test('formatting differences do not produce phone/street churn', () => {
  assert.equal(plan(snapshot([parent(), account({ billing_street: '18 Oak Street', phone: '+1 555 555 0100' })]), config).proposals.length, 0);
  assert.ok(identityScore(website().locations[0], account(), config) >= 100);
});
test('schema drift fails closed rather than pretending the CRM is empty', () => {
  const broken = account(); delete broken.parent_id;
  assert.throws(() => plan(snapshot([parent(), broken]), config), /missing mapped field/);
});
