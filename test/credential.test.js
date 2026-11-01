import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { promptForCrmToken } from '../src/credential.js';
import { loadConfig, hash } from '../src/config.js';
import { Store } from '../src/store.js';

test('hidden terminal entry returns token in memory without echoing token', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  const output = new PassThrough();
  output.isTTY = true;
  let shown = '';
  output.on('data', chunk => { shown += String(chunk); });
  const promise = promptForCrmToken({ input, output });
  input.write('sample-secret-token\n');
  assert.equal(await promise, 'sample-secret-token');
  assert.match(shown, /Enter CRM bearer token \(input hidden\)/);
  assert.doesNotMatch(shown, /sample-secret-token/);
});

test('interactive credentials are required; piped and unattended input fail closed', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  await assert.rejects(promptForCrmToken({ input, output }), /interactive terminal/);
});

test('empty or whitespace-containing token is refused', async () => {
  for (const candidate of ['', 'invalid token']) {
    const input = new PassThrough();
    input.isTTY = true;
    input.setRawMode = () => input;
    const output = new PassThrough();
    output.isTTY = true;
    const result = promptForCrmToken({ input, output });
    input.write(candidate + '\n');
    await assert.rejects(result, /nonempty.*whitespace/);
  }
});

test('configuration never reads CRM_TOKEN and journal scope ignores token rotation', async () => {
  const a = await loadConfig(null, {}, { CRM_TOKEN: 'one-secret' });
  const b = await loadConfig(null, {}, { CRM_TOKEN: 'another-secret' });
  assert.deepEqual(a, b);
  assert.ok(!('token' in a));
  assert.ok(!JSON.stringify(a).includes('secret'));
  const dir = mkdtempSync(join(tmpdir(), 'bellhaven-credential-test-'));
  try {
    const store = new Store(dir, a.scope);
    store.decision('test-item', 'reject', 'reviewer', 'preserve');
    store.close();
    const reopened = new Store(dir, b.scope);
    assert.equal(reopened.audit().length, 1);
    reopened.close();
    assert.ok(!readFileSync(join(dir, 'review.sqlite')).includes(Buffer.from('one-secret')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an old token-based journal can be migrated once without recording token', async () => {
  const config = (await loadConfig()).config;
  const newScope = (await loadConfig()).scope;
  const oldToken = 'sample-legacy-token';
  const legacyScope = hash(`${config.apiUrl}\n${config.siteUrl}\n${oldToken}`);
  const dir = mkdtempSync(join(tmpdir(), 'bellhaven-legacy-test-'));
  try {
    const before = new Store(dir, legacyScope);
    before.decision('original', 'reject', 'reviewer');
    before.close();
    const migrated = new Store(dir, newScope, { legacyScope });
    assert.equal(migrated.audit().length, 1);
    migrated.close();
    const after = new Store(dir, newScope);
    assert.equal(after.audit().length, 1);
    after.close();
    assert.ok(!readFileSync(join(dir, 'review.sqlite')).includes(Buffer.from(oldToken)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('old --env-file flag is rejected and help explains hidden prompt', () => {
  // URL.pathname is not a Windows filename and leaves escaped spaces encoded.
  const cli = fileURLToPath(new URL('../bin/bellhaven-scrape.js', import.meta.url));
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr || String(help.error || 'CLI help failed'));
  assert.match(help.stdout, /hidden input/);
  assert.doesNotMatch(help.stdout, /--env-file|CRM_TOKEN/);
  const legacy = spawnSync(process.execPath, [cli, 'scan', '--env-file', 'secrets.env'], { encoding: 'utf8' });
  assert.notEqual(legacy.status, 0);
  assert.match(legacy.stderr, /Unknown option|not found|env-file/);
});
