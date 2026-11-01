# Bellhaven Community Scraper

Cross-platform Node.js CLI to dynamically discover and export Bellhaven communities.

## Run on any Windows / macOS / Linux computer

Install **Node.js 20+** (includes npx) and **Git**. Open a terminal in the folder where you want the CSV:

```bash
npx --yes github:TerenceHK24/Clipboard-Health_Sales-Operations-Analyst
```

For a different output path:

```bash
npx --yes github:TerenceHK24/Clipboard-Health_Sales-Operations-Analyst --output results/bellhaven.csv
```

The output is `bellhaven_locations.csv` in your working directory by default.

Optional flags: `--base-url URL`, `--delay-ms 500`, `--help`. The npx command downloads this repository and its npm dependencies to the local npm cache. No Python installation or clone is needed, but internet access is needed on the first run.

## How it works

- Starts from the homepage and the paginated community directory; follows same-origin links to detail pages automatically.
- Follows every linked directory page and deduplicates location links.
- Checks discovered location count against the directory's published count when available (the count itself is not hard-coded).
- Parses location heading and the labeled `<dl><dt>...</dt><dd>...</dd></dl>` fields using Cheerio, independent of ordering.
- Splits the multiline address into street, city, state, ZIP; collects all care badges and optional administrator and phone.
- Uses timeouts, retries for transient server failures, and writes only after all pages are parsed successfully.
- Produces Excel-compatible UTF-8 CSV (with BOM).

Columns: `name,address,city,state,zip,care_offerings,administrator,phone,source_url`.

## Development

```bash
npm install
npm test
node bin/bellhaven-scrape.js --help
```

The earlier Python scraper remains in the repository but is not required for the npx workflow.

## Completeness

The directory was observed listing 34 communities on three pages, while the homepage stated 35 and linked to a recently added location. This CLI examines both sources rather than hard-coding 34 or 35. Truly unlinked detail pages cannot be discovered by ordinary link traversal. A changed site structure may require parser maintenance.
