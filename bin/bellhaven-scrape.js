#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig, hash } from '../src/config.js';
import { promptForCrmToken } from '../src/credential.js';

const usage = `Community discovery and approval-only CRM review

Commands:
  scrape    Export the corporate office and all public facilities (default; no token needed)
  scan      Read website + CRM and persist proposals; NEVER applies changes
  review    Start the local reviewer app; writes require an explicit decision in the browser
  status    Print the last successful scan and decision counts

Options:
  --config FILE     Optional JSON configuration (no credentials)
  --data-dir DIR    Persistent decision/journal directory, shared with daily scan
  --base-url URL    Override the public website origin
  --api-url URL     Override the CRM API base URL
  -o, --output FILE CSV output (default: bellhaven_locations.csv)
  --snapshot FILE  Also export the public website snapshot as JSON (scrape only)
  --delay-ms N      Public-site request delay (default: 200)
  --port N          Local review port (default: 4310)
  --daily           Review mode: read-only rescan every 24 hours while running
  -h, --help        Print this help
  -v, --version     Print installed version

CRM token is requested interactively on every scan/review launch, with hidden input.
It is NEVER read from an env file, environment variable or command-line argument.
New processes require a prompt. review --daily reuses only its in-memory token.
Node.js 22.16+ is required. Keep the same state directory for manual scan and review.
`;

async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 16)) throw new Error('Install Node.js 22.16 or newer.');
  const { values, positionals } = parseArgs({ strict: true, allowPositionals: true, options: {
    config: { type: 'string' }, 'data-dir': { type: 'string' },
    'base-url': { type: 'string' }, 'api-url': { type: 'string' }, output: { type: 'string', short: 'o' },
    snapshot: { type: 'string' }, 'delay-ms': { type: 'string' }, port: { type: 'string' }, daily: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  } });
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  if (values.version) { console.log(version); return; }
  if (values.help) { console.log(usage); return; }
  const command = positionals[0] || 'scrape';
  if (positionals.length > 1 || !['scrape', 'scan', 'review', 'status'].includes(command)) throw new Error('Unknown command. Use --help.');
  if (values.daily && command !== 'review') throw new Error('--daily requires review mode.');
  const overrides = {};
  for (const [flag, field] of [['base-url', 'siteUrl'], ['api-url', 'apiUrl'], ['data-dir', 'dataDir']]) if (values[flag]) overrides[field] = values[flag];
  if (values['delay-ms'] !== undefined) overrides.delayMs = Number(values['delay-ms']);
  if (values.port !== undefined) overrides.port = Number(values.port);
  const { config, scope, dataDir } = await loadConfig(values.config, overrides);
  if (command === 'scrape') {
    const { scrapeSnapshot, writeCsv } = await import('../src/scraper.js');
    const website = await scrapeSnapshot(config);
    const output = resolve(values.output || 'bellhaven_locations.csv');
    await writeCsv([website.company, ...website.locations], output);
    if (values.snapshot) await writeFile(resolve(values.snapshot), JSON.stringify(website, null, 2) + '\n');
    console.log(`Saved 1 corporate office and ${website.locations.length} facilities to ${output}`); return;
  }
  const token = command === 'status' ? null : await promptForCrmToken();
  const { Store } = await import('../src/store.js');
  const legacyScope = token ? hash(`${config.apiUrl}\n${config.siteUrl}\n${token}`) : undefined;
  const store = new Store(dataDir, scope, { legacyScope });
  if (command === 'status') {
    try { console.log(JSON.stringify({ dataDir, lastScan: store.latest()?.summary || null,
      decisions: store.list().map(p => ({ id: p.id, title: p.title, status: p.status })) }, null, 2)); }
    finally { store.close(); }
    return;
  }
  const { CrmClient } = await import('../src/crm.js');
  const { ReviewService } = await import('../src/service.js');
  const readWebsite = async () => (await import('../src/scraper.js')).scrapeSnapshot(config);
  const service = new ReviewService({ config, store, client: new CrmClient(config, token), readWebsite });
  if (command === 'scan') {
    try { console.log(JSON.stringify(await service.scan(), null, 2)); }
    finally { store.close(); }
    return;
  }
  try {
    const { startReviewServer } = await import('../src/review-server.js');
    const app = await startReviewServer(service, { port: config.port, fields: config.fields });
    console.log(`Community CRM Review v${version}\nState: ${dataDir}\nOpen this private local URL:\n${app.url}\nNo CRM writes occur until you approve a proposal. Press Ctrl+C to stop.`);
    let scheduledScan = null;
    const timer = values.daily ? setInterval(() => {
      if (!scheduledScan) scheduledScan = service.scan().catch(error => console.error(`Scheduled scan failed: ${error.message}`)).finally(() => { scheduledScan = null; });
    }, 24 * 60 * 60 * 1000) : null;
    timer?.unref();
    if (timer) console.log('Read-only scan every 24 hours while this process stays open. No automatic approvals.');
    let closing = false;
    const stop = async () => { if (closing) return; closing = true; clearInterval(timer); await scheduledScan; await app.close(); store.close(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (error) { store.close(); throw error; }
}
main().catch(error => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
