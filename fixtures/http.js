/** Synthetic website and CRM contract. No production IDs, tokens or writes. */
import { createServer } from 'node:http';
import { account, parent, website, clone } from './example.js';
import { makeConfig } from '../src/config.js';
export const TOKEN = 'synthetic-contract-token';
const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
export function scenario() {
  const site = website(); site.locations[0].administrator = 'Ada Example';
  for (const [name, street, care] of [['Facility North', '18 North St', 'Memory Support'], ['Facility South', '18 South St', 'Assisted Living'], ['Facility New', '18 New St', 'Assisted Living']]) {
    site.locations.push({ ...clone(site.locations[0]), name, address: street, care_offerings: care, administrator: '', phone: '',
      source_url: `https://example.test/communities/${name.toLowerCase().replaceAll(' ', '-')}` });
  }
  return { website: site, accounts: [parent(), parent({ id: 'other-parent', name: 'Other Operator (Parent Account)' }),
    account({ name: 'Example Residence Old Name' }),
    account({ id: 'north', name: 'Facility North', billing_street: '18 North St', phone: '', care_type: 'Memory Care' }),
    account({ id: 'south', name: 'Facility South', billing_street: '18 South St', phone: '', parent_id: 'other-parent', lifetime_revenue: 300, outstanding_ar: 40 }),
    account({ id: 'absent', name: 'Unlisted Residence', billing_street: '99 Missing Road', billing_city: 'Elsewhere', phone: '' })],
    contacts: [{ id: 'old-admin', account_id: 'facility-1', name: 'Former Person', title: 'Administrator', status: 'Active', email: 'former@example.test', phone: null }] };
}
export async function sandbox(input = scenario()) {
  const data = clone(input), accounts = new Map(data.accounts.map(a => [a.id, a])), contacts = new Map(data.contacts.map(c => [c.id, c]));
  const writes = [], calls = [], flags = { invalidId: false, rejectReads: false }; let sequence = 0;
  const reply = (res, body, status = 200, type = 'application/json') => { res.writeHead(status, { 'Content-Type': type }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
  const wire = (row, resource) => { const { id, ...rest } = clone(row); return { ...rest,
    [resource === 'contacts' ? 'contact_id' : flags.invalidId ? 'unknown_key' : 'account_id']: id,
    ...(resource === 'accounts' ? { parent_name: accounts.get(row.parent_id)?.name || null, updated_at: '2026-01-01T00:00:00Z', created_by_candidate: false } : {}) }; };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local');
      if (!url.pathname.startsWith('/api/')) {
        const company = data.website.company;
        const footer = `<footer>© 2026 ${esc(company.name)}. All rights reserved. · Corporate Office: ${esc(company.address)}, ${esc(company.city)}, ${esc(company.state)}</footer>`;
        let body;
        if (url.pathname === '/') body = `<h1>Home</h1><p>We serve ${data.website.locations.length} communities.</p><a href="/communities">Directory</a><a href="${new URL(data.website.locations.at(-1).source_url).pathname}">New facility</a>`;
        else if (url.pathname === '/about') body = '<h1>About</h1>';
        else if (url.pathname === '/communities') {
          const listed = data.website.locations.slice(0, -1), page = Number(url.searchParams.get('page') || 1), pages = Math.ceil(listed.length / 2);
          body = `<h1>Directory</h1><p>Page ${page} of ${pages} · ${listed.length} communities listed</p>` +
            listed.slice((page - 1) * 2, page * 2).map(row => `<a href="${new URL(row.source_url).pathname}">${esc(row.name)}</a>`).join('') +
            (page < pages ? `<a href="/communities?page=${page + 1}">Next</a>` : '');
        } else {
          const row = data.website.locations.find(item => new URL(item.source_url).pathname === url.pathname);
          if (!row) return reply(res, 'Not found', 404, 'text/plain');
          body = `<h1>${esc(row.name)}</h1><dl><dt>Phone</dt><dd>${esc(row.phone)}</dd><dt>Address</dt><dd>${esc(row.address)}<br>${esc(row.city)}, ${esc(row.state)} ${esc(row.zip)}</dd><dt>Care Offerings</dt><dd><span class="badge">${esc(row.care_offerings)}</span></dd><dt>Administrator</dt><dd>${esc(row.administrator)}</dd></dl>`;
        }
        return reply(res, `<!doctype html><html><body><header><a href="/">${esc(company.name)}</a></header><main>${body}</main>${footer}</body></html>`, 200, 'text/html');
      }
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return reply(res, {}, 401);
      const [, resource, encodedId] = url.pathname.match(/^\/api\/v1\/(accounts|contacts)(?:\/([^/]+))?$/) || [];
      if (!resource) return reply(res, {}, 404);
      const id = encodedId && decodeURIComponent(encodedId), rows = resource === 'contacts' ? contacts : accounts;
      calls.push({ method: req.method, resource, id });
      if (req.method === 'GET') {
        if (flags.rejectReads) return reply(res, {}, 401);
        if (id) return rows.has(id) ? reply(res, wire(rows.get(id), resource)) : reply(res, {}, 404);
        const page = Number(url.searchParams.get('page') || 1), size = Math.min(2, Number(url.searchParams.get('page_size') || 2));
        const items = [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
        return reply(res, { items: items.slice((page - 1) * size, page * size).map(row => wire(row, resource)), total: items.length, page, page_size: size });
      }
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      if ('id' in body || 'contact_id' in body || (resource === 'accounts' && 'account_id' in body)) return reply(res, {}, 422);
      writes.push({ method: req.method, resource, id, body: clone(body) });
      if (req.method === 'POST') {
        const newId = `${resource}-created-${++sequence}`;
        const row = resource === 'accounts' ? account({ id: newId, parent_id: null, name: '', billing_street: '', billing_city: '', billing_state: '', billing_zip: '', phone: '', care_type: '', ...body }) : { id: newId, email: null, phone: null, ...body };
        rows.set(newId, row); return reply(res, wire(row, resource), 201);
      }
      if (req.method === 'PATCH' && rows.has(id)) { Object.assign(rows.get(id), body); return reply(res, wire(rows.get(id), resource)); }
      reply(res, {}, 404);
    } catch (error) { reply(res, { error: error.message }, 500); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  data.website.company.source_url = origin + '/about';
  data.website.locations.forEach(row => { row.source_url = origin + new URL(row.source_url).pathname; });
  return { origin, website: data.website, accounts, contacts, writes, calls, flags,
    config: makeConfig({ siteUrl: origin, apiUrl: `${origin}/api/v1/`, delayMs: 0 }),
    close: () => new Promise(resolve => server.close(resolve)) };
}
