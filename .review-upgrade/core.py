from pathlib import Path
r=Path('.');p=r/'src/crm.js';s=p.read_text();a=s.index('export function record(');b=s.index('/** GETs may retry;',a)
s=s[:a]+'''/** Normalize primary keys at the API boundary. No facility-specific IDs.
 * account_id is an account key, but only a foreign key on a contact.
 * Explicit custom mappings remain strict; ambiguous aliases are rejected.
 */
export function identify(item, resource = 'accounts', idField = 'id', context = '') {
  const keys = idField === 'id' ? ['id', resource === 'contacts' ? 'contact_id' : 'account_id'] : [idField];
  const present = keys.filter(key => Object.hasOwn(item || {}, key));
  if (!item || Array.isArray(item) || typeof item !== 'object' || !present.length ||
      present.some(key => typeof item[key] !== 'string' || !item[key].trim())) {
    const available = Object.keys(item || {}).filter(key => !/token|secret|password|authorization/i.test(key)).sort().join(', ');
    throw new ApiError(`${context}missing string ID field '${idField}' (accepted: ${keys.join(', ')}). ` +
      `Available field names: ${available || '(none)'}. No proposals published.`);
  }
  if (new Set(present.map(key => item[key])).size !== 1) throw new ApiError(`${context}conflicting primary ID aliases; no proposals published.`);
  return { ...item, [idField]: item[present[0]] };
}

export function record(payload, idField = 'id', resource = 'accounts') {
  const wireKey = resource === 'contacts' ? 'contact_id' : 'account_id';
  for (const item of [payload, payload?.data, payload?.account, payload?.item, payload?.contact]) {
    if (item && typeof item === 'object' && !Array.isArray(item) &&
        (Object.hasOwn(item, idField) || (idField === 'id' && Object.hasOwn(item, wireKey)))) {
      return identify(item, resource, idField);
    }
  }
  throw new ApiError('API did not return an identifiable record. Verify any write by reading it back.');
}

'''+s[b:]
a=s.index('  /**\n   * The API documents');b=s.index('  async collectPages(',a)
s=s[:a]+'''  /** Use the documented pagination contract; do not guess alternative page sizes. */
  async list(resource = 'accounts', query = {}) {
    if (!['accounts', 'contacts'].includes(resource)) throw new Error('Only account/contact collections can be listed.');
    try {
      const result = await this.collectPages(resource, query, this.config.pageSize);
      if (result.overlaps) {
        const verified = await this.collectPages(resource, query, this.config.pageSize);
        if (stable(result.rows) !== stable(verified.rows) || result.total !== verified.total) {
          throw new PaginationError(`${resource}: snapshots differ on overlap verification.`);
        }
      }
      return result.rows;
    } catch (error) {
      if (!(error instanceof PaginationError)) throw error;
      throw new ApiError(`Cannot verify complete ${resource} pagination. Read-only scan aborted; no proposals published. ${error.message}`);
    }
  }

'''+s[b:]
a=s.index('      for (const [index, item] of items.entries()) {');b=s.index('        if (idsOnPage.has(id)) {',a)
s=s[:a]+'''      for (const [index, raw] of items.entries()) {
        const item = identify(raw, resource, idField, `CRM ${resource} page ${page}, item ${index + 1}: `);
        const id = item[idField];
'''+s[b:]
s=s.replace('/** Only completeness/pagination failures can trigger a read-only retry with a different page size. */','/** Distinguish incomplete snapshots from authentication and schema errors. */')
a=s.index('  async get(id) {');s=s[:a]+'''  async readRecord(method, resource, { id, body } = {}) {
    const idField = resource === 'contacts' ? this.config.contactFields.id : this.config.fields.id;
    const row = record(await this.request(method, resource, { id, body }), idField, resource);
    if (id && row[idField] !== id) throw new ApiError(`${resource}: response ID differs from the requested record; stop and verify.`);
    return row;
  }
  async get(id) { return this.readRecord('GET', 'accounts', { id }); }
  async create(body) { return this.readRecord('POST', 'accounts', { body }); }
  async patch(id, body) { return this.readRecord('PATCH', 'accounts', { id, body }); }
  async getContact(id) { return this.readRecord('GET', 'contacts', { id }); }
  async createContact(body) { return this.readRecord('POST', 'contacts', { body }); }
  async patchContact(id, body) { return this.readRecord('PATCH', 'contacts', { id, body }); }
}
''';p.write_text(s)
p=r/'test/crm.test.js';s=p.read_text().replace("  const rows = await client.list();\n  assert.deepEqual(rows.map(r => r.id), ['acc-a', 'acc-b', 'acc-c']);\n  assert.equal(smallCalls, 3);\n  assert.equal(largeCalls, 2, 'fallback snapshot must be read twice');", "  await assert.rejects(client.list(), /pagination stopped advancing/);\n  assert.equal(smallCalls, 3);\n  assert.equal(largeCalls, 0, 'no speculative requests');").replace('recover from repeated pages by using a different page_size, with confirmation','repeated pages stop without guessing page_size');p.write_text(s)
