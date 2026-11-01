# Daily schedule with interactive CRM authentication

**Security requirement:** Each CRM `scan` / `review` process asks a person to paste a hidden bearer token. This means **unattended, scheduled CRM scans are not supported**. A cron job or GitHub Actions runner has no interactive terminal: it must fail instead of reading a saved token. No daily job may auto-approve or write to CRM.

You can schedule the **public-website-only scraper**, which needs no CRM token. This captures a dated public snapshot, not a CRM reconciliation. Run `scan` from your terminal each day you want fresh CRM comparisons, then open `review` to approve decisions. Use the same persistent `--data-dir` for both.

## macOS/Linux cron (public website only)

Ensure Node.js 22.16+, Git and npm/npx are available for the scheduled user. Create a private directory for site snapshots, e.g. `/home/you/bellhaven-snapshots`. An example for systems with support for `CRON_TZ`:

```cron
CRON_TZ=America/Edmonton
30 8 * * * /usr/bin/env npx --yes github:TerenceHK24/Clipboard-Health_Sales-Operations-Analyst scrape --output /home/you/bellhaven-snapshots/latest.csv --snapshot /home/you/bellhaven-snapshots/latest.json >>/home/you/bellhaven-snapshots/scrape.log 2>&1
```

`CRON_TZ` support is platform-specific. Set a suitable system timezone otherwise. Substitute the path to `npx` from `command -v npx` where needed. This overwrites the latest public files; arrange separate dated backups if historical evidence is needed.

## Windows Task Scheduler (public website only)

Schedule a daily program using `npx.cmd` (locate with `where npx.cmd`), with arguments:

```text
--yes github:TerenceHK24/Clipboard-Health_Sales-Operations-Analyst scrape --output C:\Bellhaven\latest.csv --snapshot C:\Bellhaven\latest.json
```

Select a writable directory and disable overlapping runs. This does not contact the CRM. Run the interactive CRM scan or Review App manually:

```sh
npx --yes github:TerenceHK24/Clipboard-Health_Sales-Operations-Analyst scan --data-dir ./bellhaven-state
npx --yes github:TerenceHK24/Clipboard-Health_Sales-Operations-Analyst review --data-dir ./bellhaven-state
```

Each command prompts for a token **every time**. The token is not stored. SQLite stores decisions and review evidence; keep `--data-dir` fixed, backed up and private. If an unattended daily CRM scan becomes a requirement, the operator must explicitly authorize an alternative noninteractive authentication method; this version will not circumvent the interactive-only rule.
