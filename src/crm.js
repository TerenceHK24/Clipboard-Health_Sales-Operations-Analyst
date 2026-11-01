import { setTimeout as pause } from 'node:timers/promises';

export class ApiError extends Error {
  constructor(message, status = 0) { super(message); this.name = 'ApiError'; this.status = status; }
}

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
    if (!token || /[\r\n]/.test(token)) throw new Error('Set a valid CRM_TOKEN environment variable.');
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
  async list(resource = 'accounts', query = {}) {
    const rows = [], seen = new Set();
    const idField = resource === 'accounts' ? this.config.fields.id : 'id';
    let expected = null;
    for (let page = 1; page <= this.config.maxPages; page++) {
      const { items, total } = collection(await this.request('GET', resource,
        { query: { ...query, page, page_size: this.config.pageSize } }), resource);
      if (total !== null) {
        if (expected !== null && expected !== total) throw new ApiError('CRM changed during pagination; scan again.');
        expected = total;
      }
      for (const item of items) {
        if (!item || typeof item[idField] !== 'string' || !item[idField] || seen.has(item[idField])) {
          throw new ApiError(`Missing/duplicate ${resource} IDs across pages. Refusing an incomplete snapshot.`);
        }
        seen.add(item[idField]); rows.push(item);
      }
      if (expected !== null && rows.length >= expected) {
        if (rows.length !== expected) throw new ApiError('CRM pagination count mismatch.');
        return rows;
      }
      if (!items.length) {
        if (expected !== null && rows.length !== expected) throw new ApiError('CRM pagination ended early.');
        return rows;
      }
      // Do not stop at a short page: the server may cap page_size below our request.
    }
    throw new ApiError('CRM pagination limit reached; no complete snapshot produced.');
  }
  async get(id) { return record(await this.request('GET', 'accounts', { id }), this.config.fields.id); }
  async create(body) { return record(await this.request('POST', 'accounts', { body }), this.config.fields.id); }
  async patch(id, body) { return record(await this.request('PATCH', 'accounts', { id, body }), this.config.fields.id); }
  async getContact(id) { return record(await this.request('GET', 'contacts', { id }), this.config.contactFields.id); }
  async createContact(body) { return record(await this.request('POST', 'contacts', { body }), this.config.contactFields.id); }
  async patchContact(id, body) { return record(await this.request('PATCH', 'contacts', { id, body }), this.config.contactFields.id); }
}
