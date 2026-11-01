import { setTimeout as pause } from 'node:timers/promises';
import { stable } from './config.js';

export class ApiError extends Error {
  constructor(message, status = 0) { super(message); this.name = 'ApiError'; this.status = status; }
}

/** Distinguish incomplete snapshots from authentication and schema errors. */
class PaginationError extends ApiError {}

export function collection(payload, resource) {
  if (Array.isArray(payload)) return { items: payload, total: null };
  const items = [payload?.items, payload?.data, payload?.results, payload?.[resource], payload?.data?.items]
    .find(Array.isArray);
  if (!items) throw new ApiError(`Unrecognized ${resource} response. Expected an array, or an items/data/results/${resource} array.`);
  const total = payload.total ?? payload.total_count ?? payload.pagination?.total ?? payload.meta?.total ?? null;
  if (total !== null && (!Number.isSafeInteger(total) || total < 0)) throw new ApiError('Invalid API pagination total.');
  return { items, total };
}
/** Normalize primary keys at the API boundary. No facility-specific IDs.
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

/** GETs may retry; POST/PATCH never retry automatically. Credentials never follow redirects. */
export class CrmClient {
  constructor(config, token, fetchImpl = fetch) {
    if (!token || /[\r\n]/.test(token)) throw new Error('A nonempty, single-line CRM bearer token is required.');
    this.config = config;
    this.token = token;
    this.fetch = fetchImpl;
  }
  async request(method, resource, { id, query = {}, body } = {}) {
    if (!['accounts', 'contacts', 'me'].includes(resource)) throw new Error('Unsupported CRM resource.');
    const url = new URL(resource + (id ? `/${encodeURIComponent(id)}` : ''), this.config.apiUrl);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await this.fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(this.config.timeoutMs),
          headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}) });
      } catch {
        if (method === 'GET' && attempt < 3) { await pause(300 * 2 ** attempt); continue; }
        throw new ApiError(`${method} ${resource} failed or timed out. ${method === 'GET' ? 'No CRM write attempted.' : 'The outcome is uncertain; do not blindly repeat the write.'}`);
      }
      if (!response.ok) {
        if (method === 'GET' && [429, 500, 502, 503, 504].includes(response.status) && attempt < 3) {
          const retry = response.headers.get('retry-after');
          const ms = retry && /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
          await pause(Math.min(Number.isFinite(ms) && ms > 0 ? ms : 300 * 2 ** attempt, 30000));
          continue;
        }
        // Do not echo server bodies, which can contain credentials or private data.
        throw new ApiError(`${method} ${resource} returned HTTP ${response.status}.`, response.status);
      }
      try { return await response.json(); }
      catch { throw new ApiError(`${method} ${resource} returned invalid JSON; verify any write by reading it back.`); }
    }
  }
  /** Use the documented pagination contract; do not guess alternative page sizes. */
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

  async collectPages(resource, query, pageSize) {
    const idField = resource === 'accounts' ? this.config.fields.id : this.config.contactFields.id;
    const rows = new Map();
    let totalExpected = null, overlaps = 0, stalledPages = 0;
    for (let page = 1; page <= this.config.maxPages; page++) {
      const { items, total } = collection(await this.request('GET', resource,
        { query: { ...query, page, page_size: pageSize } }), resource);
      if (total !== null) {
        if (totalExpected !== null && totalExpected !== total) {
          throw new PaginationError(`${resource}: reported total changed between pages (${totalExpected} -> ${total})`);
        }
        totalExpected = total;
      }
      const idsOnPage = new Set();
      let fresh = 0;
      for (const [index, raw] of items.entries()) {
        const item = identify(raw, resource, idField, `CRM ${resource} page ${page}, item ${index + 1}: `);
        const id = item[idField];
        if (idsOnPage.has(id)) {
          throw new ApiError(`CRM ${resource} page ${page} contains the same ID twice within one response. ` +
            `This is not a normal page-boundary overlap; refusing an incomplete snapshot.`);
        }
        idsOnPage.add(id);
        if (rows.has(id)) {
          if (stable(rows.get(id)) !== stable(item)) {
            throw new PaginationError(`${resource}: a repeated ID had conflicting data on page ${page}; CRM changed during scan`);
          }
          overlaps++;
        } else {
          rows.set(id, item);
          fresh++;
        }
      }
      if (totalExpected !== null) {
        if (rows.size > totalExpected) throw new PaginationError(`${resource}: ${rows.size} unique IDs exceed reported total ${totalExpected}`);
        if (rows.size === totalExpected) {
          // Page overlap is only tolerable when we can prove coverage and verify stability.
          return { rows: [...rows.values()].sort((a, b) => a[idField].localeCompare(b[idField])), total: totalExpected, overlaps };
        }
      }
      if (items.length === 0) {
        if (totalExpected !== null && rows.size !== totalExpected) {
          throw new PaginationError(`${resource}: directory ended after ${rows.size}/${totalExpected} unique IDs on page ${page}`);
        }
        if (overlaps && totalExpected === null) {
          throw new PaginationError(`${resource}: overlapping pages but API did not report a total; cannot prove completeness`);
        }
        return { rows: [...rows.values()].sort((a, b) => a[idField].localeCompare(b[idField])), total: totalExpected, overlaps };
      }
      stalledPages = fresh ? 0 : stalledPages + 1;
      if (stalledPages >= 2) {
        throw new PaginationError(`${resource}: pagination stopped advancing on page ${page} ` +
          `(${rows.size} unique IDs${totalExpected === null ? '' : ` / ${totalExpected} reported`}); ` +
          `the server may be repeating pages or ordering records unstably`);
      }
    }
    throw new PaginationError(`${resource}: page limit ${this.config.maxPages} reached ` +
      `(${rows.size} unique IDs${totalExpected === null ? '' : ` / ${totalExpected} reported`})`);
  }
  async readRecord(method, resource, { id, body } = {}) {
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
