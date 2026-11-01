import { load } from 'cheerio';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

export const DEFAULT_BASE_URL = 'https://analyst-assessment-production.up.railway.app';
export const CSV_COLUMNS = ['name','address','city','state','zip','care_offerings','administrator','phone','source_url'];
const DETAIL = /^\/communities\/[^/]+$/;
const PLACE = /^(?<city>.+?),\s*(?<state>[a-z]{2})\s+(?<zip>\d{5}(?:-\d{4})?)$/i;

export function communityLink(href, pageUrl, origin) {
  let u;
  try { u = new URL(href, pageUrl); } catch { return null; }
  if (u.origin !== origin || !['https:', 'http:'].includes(u.protocol)) return null;
  const path = u.pathname.replace(/\/+$/, '') || '/';
  if (DETAIL.test(path)) return { type:'detail', url:origin + path };
  if (path === '/communities') {
    const page = u.searchParams.get('page');
    if (page === null) return { type:'directory',url:origin + path };
    if (/^[1-9]\d*$/.test(page)) return { type:'directory',url:origin + path + '?page=' + Number(page) };
  }
  return null;
}

export async function discoverLocations({ baseUrl=DEFAULT_BASE_URL,fetchPage,delayMs=200 }) {
  const origin = new URL(baseUrl).origin;
  const queue = [origin+'/communities',origin+'/'];
  const visited = new Set(), details = new Set();
  let expected = 0, directoryPages = 0;
  while (queue.length) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    if (new URL(url).pathname === '/communities' && ++directoryPages > 100) throw Error('Pagination exceeded 100 pages');
    const $ = load(await fetchPage(url));
    if (new URL(url).pathname === '/communities') {
      const found = $.root().text().match(/\b([\d,]+)\s+communities\s+listed\b/i);
      if (found) expected = Math.max(expected, Number(found[1].replaceAll(',','')));
    }
    $('a[href]').each((_,a) => {
      const link = communityLink($(a).attr('href'),url,origin);
      if (!link) return;
      if (link.type === 'detail') details.add(link.url);
      else if (!visited.has(link.url) && !queue.includes(link.url)) queue.push(link.url);
    });
    if (delayMs) await pause(delayMs);
  }
  if (!details.size) throw Error('No community links found');
  if (details.size < expected) throw Error('Discovered '+details.size+' community links but directory lists '+expected);
  return [...details].sort();
}

export function parseCommunity(html,sourceUrl) {
  const $ = load(html);
  const name = ($('main h1').first().text() || $('h1').first().text()).trim();
  if (!name) throw Error('Missing name: '+sourceUrl);
  const fields = new Map();
  $('dl').each((_,dl) => {
    let key = null;
    $(dl).children('dt,dd').each((__,el) => {
      if (el.tagName.toLowerCase() === 'dt') key = $(el).text().toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
      else if (key) { fields.set(key,$(el)); key=null; }
    });
  });
  const node = fields.get('address');
  if (!node) throw Error('Missing address: '+sourceUrl);
  const copy = node.clone();
  copy.find('br').replaceWith('\n');
  const parts = copy.text().split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  if (parts.length<2) throw Error('Incomplete address: '+sourceUrl);
  const match = parts.at(-1).match(PLACE);
  if (!match) throw Error('Unrecognized city/state/ZIP: '+sourceUrl);
  const care = fields.get('care offerings') ?? fields.get('care offering');
  if (!care) throw Error('Missing care offerings: '+sourceUrl);
  let offers = care.find('.badge').toArray().map(n=>$(n).text().trim()).filter(Boolean);
  if (!offers.length && care.text().trim()) offers=[care.text().trim()];
  if (!offers.length) throw Error('Empty care offerings: '+sourceUrl);
  const optional = key=>fields.get(key)?.text().trim()??'';
  return {
    name,address:parts.slice(0,-1).join(', '),city:match.groups.city.trim(),
    state:match.groups.state.toUpperCase(),zip:match.groups.zip,
    care_offerings:[...new Set(offers)].join(' | '),
    administrator:optional('administrator'),phone:optional('phone'),source_url:sourceUrl
  };
}

export async function fetchHtml(url,{fetchImpl=fetch,sleep=pause,retries=3}={}) {
  for(let i=0;i<=retries;i++){
    let response;
    try {
      response=await fetchImpl(url,{headers:{'User-Agent':'BellhavenCommunityResearch/1.0'},signal:AbortSignal.timeout(25000)});
      if(response.ok) return response.text();
      if(![429,500,502,503,504].includes(response.status) || i===retries) throw Error('HTTP '+response.status+' for '+url);
    } catch(err) {
      if((err.message||'').startsWith('HTTP ')||i===retries) throw err;
    }
    const retryAfter=Number(response?.headers?.get('retry-after'));
    await sleep(Math.min(retryAfter>0?retryAfter*1000:500*2**i,15000));
  }
  throw Error('Failed '+url);
}

export async function scrapeAll({baseUrl=DEFAULT_BASE_URL,delayMs=200,fetchPage=fetchHtml}={}) {
  const urls=await discoverLocations({baseUrl,delayMs,fetchPage});
  const rows=[];
  for(const [i,url] of urls.entries()){
    const row=parseCommunity(await fetchPage(url),url);
    rows.push(row);
    console.error('['+(i+1)+'/'+urls.length+'] '+row.name);
    if(delayMs) await pause(delayMs);
  }
  return rows.sort((a,b)=>a.name.localeCompare(b.name));
}

function csvCell(value) {
  const text=String(value??'');
  return /[",\r\n]/.test(text)?'"'+text.replaceAll('"','""')+'"':text;
}
export function createCsv(rows) {
  return '\uFEFF'+[CSV_COLUMNS.join(','),...rows.map(r=>CSV_COLUMNS.map(k=>csvCell(r[k])).join(','))].join('\r\n')+'\r\n';
}
export async function writeCsv(rows,outputPath) {
  await mkdir(dirname(outputPath),{recursive:true});
  await writeFile(outputPath,createCsv(rows),'utf8');
}
