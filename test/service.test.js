import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { ReviewService } from '../src/service.js';
import { account, parent, website, config, clone, MockClient } from '../fixtures/example.js';

function setup(t, rows = [parent(), account({ name: 'Old Name' })]) {
  const directory = mkdtempSync(join(tmpdir(), 'community-review-test-'));
  let store = new Store(directory, 'local-test-scope');
  const client = new MockClient(rows);
  const site = website();
  const make = () => new ReviewService({ config, client, store, readWebsite: async () => clone(site) });
  let service = make();
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { client, site, get store() { return store; }, get service() { return service; },
    restart() { store.close(); store = new Store(directory, 'local-test-scope'); service = make(); }, directory };
}
const decision = (item, action = 'approve') => ({ decision: action, revision: item.revision, reviewer: 'Local test reviewer' });
const pending = context => context.store.list().find(p => p.status === 'pending');

test('scan and rejection perform zero CRM writes; rejection survives a restart', async t => {
  const c = setup(t);
  await c.service.scan();
  const item = pending(c);
  assert.equal(c.client.writes.length, 0);
  await c.service.decide(item.id, decision(item, 'reject'));
  c.restart();
  const summary = await c.service.scan();
  assert.equal(summary.pending, 0);
  assert.equal(summary.remembered, 1);
  assert.equal(c.client.writes.length, 0);
});
test('approved patch is read back and does not re-propose or write twice', async t => {
  const c = setup(t); await c.service.scan(); const item = pending(c);
  await c.service.decide(item.id, decision(item));
  assert.equal(c.client.writes.length, 1);
  assert.equal((await c.client.get('facility-1')).name, 'Example Residence');
  await c.service.decide(item.id, decision(item));
  assert.equal(c.client.writes.length, 1);
  c.restart(); await c.service.scan();
  assert.equal(c.store.list().filter(p => p.status === 'pending').length, 0);
});
test('a review revision mismatch cannot write', async t => {
  const c = setup(t); await c.service.scan(); const item = pending(c);
  await assert.rejects(c.service.decide(item.id, { ...decision(item), revision: 'outdated' }), /stale/);
  assert.equal(c.client.writes.length, 0);
});
test('changed CRM evidence blocks approval before any write', async t => {
  const c = setup(t); await c.service.scan(); const item = pending(c);
  c.client.rows.get('facility-1').note = 'Changed by another operator';
  await assert.rejects(c.service.decide(item.id, decision(item)), /changed since review/);
  assert.equal(c.client.writes.length, 0);
});
test('changed public evidence blocks approval before any write', async t => {
  const c = setup(t); await c.service.scan(); const item = pending(c);
  c.site.locations[0].phone = '555-555-0199';
  await assert.rejects(c.service.decide(item.id, decision(item)), /Website evidence changed/);
  assert.equal(c.client.writes.length, 0);
});
test('CHOW preserves every old field except chow_current_account', async t => {
  const old = account({ parent_id: 'former-parent', lifetime_revenue: 25000, outstanding_ar: 2000, note: 'Billing note', status: 'Active' });
  const c = setup(t, [parent(), old]); await c.service.scan(); const item = pending(c);
  assert.equal(item.kind, 'chow');
  await c.service.decide(item.id, decision(item));
  const current = await c.client.get(old.id), newId = current.chow_current_account;
  assert.deepEqual(current, { ...old, chow_current_account: newId });
  const created = await c.client.get(newId);
  assert.equal(created.parent_id, parent().id);
  assert.equal(created.lifetime_revenue, 0); assert.equal(created.outstanding_ar, 0);
  assert.deepEqual(c.client.writes[1].body, { chow_current_account: newId });
  c.restart(); await c.service.scan();
  assert.equal(c.store.list().filter(p => p.status === 'pending').length, 0);
});
test('a create committed before timeout is recovered by marker, never POSTed again', async t => {
  const c = setup(t, [parent()]); c.client.failAfterCreate = true;
  await c.service.scan(); const item = pending(c);
  await assert.rejects(c.service.decide(item.id, decision(item)), /Response lost/);
  c.restart();
  await c.service.decide(item.id, decision(item, 'retry'));
  assert.equal(c.client.writes.filter(w => w.method === 'POST').length, 1);
  assert.equal(c.store.get(item.id).status, 'applied');
});
test('uncertain create without a visible marker fails closed on retry', async t => {
  const c = setup(t, [parent()]); c.client.failBeforeCreate = true;
  await c.service.scan(); const item = pending(c);
  await assert.rejects(c.service.decide(item.id, decision(item)), /unknown/);
  c.restart(); c.client.failBeforeCreate = false;
  await assert.rejects(c.service.decide(item.id, decision(item, 'retry')), /No second POST/);
  assert.equal(c.client.writes.length, 1);
});
test('CHOW can resume after create succeeds and link PATCH fails', async t => {
  const old = account({ parent_id: 'former', lifetime_revenue: 10, outstanding_ar: 1, note: 'Keep exactly' });
  const c = setup(t, [parent(), old]); c.client.failBeforePatch = true;
  await c.service.scan(); const item = pending(c);
  await assert.rejects(c.service.decide(item.id, decision(item)), /Patch not delivered/);
  assert.deepEqual(await c.client.get(old.id), old);
  c.restart(); await c.service.decide(item.id, decision(item, 'retry'));
  assert.equal(c.client.writes.filter(w => w.method === 'POST').length, 1);
  assert.equal((await c.client.get(old.id)).chow_current_account, 'created-1');
});
test('lost CHOW link response recovers without creating or patching twice', async t => {
  const c = setup(t, [parent(), account({ parent_id: 'former', lifetime_revenue: 10, outstanding_ar: 1 })]);
  c.client.failAfterPatch = true;
  await c.service.scan(); const item = pending(c);
  await assert.rejects(c.service.decide(item.id, decision(item)), /Response lost/);
  c.restart(); await c.service.decide(item.id, decision(item, 'retry'));
  assert.equal(c.client.writes.length, 2);
});
test('new receivables block an earlier direct re-parent recommendation', async t => {
  const c = setup(t, [parent(), account({ parent_id: 'former', lifetime_revenue: 10, outstanding_ar: 0 })]);
  await c.service.scan(); const item = pending(c);
  c.client.rows.get('facility-1').outstanding_ar = 5;
  await assert.rejects(c.service.decide(item.id, decision(item)), /changed since review/);
  assert.equal(c.client.writes.length, 0);
});
test('a competing account created after the scan prevents duplicate creation', async t => {
  const c = setup(t, [parent()]); await c.service.scan(); const item = pending(c);
  c.client.rows.set('competitor', account({ id: 'competitor' }));
  await assert.rejects(c.service.decide(item.id, decision(item)), /potential matching account appeared/);
  assert.equal(c.client.writes.length, 0);
});
test('a second process/connection cannot overlap the journal lock', async t => {
  const c = setup(t); const other = new Store(c.directory, 'local-test-scope');
  try { await c.store.withLock(async () => assert.rejects(other.withLock(async () => {}), /holds the local journal lock/)); }
  finally { other.close(); }
});
test('state cannot be reused silently with another tenant API/site scope', t => {
  const c = setup(t);
  assert.throws(() => new Store(c.directory, 'another-tenant'), /different API/);
});
test('a suspicious count drop leaves the last successful snapshot intact', async t => {
  const c = setup(t); await c.service.scan();
  c.site.locations = [];
  await assert.rejects(c.service.scan(), /count dropped/);
  assert.equal(c.store.latest().snapshot.website.locations.length, 1);
});
test('an approved but interrupted operation is never applied by a daily scan', async t => {
  const c = setup(t, [parent()]); c.client.failAfterCreate = true;
  await c.service.scan(); const item = pending(c);
  await assert.rejects(c.service.decide(item.id, decision(item)));
  const writes = c.client.writes.length;
  c.restart(); await c.service.scan();
  assert.equal(c.client.writes.length, writes);
});
