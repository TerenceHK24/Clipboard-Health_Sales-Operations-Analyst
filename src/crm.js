import { setTimeout as pause } from 'node:timers/promises';
import { stable } from './config.js';

export class ApiError extends Error {
  constructor(message, status = 0) { super(message); this.name = 'ApiError'; this.status = status; }
}

/** Only completeness/pagination failures can trigger a read-only retry with a different page size. */
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
export function record(payload, idField = 'id') {
  for (const item of [payload, payload?.data, payload?.account, payload?.item, payload?.contact]) {
    if (item && typeof item === 'object' && !Array.isArray(item) && typeof item[idField] === 'string' && item[idField]) return item;
  }
  throw new ApiError('API did not return an identifiable record. Write outcome may need read-back verification.');
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
  /**
   * The API documents page/page_size but not its ordering or response shape.
   * Some backends overlap adjacent pages. We may collapse the same unchanged
   * record ID ONLY when an advertised total proves the unique count complete,
   * and an independent second read gives exactly the same records.
   * Otherwise we retry with a different page size or abort without publishing.
   */
  async list(resource = 'accounts', query = {}) {
    if (!['accounts', 'contacts'].includes(resource)) throw new Error('Only account/contact collections can be listed.');
    const initial = this.config.pageSize;
    const sizes = [...new Set([
      initial,
      Math.min(1000, initial * 2),
      Math.max(1, Math.floor(initial / 2)),
      Math.max(1, Math.floor(initial / 5)),
    ])];
    const issues = [];
    for (const [attempt, pageSize] of sizes.entries()) {
      try {
        const result = await this.collectPages(resource, query, pageSize);
        if (attempt || result.overlaps) {
          // Confirm that the candidate snapshot is stable before using it for proposals.
          // A repeat read uses only GET; there are no implicit account/contact writes.
          const verified = await this.collectPages(resource, query, pageSize);
          if (stable(result.rows) !== stable(verified.rows) || result.total !== verified.total) {
            throw new PaginationError(`${resource}: snapshots differ on verification with page_size=${pageSize}.`);
          }
          console.warn(`CRM ${resource}: complete snapshot verified using page_size=${pageSize}` +
            (result.overlaps ? ` (${result.overlaps} overlapping page entries deduplicated).` : '.'));
        }
        return result.rows;
      } catch (error) {
        if (!(error instanceof PaginationError)) {
          // Invalid IDs, invalid response schema and HTTP errors need attention;
          // changing pagination settings cannot make malformed records safe.
          if (attempt && error instanceof ApiError && error.status === 422) {
            issues.push(`page_size=${pageSize}: not supported by API (HTTP 422)`);
            continue;
          }
          throw error;
        }
        issues.push(`page_size=${pageSize}: ${error.message}`);
      }
    }
    throw new ApiError(`Cannot verify complete ${resource} pagination. Read-only scan aborted; no proposals published. ` +
      `Attempts: ${issues.join(' | ')}. Check the API's page/page_size behavior and consider a different configured pageSize.`);
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
      for (const [index, item] of items.entries()) {
        const id = item?.[idField];
        if (typeof id !== 'string' || !id.trim()) {
          const keys = item && typeof item === 'object' && !Array.isArray(item)
            ? Object.keys(item).filter(key => !/token|secret|password|authorization/i.test(key)).sort().join(', ')
            : '(not a record object)';
          throw new ApiError(`CRM ${resource} page ${page}, item ${index + 1}: missing string ID field '${idField}'. ` +
            `Available field names: ${keys || '(none)'}. Set the correct field mapping in --config; no proposals published.`);
        }
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
  async get(id) { return record(await this.request('GET', 'accounts', { id }), this.config.fields.id); }
  async create(body) { return record(await this.request('POST', 'accounts', { body }), this.config.fields.id); }
  async patch(id, body) { return record(await this.request('PATCH', 'accounts', { id, body }), this.config.fields.id); }
  async getContact(id) { return record(await this.request('GET', 'contacts', { id }), this.config.contactFields.id); }
  async createContact(body) { return record(await this.request('POST', 'contacts', { body }), this.config.contactFields.id); }
  async patchContact(id, body) { return record(await this.request('PATCH', 'contacts', { id, body }), this.config.contactFields.id); }
}
