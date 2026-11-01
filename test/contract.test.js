import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identify, CrmClient } from '../src/crm.js';
import { Store } from '../src/store.js';
import { ReviewService } from '../src/service.js';
import { sandbox, scenario, TOKEN } from '../fixtures/http.js';
async function setup(t, data = scenario()) {
  const api = await sandbox(data), dir = await mkdtemp(join(tmpdir(), 'contract-'));
  const store = new Store(dir, 'synthetic-contract'), client = new CrmClient(api.config, TOKEN);
  const service = new ReviewService({ config: api.config, client, store, readWebsite: async () => structuredClone(api.website) });
  t.after(async () => { store.close(); await api.close(); await rm(dir, { recursive: true, force: true }); });
  return { ...api, store, client, service };
}
const decide = (service, item, decision = 'approve') => service.decide(item.id, { revision: item.revision, decision, reviewer: 'QA' });

test('reported account_id format works without user configuration', () => {
  const row = { account_id: 'external', name: 'Example' };
  assert.deepEqual(identify(row), { ...row, id: 'external' }); assert.equal(row.id, undefined);
});
test('contact account_id is never treated as its primary contact ID', () => {
  assert.equal(identify({ contact_id: 'person', account_id: 'facility' }, 'contacts').id, 'person');
  assert.throws(() => identify({ account_id: 'facility' }, 'contacts'), /missing string ID/);
});
test('conflicting aliases and incorrect custom mapping fail safely', () => {
  assert.throws(() => identify({ id: 'a', account_id: 'b' }), /conflicting/);
  for (const bad of ['', 0, null, false]) assert.throws(() => identify({ account_id: bad }), /missing string ID/);
  assert.throws(() => identify({ account_id: 'a' }, 'accounts', 'custom_key'), /custom_key/);
});
test('all account/contact GET/list/POST/PATCH response paths adapt wire keys', async t => {
  const { client, calls } = await setup(t);
  const rows = await client.list(); assert.equal(rows.length, 6); assert.ok(rows.every(a => a.id === a.account_id));
  assert.ok(calls.length >= 3, 'multiple capped pages were read');
  const contacts = await client.list('contacts'); assert.equal(contacts[0].id, contacts[0].contact_id);
  const created = await client.create({ name: 'New fixture', parent_id: 'parent-1', status: 'Active' });
  assert.equal((await client.get(created.id)).id, created.id);
  assert.equal((await client.patch(created.id, { status: 'Needs Review' })).status, 'Needs Review');
  const person = await client.createContact({ account_id: created.id, name: 'New Person', title: 'Administrator', status: 'Active' });
  assert.equal(person.id, person.contact_id); assert.equal((await client.getContact(person.id)).account_id, created.id);
  assert.equal((await client.patchContact(person.id, { status: 'Inactive' })).status, 'Inactive');
});
test('read-back rejects a record different from the requested ID', async t => {
  const { client } = await setup(t); client.fetch = async () => ({ ok: true, json: async () => ({ account_id: 'wrong' }) });
  await assert.rejects(client.get('expected'), /response ID differs/);
});
test('REST-shaped scan finds inconsistencies and synonyms without any write', async t => {
  const { service, store, writes } = await setup(t); assert.ok((await service.scan()).pending >= 5); assert.deepEqual(writes, []);
  const view = service.view(); assert.equal(view.lastAttempt.status, 'complete'); assert.equal(view.latest.summary.accounts, 6); assert.equal(view.latest.summary.contacts, 1);
  assert.ok(view.latest.matches.some(m => m.result === 'Matched (care synonym)'));
  for (const kind of ['update', 'admin_contact', 'create', 'chow', 'missing_from_site']) assert.ok(store.list().some(p => p.kind === kind), kind);
});
test('approved name PATCH is verified and not re-proposed', async t => {
  const { service, store, accounts, writes } = await setup(t); await service.scan();
  const item = store.list().find(p => p.kind === 'update'); await decide(service, item);
  assert.equal(accounts.get('facility-1').name, 'Example Residence'); assert.equal(writes.length, 1);
  await service.scan(); assert.equal(store.get(item.id).status, 'applied');
  assert.equal(store.list().filter(p => p.kind === 'update' && p.status === 'pending').length, 0);
});
test('rejected administrator change stays decided after unrelated account correction', async t => {
  const { service, store } = await setup(t); await service.scan(); const admin = store.list().find(p => p.kind === 'admin_contact');
  await decide(service, admin, 'reject'); await decide(service, store.list().find(p => p.kind === 'update')); await service.scan();
  assert.equal(store.get(admin.id).status, 'rejected'); assert.equal(store.list().filter(p => p.kind === 'admin_contact' && p.status === 'pending').length, 0);
});
test('CHOW preserves all old business fields; only the current-account link changes', async t => {
  const { service, store, accounts, writes } = await setup(t); await service.scan(); const old = structuredClone(accounts.get('south'));
  await decide(service, store.list().find(p => p.kind === 'chow')); const id = accounts.get('south').chow_current_account; assert.ok(id);
  assert.deepEqual(accounts.get('south'), { ...old, chow_current_account: id });
  assert.equal(accounts.get(id).parent_id, 'parent-1'); assert.equal(accounts.get(id).lifetime_revenue, 0); assert.equal(accounts.get(id).outstanding_ar, 0);
  await service.scan(); assert.equal(writes.filter(w => w.method === 'POST' && w.resource === 'accounts').length, 1);
  assert.equal(store.list().filter(p => p.kind === 'chow' && p.status === 'pending').length, 0);
});
test('zero outstanding AR directly reparents without a new account', async t => {
  const data = scenario(); data.accounts.find(a => a.id === 'south').outstanding_ar = 0;
  const { service, store, accounts, writes } = await setup(t, data); await service.scan(); await decide(service, store.list().find(p => p.kind === 'reparent'));
  assert.equal(accounts.get('south').parent_id, 'parent-1'); assert.equal(writes.filter(w => w.method === 'POST').length, 0);
});
test('administrator writeback uses contact_id and preserves old person/email', async t => {
  const { service, store, contacts } = await setup(t); await service.scan(); await decide(service, store.list().find(p => p.kind === 'admin_contact'));
  assert.equal(contacts.get('old-admin').status, 'Inactive'); assert.equal(contacts.get('old-admin').name, 'Former Person'); assert.equal(contacts.get('old-admin').email, 'former@example.test');
  const current = [...contacts.values()].find(c => c.name === 'Ada Example'); assert.equal(current.status, 'Active'); assert.equal(current.email, null);
  await service.scan(); assert.equal(store.list().filter(p => p.kind === 'admin_contact' && p.status === 'pending').length, 0);
});
test('failed scan persists a failure, not a clean empty result; subsequent scan recovers', async t => {
  const { service, store, flags, writes } = await setup(t); flags.invalidId = true;
  await assert.rejects(service.scan(), /missing string ID/); assert.equal(service.view().lastAttempt.status, 'failed'); assert.equal(service.view().latest, null);
  assert.equal(store.list().length, 0); assert.equal(writes.length, 0); flags.invalidId = false; await service.scan(); assert.equal(service.view().lastAttempt.status, 'complete');
});
test('failed refresh prevents approving stale results', async t => {
  const { service, store, flags, writes } = await setup(t); await service.scan(); const item = store.list().find(p => p.kind === 'update');
  flags.rejectReads = true; await assert.rejects(service.scan()); await assert.rejects(decide(service, item), /latest scan failed/); assert.equal(writes.length, 0);
  flags.rejectReads = false; await service.scan(); await decide(service, store.get(item.id)); assert.equal(writes.length, 1);
});
test('credential is not persisted in the review database', async t => {
  const { service, store } = await setup(t); await service.scan(); store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  assert.ok(!(await readFile(store.path)).includes(Buffer.from(TOKEN)));
});
