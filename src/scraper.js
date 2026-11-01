import { load } from 'cheerio';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { makeConfig, DEFAULT_BASE_URL, hash } from './config.js';

export { DEFAULT_BASE_URL };
export const CSV_COLUMNS = ['record_type', 'name', 'address', 'city', 'state', 'zip', 'care_offerings', 'administrator', 'phone', 'source_url'];
const compact = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const PLACE = /^(?<city>.+?),\s*(?<state>[a-z]{2})\s+(?<zip>\d{5}(?:-\d{4})?)$/i;

export function communityLink(href, pageUrl, origin, options = {}) {
  let url;
  try { url = new URL(href, pageUrl); } catch { return null; }
  if (url.origin !== origin || !['https:', 'http:'].includes(url.protocol)) return null;
  const directoryPath = options.directoryPath || '/communities';
  const detailPath = options.detailPath || `${directoryPath}/`;
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path.startsWith(detailPath) && path.slice(detailPath.length) && !path.slice(detailPath.length).includes('/')) {
    return { type: 'detail', url: origin + path };
  }
  if (path === directoryPath) {
    const page = url.searchParams.get('page');
    if (page === null || page === '1') return { type: 'directory', url: origin + path };
    if (/^[1-9]\d*$/.test(page) && Number.isSafeInteger(Number(page))) return { type: 'directory', url: `${origin}${path}?page=${Number(page)}` };
  }
  return null;
}

export async function fetchHtml(url, { fetchImpl = fetch, sleep = pause, retries = 3, timeoutMs = 25000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, { redirect: 'error', headers: { 'User-Agent': 'CommunityReview/2.0' }, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      if (attempt >= retries) throw new Error(`Public page request failed: ${url}`);
    }
    if (!response && attempt >= retries) throw new Error(`Public page request failed: ${url}`);
    if (response?.ok) return await response.text();
    if (response && (![429, 500, 502, 503, 504].includes(response.status) || attempt >= retries)) throw new Error(`HTTP ${response.status} for ${url}`);
    const retry = response?.headers?.get('retry-after');
    const ms = retry && /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
    await sleep(Math.min(Number.isFinite(ms) && ms > 0 ? ms : 300 * 2 ** attempt, 30000));
  }
}

async function discover({ config, fetchPage }) {
  const queue = config.seedPaths.map(path => new URL(path, config.siteUrl).href);
  const pages = new Map(), locations = new Set(), counts = new Set();
  let expectedPages = 0, visitedDirectories = 0, homeCount = 0;
  while (queue.length) {
    const url = queue.shift();
    if (pages.has(url)) continue;
    if (pages.size >= config.maxPages) throw new Error('Website discovery exceeded maxPages.');
    const html = await fetchPage(url), $ = load(html);
    pages.set(url, html);
    const body = compact($('body').text());
    if (new URL(url).pathname.replace(/\/$/, '') === config.directoryPath) {
      visitedDirectories++;
      const count = body.match(/\b([\d,]+)\s+communities\s+listed\b/i);
      if (count) counts.add(Number(count[1].replaceAll(',', '')));
      const pagination = body.match(/\bPage\s+\d+\s*(?:of|\/)\s*(\d+)/i);
      if (pagination) expectedPages = Math.max(expectedPages, Number(pagination[1]));
    } else if (new URL(url).pathname === '/') {
      const count = body.match(/\b(?:serve|serving|operate|operating)\s+([\d,]+)\s+communities\b/i);
      if (count) homeCount = Number(count[1].replaceAll(',', ''));
    }
    $('a[href]').each((_, anchor) => {
      const link = communityLink($(anchor).attr('href'), url, config.siteUrl, config);
      if (link?.type === 'detail') locations.add(link.url);
      else if (link && !pages.has(link.url) && !queue.includes(link.url)) queue.push(link.url);
    });
    if (config.delayMs) await pause(config.delayMs);
  }
  if (counts.size > 1) throw new Error('Directory totals changed between pages; refusing an inconsistent snapshot.');
  const directoryCount = [...counts][0] || 0;
  if (!locations.size) throw new Error('No community links found.');
  if (locations.size < Math.max(directoryCount, homeCount)) throw new Error(`Discovered ${locations.size} links; directory lists ${directoryCount} and homepage advertises ${homeCount}.`);
  if (visitedDirectories < expectedPages) throw new Error('Directory pagination is incomplete.');
  return { urls: [...locations].sort(), pages,
    coverage: { directoryCount, homeCount, directoryPages: visitedDirectories, expectedPages,
      discovered: locations.size, discovery: 'Same-origin links from configured seed pages and all linked directory pages; unlinked pages cannot be guaranteed.' } };
}

export async function discoverLocations({ baseUrl = DEFAULT_BASE_URL, fetchPage = fetchHtml, delayMs = 200, config } = {}) {
  return (await discover({ config: config || makeConfig({ siteUrl: baseUrl, delayMs, seedPaths: ['/communities', '/'] }), fetchPage })).urls;
}

export function parseCommunity(html, sourceUrl, config = makeConfig()) {
  const $ = load(html);
  const name = compact($(`main ${config.selectors.heading}`).first().text() || $(config.selectors.heading).first().text());
  if (!name) throw new Error(`Missing community name: ${sourceUrl}`);
  const fields = new Map();
  $(config.selectors.details).each((_, dl) => {
    let label = null;
    $(dl).children('dt,dd').each((__, element) => {
      if (element.tagName.toLowerCase() === 'dt') label = compact($(element).text()).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      else if (label) { fields.set(label, $(element)); label = null; }
    });
  });
  const address = fields.get('address');
  if (!address) throw new Error(`Missing address: ${sourceUrl}`);
  const copy = address.clone();
  copy.find('br').replaceWith('\n');
  const lines = copy.text().split(/\r?\n/).map(compact).filter(Boolean);
  if (lines.length < 2) throw new Error(`Incomplete address: ${sourceUrl}`);
  const place = lines.at(-1).match(PLACE);
  if (!place) throw new Error(`Unrecognized city/state/ZIP: ${sourceUrl}`);
  const care = fields.get('care offerings') || fields.get('care offering');
  if (!care) throw new Error(`Missing care offerings: ${sourceUrl}`);
  let offerings = care.find('.badge').toArray().map(node => compact($(node).text())).filter(Boolean);
  if (!offerings.length && compact(care.text())) offerings = [compact(care.text())];
  if (!offerings.length) throw new Error(`Empty care offerings: ${sourceUrl}`);
  return { record_type: 'facility', name, address: lines.slice(0, -1).join(', '), city: place.groups.city.trim(),
    state: place.groups.state.toUpperCase(), zip: place.groups.zip, care_offerings: [...new Set(offerings)].join(' | '),
    administrator: compact(fields.get('administrator')?.text()), phone: compact(fields.get('phone')?.text()), source_url: sourceUrl };
}

export function parseCompany(html, sourceUrl, config = makeConfig()) {
  const $ = load(html), footer = compact($(config.selectors.footer).text());
  const office = footer.match(/\b(?:corporate\s+office|head\s+office|headquarters)\s*:\s*(.+?)(?=[|·]|$)/i);
  if (!office) throw new Error(`Corporate office address not found in footer: ${sourceUrl}`);
  const copyright = footer.match(/(?:©|\(c\)|copyright)\s*(?:\d{4}(?:[-–]\d{4})?\s*)?(.+?)(?=\.\s*all rights reserved|[|·]|$)/i);
  const name = compact(copyright?.[1] || $(config.selectors.brand).first().text()).replace(/\.$/, '');
  const address = office[1].match(/^(?<street>.+),\s*(?<city>[^,]+),\s*(?<state>[a-z]{2})(?:\s+(?<zip>\d{5}(?:-\d{4})?))?\.?$/i);
  if (!name || !address) throw new Error('Corporate footer could not be parsed; no company details were invented.');
  return { record_type: 'company', name, address: address.groups.street.trim(), city: address.groups.city.trim(),
    state: address.groups.state.toUpperCase(), zip: address.groups.zip || null,
    care_offerings: '', administrator: '', phone: '', source_url: sourceUrl, raw_footer: footer };
}

export async function scrapeSnapshot(config = makeConfig(), fetchPage = url => fetchHtml(url, config)) {
  const discovery = await discover({ config, fetchPage });
  const locations = [];
  for (const url of discovery.urls) {
    locations.push(parseCommunity(await fetchPage(url), url, config));
    if (config.delayMs) await pause(config.delayMs);
  }
  // Prefer the corporate/about seed when present; verify every available seed footer agrees.
  const companies = [...discovery.pages].filter(([, html]) => load(html)(config.selectors.footer).length)
    .map(([url, html]) => parseCompany(html, url, config));
  if (!companies.length) throw new Error('No corporate footer was available.');
  const identities = new Set(companies.map(({ source_url, raw_footer, ...values }) => hash(values)));
  if (identities.size !== 1) throw new Error('Corporate footer details conflict between public pages.');
  const company = [...config.seedPaths].reverse().map(path => companies.find(item => item.source_url === new URL(path, config.siteUrl).href)).find(Boolean) || companies[0];
  locations.sort((a, b) => a.name.localeCompare(b.name));
  return { company, locations, complete: true, coverage: discovery.coverage, fetchedAt: new Date().toISOString() };
}

// Backwards-compatible facility-only library function. The CLI now exports the company too.
export async function scrapeAll({ baseUrl = DEFAULT_BASE_URL, delayMs = 200, fetchPage = fetchHtml } = {}) {
  const urls = await discoverLocations({ baseUrl, delayMs, fetchPage });
  const rows = [];
  for (const url of urls) { rows.push(parseCommunity(await fetchPage(url), url)); if (delayMs) await pause(delayMs); }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}
function csvCell(value) {
  let cell = String(value ?? '');
  // Prevent spreadsheet formula execution when public content is opened in Excel.
  if (/^[\s]*[=+@-]/.test(cell)) cell = `'${cell}`;
  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}
export function createCsv(rows) {
  return '\uFEFF' + [CSV_COLUMNS.join(','), ...rows.map(row => CSV_COLUMNS.map(key => csvCell(row[key])).join(','))].join('\r\n') + '\r\n';
}
export async function writeCsv(rows, outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, createCsv(rows), 'utf8'); await rename(temporary, outputPath); }
  finally { await unlink(temporary).catch(() => {}); }
}
