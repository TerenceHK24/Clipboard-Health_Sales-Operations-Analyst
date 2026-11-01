import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandbox, TOKEN } from '../fixtures/http.js';
import { scrapeSnapshot, createCsv } from '../src/scraper.js';
import { CrmClient } from '../src/crm.js';
import { Store } from '../src/store.js';
import { ReviewService } from '../src/service.js';
import { startReviewServer } from '../src/review-server.js';
test('full HTTP website -> scraper -> REST -> review -> approved writeback -> rerun', async t => {
  const api = await sandbox(), dir = await mkdtemp(join(tmpdir(), 'pipeline-'));
  const store = new Store(dir, 'pipeline');
  const service = new ReviewService({ config: api.config, client: new CrmClient(api.config, TOKEN), store, readWebsite: () => scrapeSnapshot(api.config) });
  const app = await startReviewServer(service, { port: 0, fields: api.config.fields });
  t.after(async () => { await app.close(); store.close(); await api.close(); await rm(dir, { recursive: true, force: true }); });
  const request = async (path, body) => {
    const res = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { 'X-Review-Key': app.key,
      ...(body ? { Origin: app.origin, 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await res.json(); assert.equal(res.status, 200, JSON.stringify(data)); return data;
  };
  assert.ok((await request('/api/scan', {})).pending >= 5); assert.equal(api.writes.length, 0);
  const view = await request('/api/state');
  assert.equal(view.latest.summary.facilities, 4); assert.equal(view.latest.summary.accounts, 6); assert.equal(view.latest.coverage.directoryPages, 2);
  assert.equal(view.latest.company.name, 'Example Senior Living'); assert.equal(view.latest.company.zip, null);
  assert.ok(view.latest.matches.some(m => m.careEquivalent)); assert.ok(view.latest.matches.some(m => m.websiteAdministrator === 'Ada Example'));
  const item = view.proposals.find(p => p.kind === 'update'), admin = view.proposals.find(p => p.kind === 'admin_contact');
  await request(`/api/proposals/${item.id}/decision`, { decision: 'approve', revision: item.revision, reviewer: 'QA' });
  await request(`/api/proposals/${admin.id}/decision`, { decision: 'reject', revision: admin.revision, reviewer: 'QA' });
  await request('/api/scan', {}); const after = await request('/api/state');
  assert.equal(after.proposals.find(p => p.id === item.id).status, 'applied'); assert.equal(after.proposals.find(p => p.id === admin.id).status, 'rejected');
  assert.equal(api.writes.length, 1); assert.equal(api.accounts.get('facility-1').name, 'Example Residence');
  const csv = createCsv([store.latest().snapshot.website.company, ...store.latest().snapshot.website.locations]);
  assert.ok(csv.includes('company,Example Senior Living')); assert.ok(csv.includes('Facility New'));
  assert.ok(!JSON.stringify(after).includes(TOKEN));
});
