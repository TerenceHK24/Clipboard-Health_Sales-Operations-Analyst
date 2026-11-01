import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const DEFAULT_BASE_URL = 'https://analyst-assessment-production.up.railway.app';
export const DEFAULTS = Object.freeze({
  siteUrl: DEFAULT_BASE_URL,
  apiUrl: `${DEFAULT_BASE_URL}/api/v1/`,
  seedPaths: ['/', '/communities', '/about'],
  directoryPath: '/communities',
  detailPath: '/communities/',
  delayMs: 200,
  timeoutMs: 25000,
  maxPages: 200,
  pageSize: 50,
  maxDropFraction: 0.2,
  port: 4310,
  selectors: { heading: 'h1', footer: 'footer', brand: 'header a', details: 'dl' },
  fields: {
    id: 'id', name: 'name', parent: 'parent_id', street: 'billing_street',
    city: 'billing_city', state: 'billing_state', zip: 'billing_zip',
    phone: 'phone', care: 'care_type', status: 'status', note: 'note',
    revenue: 'lifetime_revenue', ar: 'outstanding_ar',
    duplicate: 'duplicate_of_account', chow: 'chow_current_account',
  },
  contactFields: { id: 'id', account: 'account_id', name: 'name', title: 'title', email: 'email', phone: 'phone', status: 'status' },
  careAliases: { 'memory care': 'memory support' },
  administratorTitles: ['Administrator'],
});

export function hash(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
}
export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(k => value[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function makeConfig(overrides = {}) {
  const config = { ...DEFAULTS, ...overrides,
    fields: { ...DEFAULTS.fields, ...overrides.fields },
    selectors: { ...DEFAULTS.selectors, ...overrides.selectors },
    contactFields: { ...DEFAULTS.contactFields, ...overrides.contactFields },
    careAliases: { ...DEFAULTS.careAliases, ...overrides.careAliases },
    administratorTitles: overrides.administratorTitles || DEFAULTS.administratorTitles };
  for (const key of ['siteUrl', 'apiUrl']) {
    const url = new URL(config[key]);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) {
      throw new Error(`${key} must be HTTPS (HTTP is allowed only on loopback), without credentials, query, or fragment.`);
    }
    config[key] = url.href;
  }
  config.siteUrl = new URL(config.siteUrl).origin;
  config.apiUrl = config.apiUrl.replace(/\/*$/, '/');
  for (const key of ['timeoutMs', 'maxPages', 'pageSize']) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new Error(`${key} must be a positive integer.`);
  }
  if (!Number.isFinite(config.delayMs) || config.delayMs < 0) throw new Error('delayMs must be nonnegative.');
  if (!Number.isSafeInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('Invalid port.');
  if (!(config.maxDropFraction >= 0 && config.maxDropFraction < 1)) throw new Error('maxDropFraction must be between 0 and 1.');
  if (!Array.isArray(config.seedPaths) || !config.seedPaths.length) throw new Error('seedPaths must not be empty.');
  for (const path of [...config.seedPaths, config.directoryPath, config.detailPath]) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || new URL(path, config.siteUrl).origin !== config.siteUrl) {
      throw new Error('Website paths must be same-origin absolute paths.');
    }
  }
  if (!Array.isArray(config.administratorTitles) || !config.administratorTitles.every(x => typeof x === 'string' && x.trim())) throw new Error('administratorTitles must contain nonempty labels.');
  if (!config.careAliases || Object.entries(config.careAliases).some(([key,value]) => !key || typeof value !== 'string' || !value)) throw new Error('careAliases must map strings to strings.');
  if (Object.values(config.contactFields).some(value => typeof value !== 'string' || !value) || new Set(Object.values(config.contactFields)).size !== Object.values(config.contactFields).length) throw new Error('Invalid contactFields mapping.');
  if (new Set(Object.values(config.fields)).size !== Object.keys(config.fields).length ||
      Object.values(config.fields).some(value => typeof value !== 'string' || !value)) {
    throw new Error('CRM field mappings must be distinct, nonempty strings.');
  }
  return config;
}

export async function loadConfig(path, overrides = {}, env = process.env) {
  const file = path ? JSON.parse(await readFile(path, 'utf8')) : {};
  if ('token' in file || 'CRM_TOKEN' in file) throw new Error('Do not put credentials in the configuration JSON. Use CRM_TOKEN.');
  const config = makeConfig({ ...file, ...(env.SITE_URL ? { siteUrl: env.SITE_URL } : {}),
    ...(env.CRM_API_URL ? { apiUrl: env.CRM_API_URL } : {}), ...overrides });
  const token = env.CRM_TOKEN || '';
  const scope = hash(`${config.apiUrl}\n${config.siteUrl}\n${token}`);
  const dataDir = resolve(overrides.dataDir || env.REVIEW_DATA_DIR || file.dataDir || `${homedir()}/.bellhaven-review/${scope.slice(0,16)}`);
  return { config, token, scope, dataDir };
}
