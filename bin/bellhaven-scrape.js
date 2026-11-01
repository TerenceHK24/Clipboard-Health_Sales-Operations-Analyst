#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { scrapeAll, writeCsv, DEFAULT_BASE_URL } from '../src/scraper.js';

const usage = `Bellhaven community scraper

Usage:
  npx --yes github:TerenceHK24/Clipboard-Health_Sales-Operations-Analyst
  npx --yes github:TerenceHK24/Clipboard-Health_Sales-Operations-Analyst --output locations.csv

Options:
  -o, --output FILE      CSV destination (default: bellhaven_locations.csv)
      --base-url URL     Website origin (default: ${DEFAULT_BASE_URL})
      --delay-ms MS      Delay between requests (default: 200)
  -h, --help             Show this help
`;

async function main() {
  const { values } = parseArgs({
    options: {
      output: { type: 'string', short: 'o' },
      'base-url': { type: 'string' },
      'delay-ms': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  const delayMs = values['delay-ms'] === undefined ? 200 : Number(values['delay-ms']);
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error('--delay-ms must be a nonnegative number.');
  }
  const output = values.output ?? 'bellhaven_locations.csv';
  const rows = await scrapeAll({
    baseUrl: values['base-url'] ?? DEFAULT_BASE_URL,
    delayMs,
  });
  await writeCsv(rows, output);
  console.log(`Saved ${rows.length} Bellhaven communities to ${output}`);
}

main().catch(error => {
  console.error(`Scraper failed: ${error.message}`);
  process.exitCode = 1;
});
