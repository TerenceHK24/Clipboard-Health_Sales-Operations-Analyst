import test from 'node:test';
import assert from 'node:assert/strict';
import { communityLink, parseCommunity, parseCompany, discoverLocations, scrapeSnapshot, createCsv, fetchHtml } from '../src/scraper.js';
import { makeConfig } from '../src/config.js';
const origin = 'https://example.test';
const config = makeConfig({ siteUrl: origin, delayMs: 0 });
const footer = '<footer>© 2026 Example Senior Living. All rights reserved. · Corporate Office: 80 Corporate Road, Sampleton, OH</footer>';
const detail = `<main><h1>Example Residence</h1><dl><dt>Care Offerings</dt><dd><span class="badge">Assisted Living</span><span class="badge">Memory Support</span></dd>
<dt>Address</dt><dd>18 Oak St<br>Sampleton, OH 01234</dd><dt>Phone</dt><dd>(555) 555-0100</dd><dt>Administrator</dt><dd>Sample Administrator</dd></dl></main>${footer}`;

test('labels can be reordered and multiple offerings are preserved', () => {
  const row = parseCommunity(detail, `${origin}/communities/one`, config);
  assert.equal(row.name, 'Example Residence'); assert.equal(row.address, '18 Oak St');
  assert.equal(row.city, 'Sampleton'); assert.equal(row.state, 'OH'); assert.equal(row.zip, '01234');
  assert.equal(row.care_offerings, 'Assisted Living | Memory Support');
  assert.equal(row.administrator, 'Sample Administrator');
});
test('corporate identity and address are read from footer, without inventing ZIP', () => {
  const row = parseCompany(footer, origin + '/about', config);
  assert.equal(row.name, 'Example Senior Living'); assert.equal(row.address, '80 Corporate Road');
  assert.equal(row.city, 'Sampleton'); assert.equal(row.state, 'OH'); assert.equal(row.zip, null);
  assert.equal(row.record_type, 'company');
});
test('a changed company and footer address are parsed dynamically', () => {
  const html = '<footer>© 2027 Completely Different Care. All rights reserved. · Corporate Office: 77 Maple Avenue, New Town, IN 01234-5678</footer>';
  const row = parseCompany(html, origin, config);
  assert.equal(row.name, 'Completely Different Care'); assert.equal(row.address, '77 Maple Avenue');
  assert.equal(row.zip, '01234-5678'); assert.equal(row.city, 'New Town');
});
test('same-origin pagination is followed while CRM and external URLs are excluded', () => {
  assert.equal(communityLink('/crm/private/accounts/x', origin, origin), null);
  assert.equal(communityLink('https://elsewhere.test/communities/x', origin, origin), null);
  assert.deepEqual(communityLink('/communities?page=2', origin, origin), { type: 'directory', url: origin + '/communities?page=2' });
  assert.deepEqual(communityLink('/communities?page=1', origin, origin), { type: 'directory', url: origin + '/communities' });
  assert.deepEqual(communityLink('/communities/one/#fragment', origin, origin), { type: 'detail', url: origin + '/communities/one' });
});
test('directory plus homepage discovers a newly linked facility without a fixed total', async () => {
  const pages = new Map([
    [origin + '/', `<p>We serve 3 communities.</p><a href="/communities/new">New</a>${footer}`],
    [origin + '/about', footer],
    [origin + '/communities', `<p>Page 1 of 2 · 2 communities listed</p><a href="/communities/one">One</a><a href="?page=2">Next</a>${footer}`],
    [origin + '/communities?page=2', `<p>Page 2 of 2 · 2 communities listed</p><a href="/communities/two">Two</a><a href="/communities">Previous</a>${footer}`],
    ...['new', 'one', 'two'].map(slug => [origin + '/communities/' + slug, detail.replace('Example Residence', slug)]),
  ]);
  const site = await scrapeSnapshot(config, async url => { if (!pages.has(url)) throw Error(url); return pages.get(url); });
  assert.equal(site.locations.length, 3); assert.equal(site.company.source_url, origin + '/about');
  assert.equal(site.complete, true); assert.equal(site.coverage.directoryPages, 2);
});
test('broken pagination fails before producing a misleading complete snapshot', async () => {
  await assert.rejects(discoverLocations({ baseUrl: origin, delayMs: 0,
    fetchPage: async url => url.endsWith('/communities') ? 'Page 1 of 2 · 1 communities listed <a href="/communities/one">One</a>' : '' }), /pagination is incomplete/);
});
test('a shortfall against advertised counts is not ignored', async () => {
  await assert.rejects(discoverLocations({ baseUrl: origin, delayMs: 0,
    fetchPage: async () => '3 communities listed <a href="/communities/one">One</a>' }), /directory lists 3/);
});
test('conflicting directory counts fail closed', async () => {
  const pages = new Map([[origin + '/', ''], [origin + '/communities', '1 communities listed <a href="?page=2">Next</a><a href="/communities/one">One</a>'],
    [origin + '/communities?page=2', '2 communities listed']]);
  await assert.rejects(discoverLocations({ baseUrl: origin, delayMs: 0, fetchPage: async url => pages.get(url) }), /totals changed/);
});
test('missing required public fields are errors, not blank records', () => {
  assert.throws(() => parseCommunity('<h1>Example</h1>', origin), /Missing address/);
  assert.throws(() => parseCompany('<footer>Nothing here</footer>', origin), /not found/);
});
test('CSV escaping, Unicode and formula neutralization are explicit', () => {
  const csv = createCsv([{ name: 'Étoile "North", Ltd.', address: 'One\nTwo', phone: '=HYPERLINK("bad")' }]);
  assert.ok(csv.startsWith('\uFEFF')); assert.match(csv, /"Étoile ""North"", Ltd\."/);
  assert.match(csv, /'=HYPERLINK/);
});
test('public fetch retries 429 but not permanent 404', async () => {
  let calls = 0;
  const html = await fetchHtml(origin, { sleep: async () => {}, fetchImpl: async () => ++calls === 1
    ? { ok: false, status: 429, headers: { get: () => null } } : { ok: true, text: async () => 'ok' } });
  assert.equal(html, 'ok'); assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(fetchHtml(origin, { sleep: async () => {}, fetchImpl: async () => { calls++; return { ok: false, status: 404 }; } }), /HTTP 404/);
  assert.equal(calls, 1);
});
