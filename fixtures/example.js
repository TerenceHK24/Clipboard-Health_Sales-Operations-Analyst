import { makeConfig } from '../src/config.js';
export const config = makeConfig({ siteUrl: 'https://example.test', apiUrl: 'https://example.test/api/v1/', delayMs: 0 });
export const clone = value => structuredClone(value);
export function account(overrides = {}) {
  return { id: 'facility-1', name: 'Example Residence', parent_id: 'parent-1', billing_street: '18 Oak St',
    billing_city: 'Sampleton', billing_state: 'OH', billing_zip: '01234', phone: '(555) 555-0100', care_type: 'Assisted Living',
    status: 'Active', note: null, lifetime_revenue: 0, outstanding_ar: 0, duplicate_of_account: null, chow_current_account: null, ...overrides };
}
export function website() {
  return { complete: true, coverage: { directoryCount: 1, discovered: 1 }, fetchedAt: '2026-01-01T00:00:00Z',
    company: { record_type: 'company', name: 'Example Senior Living', address: '80 Corporate Road', city: 'Sampleton',
      state: 'OH', zip: null, phone: '', care_offerings: '', administrator: '', source_url: `${config.siteUrl}/about` },
    locations: [{ record_type: 'facility', name: 'Example Residence', address: '18 Oak St', city: 'Sampleton', state: 'OH',
      zip: '01234', care_offerings: 'Assisted Living', administrator: '', phone: '(555) 555-0100',
      source_url: `${config.siteUrl}/communities/example-residence` }] };
}
export function parent(overrides = {}) {
  return account({ id: 'parent-1', name: 'Example Senior Living (Parent Account)', parent_id: null,
    billing_street: '80 Corporate Road', billing_zip: '99999', phone: '', care_type: '', ...overrides });
}
export const snapshot = (accounts = [parent(), account()], site = website()) => ({ accounts, website: site, contacts: [] });

export class MockClient {
  constructor(rows) { this.rows = new Map(rows.map(row => [row.id, clone(row)])); this.writes = []; this.sequence = 0; }
  async list(resource = 'accounts') { return resource === 'contacts' ? [] : clone([...this.rows.values()]); }
  async get(id) { if (!this.rows.has(id)) throw new Error('Not found'); return clone(this.rows.get(id)); }
  async create(body) {
    this.writes.push({ method: 'POST', body: clone(body) });
    if (this.failBeforeCreate) throw new Error('Network outcome unknown');
    const row = account({ id: `created-${++this.sequence}`, parent_id: null, billing_street: '', billing_city: '',
      billing_state: '', billing_zip: '', phone: '', care_type: '', ...clone(body) });
    this.rows.set(row.id, row);
    if (this.failAfterCreate) { this.failAfterCreate = false; throw new Error('Response lost after create'); }
    return clone(row);
  }
  async patch(id, body) {
    this.writes.push({ method: 'PATCH', id, body: clone(body) });
    if (this.failBeforePatch) { this.failBeforePatch = false; throw new Error('Patch not delivered'); }
    Object.assign(this.rows.get(id), clone(body));
    if (this.failAfterPatch) { this.failAfterPatch = false; throw new Error('Response lost after patch'); }
    return this.get(id);
  }
}
