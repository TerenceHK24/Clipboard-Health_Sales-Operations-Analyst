import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { CrmClient, collection, record } from '../src/crm.js';
import { makeConfig } from '../src/config.js';
import { account, parent } from '../fixtures/example.js';

async function transport(t, handler, overrides = {}) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return new CrmClient(makeConfig({ apiUrl: `${origin}/api/v1/`, pageSize: 50, ...overrides }), 'synthetic-test-token');
}
const reply = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };

test('API GET uses Bearer authentication and reads every capped page', async t => {
  let calls = 0;
  const client = await transport(t, (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer synthetic-test-token');
    const page = Number(new URL(req.url, 'http://local').searchParams.get('page'));
    calls++;
    reply(res, { items: page === 1 ? [parent()] : page === 2 ? [account()] : [], total: 2 });
  });
  assert.equal((await client.list()).length, 2); assert.equal(calls, 2);
});
test('unknown totals require a final empty page, not a short-page guess', async t => {
  let calls = 0;
  const client = await transport(t, (req, res) => { calls++; reply(res, calls === 1 ? [parent()] : calls === 2 ? [account()] : []); });
  assert.equal((await client.list()).length, 2); assert.equal(calls, 3);
});
test('duplicate pages or changing totals fail closed', async t => {
  const client = await transport(t, (req, res) => reply(res, { items: [account()], total: 3 }));
  await assert.rejects(client.list(), /pagination stopped advancing|repeating pages/);
});
test('a premature end is not interpreted as a complete CRM snapshot', async t => {
  let calls = 0;
  const client = await transport(t, (req, res) => reply(res, { items: ++calls === 1 ? [account()] : [], total: 3 }));
  await assert.rejects(client.list(), /directory ended|complete.*pagination/);
});
test('a failed POST is sent only once', async t => {
  let calls = 0;
  const client = await transport(t, (req, res) => { calls++; reply(res, {}, 503); });
  await assert.rejects(client.create({ name: 'Example' }), /HTTP 503/);
  assert.equal(calls, 1);
});
test('a failed PATCH is sent only once', async t => {
  let calls = 0;
  const client = await transport(t, (req, res) => { calls++; reply(res, {}, 500); });
  await assert.rejects(client.patch('id', { status: 'Needs Review' }), /HTTP 500/);
  assert.equal(calls, 1);
});
test('unknown response envelopes are rejected rather than treated as empty', () => {
  assert.throws(() => collection({ surprise: [] }, 'accounts'), /Unrecognized/);
  assert.throws(() => record({ message: 'ok' }), /identifiable/);
});
test('known response envelopes can be validated without hard-coded rows', () => {
  for (const key of ['items', 'data', 'results', 'accounts']) assert.equal(collection({ [key]: [account()], total: 1 }, 'accounts').items.length, 1);
  assert.equal(record({ data: account() }).id, account().id);
});
test('authorization headers cannot be redirected to another host', async t => {
  let redirected = false;
  const target = createServer((req, res) => { redirected = true; reply(res, account()); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => target.close(resolve)));
  const client = await transport(t, (req, res) => { res.writeHead(302, { Location: `http://127.0.0.1:${target.address().port}/steal` }); res.end(); });
  await assert.rejects(client.create({ name: 'Example' }));
  assert.equal(redirected, false);
});
test('configuration rejects remote plaintext, URL credentials, and field collisions', () => {
  assert.throws(() => makeConfig({ apiUrl: 'http://remote.example/api/' }), /HTTPS/);
  assert.throws(() => makeConfig({ apiUrl: 'https://secret@example.test/api/' }), /credentials/);
  assert.throws(() => makeConfig({ fields: { name: 'id' } }), /distinct/);
});

// The real API may overlap stable records at page boundaries even though
// its complete response advertises the correct count. Recover only after
// collecting all distinct IDs and verifying the entire snapshot again.
test('verified overlapping pages return each account once without losing data', async t => {
  const a = { ...parent(), id: 'acc-a' };
  const b = { ...account(), id: 'acc-b' };
  const c = { ...account(), id: 'acc-c', name: 'Another facility' };
  const pages = { 1: [a, b], 2: [b, c] };
  let calls = 0;
  const client = await transport(t, (req, res) => {
    calls++;
    const page = Number(new URL(req.url, 'http://local').searchParams.get('page'));
    reply(res, { items: pages[page] || [], total: 3 });
  }, { pageSize: 2 });
  assert.deepEqual((await client.list()).map(x => x.id), ['acc-a', 'acc-b', 'acc-c']);
  assert.equal(calls, 4, 'two complete reads are required after detecting overlaps');
});

test('recover from repeated pages by using a different page_size, with confirmation', async t => {
  const accounts = [{ ...parent(), id: 'acc-a' }, { ...account(), id: 'acc-b' }, { ...account(), id: 'acc-c' }];
  let smallCalls = 0, largeCalls = 0;
  const client = await transport(t, (req, res) => {
    const q = new URL(req.url, 'http://local').searchParams;
    const page = Number(q.get('page'));
    const size = Number(q.get('page_size'));
    if (size === 2) {
      smallCalls++;
      reply(res, { items: [accounts[0]], total: 3 });
    } else if (size === 4) {
      largeCalls++;
      reply(res, { items: page === 1 ? accounts : [], total: 3 });
    } else {
      reply(res, { items: [], total: 3 });
    }
  }, { pageSize: 2 });
  const rows = await client.list();
  assert.deepEqual(rows.map(r => r.id), ['acc-a', 'acc-b', 'acc-c']);
  assert.equal(smallCalls, 3);
  assert.equal(largeCalls, 2, 'fallback snapshot must be read twice');
});

test('reports the missing ID field and available keys instead of a misleading duplicate error', async t => {
  const client = await transport(t, (req, res) => reply(res, { items: [{ account_key: 'acc-1', name: 'Sample' }], total: 1 }));
  await assert.rejects(client.list(), error => {
    assert.match(error.message, /missing string ID field 'id'/);
    assert.match(error.message, /page 1, item 1/);
    assert.match(error.message, /account_key/);
    assert.doesNotMatch(error.message, /sample-secret-token/);
    return true;
  });
});

test('does not recover unsafe duplicates inside the same API response', async t => {
  const client = await transport(t, (req, res) => reply(res, { items: [account(), account()], total: 2 }));
  await assert.rejects(client.list(), /same ID twice within one response/);
});

test('contact ID mapping is configurable independently of account IDs', async t => {
  const client = await transport(t, (req, res) => {
    const page = Number(new URL(req.url, 'http://local').searchParams.get('page'));
    reply(res, { items: page === 1 ? [{ contact_key: 'contact-1', name: 'Contact' }] : [], total: 1 });
  }, { contactFields: { id: 'contact_key' } });
  assert.equal((await client.list('contacts'))[0].contact_key, 'contact-1');
});

test('rejects overlapping records when their payload changes during the scan', async t => {
  const a = { ...parent(), id: 'acc-a' }, b = { ...account(), id: 'acc-b' };
  const client = await transport(t, (req, res) => {
    const q = new URL(req.url, 'http://local').searchParams;
    const page = Number(q.get('page'));
    reply(res, { items: page === 1 ? [a] : page === 2 ? [{ ...a, note: 'Changed while reading' }, b] : [], total: 2 });
  }, { pageSize: 1 });
  await assert.rejects(client.list(), /Cannot verify complete accounts pagination|repeated ID had conflicting data/);
});

test('failed pagination does not trigger any write requests', async t => {
  const methods = [];
  const client = await transport(t, (req, res) => {
    methods.push(req.method);
    reply(res, { items: [account()], total: 9 });
  });
  await assert.rejects(client.list(), /Read-only scan aborted/);
  assert.ok(methods.length > 1);
  assert.ok(methods.every(method => method === 'GET'));
});
