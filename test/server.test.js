import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { startReviewServer } from '../src/review-server.js';

async function start(t) {
  const calls = { scans: 0, decisions: [], groups: [], links: [] };
  const service = { view: () => ({ proposals: [], audit: [], latest: null }),
    scan: async () => { calls.scans++; return { pending: 1 }; },
    decide: async (id, data) => { calls.decisions.push({ id, data }); return { status: data.decision === 'reject' ? 'rejected' : 'applied' }; },
    decideGroup: async input => { calls.groups.push(input); return { applied:input.members.length, blocked:0 }; },
    manualMatch: async input => { calls.links.push(input); return { linked:true }; } }; 
  const app = await startReviewServer(service, { port: 0 });
  t.after(() => app.close());
  const headers = { 'X-Review-Key': app.key, Origin: app.origin, 'Content-Type': 'application/json' };
  return { ...app, calls, headers };
}
test('local API requires an ephemeral review key', async t => {
  const app = await start(t);
  assert.equal((await fetch(app.origin + '/api/state')).status, 401);
  const authorized = await fetch(app.origin + '/api/state', { headers: app.headers });
  assert.equal(authorized.status, 200);
  assert.equal((await authorized.text()).includes(app.key), false);
});
test('reading the UI or state never invokes decisions or scans', async t => {
  const app = await start(t);
  const page = await fetch(app.origin + '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  await fetch(app.origin + '/api/state', { headers: app.headers });
  assert.equal(app.calls.scans, 0); assert.equal(app.calls.decisions.length, 0);
});
test('cross-origin and missing-Origin POSTs cannot scan or approve', async t => {
  const app = await start(t);
  for (const origin of ['https://untrusted.example', null]) {
    const headers = { ...app.headers }; if (origin) headers.Origin = origin; else delete headers.Origin;
    const response = await fetch(app.origin + '/api/scan', { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 403);
  }
  assert.equal(app.calls.scans, 0);
});
test('an authenticated scan still cannot invoke the decision path', async t => {
  const app = await start(t);
  assert.equal((await fetch(app.origin + '/api/scan', { method: 'POST', headers: app.headers, body: '{}' })).status, 200);
  assert.equal(app.calls.scans, 1); assert.equal(app.calls.decisions.length, 0);
});
test('decision endpoint accepts only decision metadata, never arbitrary patches', async t => {
  const app = await start(t), id = 'a'.repeat(64);
  const response = await fetch(app.origin + `/api/proposals/${id}/decision`, { method: 'POST', headers: app.headers,
    body: JSON.stringify({ decision: 'approve', revision: 'reviewed', reviewer: 'Test', body: { lifetime_revenue: 999 }, token: 'do-not-forward' }) });
  assert.equal(response.status, 200);
  assert.deepEqual(app.calls.decisions[0].data, { decision: 'approve', revision: 'reviewed', reviewer: 'Test', note: undefined });
});
test('unexpected Host header is blocked against DNS rebinding', async t => {
  const app = await start(t);
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(app.origin + '/api/state', { headers: { ...app.headers, Host: 'untrusted.example' } }, response => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 403);
});
test('oversized and non-JSON request bodies cannot invoke a decision', async t => {
  const app = await start(t), id = 'a'.repeat(64);
  const response = await fetch(app.origin + `/api/proposals/${id}/decision`, { method: 'POST', headers: app.headers, body: JSON.stringify({ note: 'x'.repeat(140000) }) });
  assert.equal(response.status, 409);
  const text = await fetch(app.origin + '/api/scan', { method: 'POST', headers: { ...app.headers, 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(text.status, 409); assert.equal(app.calls.decisions.length, 0);
});

test('one authorized group approval only accepts decision metadata, never arbitrary patch payloads', async t => {
  const app=await start(t);const members=[{id:'a'.repeat(64),revision:'r1'},{id:'b'.repeat(64),revision:'r2'}];
  const response=await fetch(app.origin+'/api/groups/decision',{method:'POST',headers:app.headers,
    body:JSON.stringify({groupKey:'update:name',members,decision:'approve',reviewer:'Tester',body:{outstanding_ar:0},token:'ignored'})});
  assert.equal(response.status,200);
  assert.deepEqual(app.calls.groups[0],{groupKey:'update:name',members,decision:'approve',reviewer:'Tester',note:undefined});
  assert.equal(app.calls.decisions.length,0);
});
test('manual matching is a separate authenticated decision and does not call a CRM write',async t=>{
  const app=await start(t);
  const response=await fetch(app.origin+'/api/manual-match',{method:'POST',headers:app.headers,
    body:JSON.stringify({action:'link',siteUrl:'https://example.test/communities/test',accountId:'account-a',reviewer:'Tester',parent_id:'attack',extra:'ignored'})});
  assert.equal(response.status,200);
  assert.deepEqual(app.calls.links[0],{action:'link',siteUrl:'https://example.test/communities/test',accountId:'account-a',reviewer:'Tester'});
  assert.equal(app.calls.decisions.length,0);
});
