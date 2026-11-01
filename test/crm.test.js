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
  await assert.rejects(client.list(), /duplicate/);
});
test('a premature end is not interpreted as a complete CRM snapshot', async t => {
  let calls = 0;
  const client = await transport(t, (req, res) => reply(res, { items: ++calls === 1 ? [account()] : [], total: 3 }));
  await assert.rejects(client.list(), /ended early/);
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
