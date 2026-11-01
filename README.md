# Bellhaven | Public-Site & CRM Review

A cross-platform, approval-only Sales Operations reconciliation app. It dynamically discovers public facilities, extracts the corporate parent from the public footer, compares the entire CRM account inventory, and proposes specific reviewed actions. **Daily scans never write to the CRM.**

## Requirements

- Node.js **22.16+**, npm/npx, Git, and network access. Supported on Windows, macOS, and Linux.
- A CRM bearer token with access to the account/contact endpoints. **Never commit or paste your token into source, GitHub, or logs.**

## One-command public scraper (no credential)

Run in a terminal in the directory where you want the CSV:

```sh
npx --yes github:TerenceHK24/Clipboard-Health_Sales-Operations-Analyst scrape --output bellhaven_locations.csv
```

The CSV contains one `record_type=company` entry and all discovered `record_type=facility` entries. The corporate name and office address come from `footer`; a missing ZIP stays blank, not guessed. The scraper follows pagination plus community links on the homepage and `/about`, checks the advertised counts, and includes acquired facility brands. Optional `--snapshot public-snapshot.json` exports metadata and coverage details.

## Configure credential locally

In a private directory you control, create a `.env` file containing one line:

```text
CRM_TOKEN=YOUR_PRIVATE_BEARER_TOKEN
```

On macOS/Linux, restrict access with `chmod 600 /path/to/.env`. On Windows, limit ACL access to your user. The app does not accept tokens as CLI arguments. The `.env` should **not** be inside any public Git repository.

## Scan without making changes

```sh
npx --yes github:TerenceHK24/Clipboard-Health_Sales-Operations-Analyst scan --env-file /private/path/.env --data-dir /private/path/bellhaven-state
```

All `GET` requests are read-only. The scanner enumerates all paginated accounts and contacts (not just `q=bellhaven`), parses public company and community pages, and creates candidate discrepancies in a persistent SQLite journal (`review.sqlite`). A failed or incomplete scan does not replace the last complete result. Decisions and previously approved operations survive restarts and scans when the same credential scope and `--data-dir` are used. State contains CRM details: restrict access and back it up.

## Start local review app

```sh
npx --yes github:TerenceHK24/Clipboard-Health_Sales-Operations-Analyst review --env-file /private/path/.env --data-dir /private/path/bellhaven-state
```

Open the **private loopback URL printed in your terminal**, e.g. `http://127.0.0.1:4310/#...`. The fragment is a randomly generated session key, **not your CRM token**. The app can be opened only on the local computer. Click **Run read-only scan**, inspect a proposal's site/CRM evidence and exact field-level changes, type a reviewer name, then **Approve and write** or **Reject**. The approval confirmation is explicit; no writes occur from running a scan or opening the review UI. Do not expose the loopback service through a proxy or tunnel.

To see prior decisions without running a scan:

```sh
npx --yes github:TerenceHK24/Clipboard-Health_Sales-Operations-Analyst status --env-file /private/path/.env --data-dir /private/path/bellhaven-state
```

## Reconciliation rules

- Public corporate parent is discovered from the footer; the CRM parent is identified from its normalized name, not a fixed account ID.
- Public facility-to-CRM matching compares normalized street, city, state, name, and phone across **all** accounts, including those under a different parent. Ambiguous cases are flagged for review and cannot be silently created or re-parented.
- Missing website facility: propose a new facility under the correct parent **only when no plausible CRM candidate exists**.
- CRM child of Bellhaven absent from the public directory: propose `Needs Review` plus an explanatory note. **Never auto-close or delete** based on absence alone.
- Duplicate candidates: propose `duplicate_of_account=<survivor ID>`, `status=Inactive`, and explanatory note on the losing record; preserve all billing history, contacts, and data. Never merge or delete.
- Wrong parent **with `lifetime_revenue > 0` AND `outstanding_ar > 0`**: propose CHOW. After approval, create the current facility account under the correct parent and set **only** `chow_current_account` on the old account. Keep old parent, billing fields, name, status, notes and contacts unchanged.
- Wrong parent when either numeric financial value is zero: propose direct re-parent of the existing record. Missing or invalid financial figures block ownership changes.
- Contact administrator differences are shown as **notices**. No implicit contact create/rename/update is performed.
- Publicly missing fields are not used to erase existing CRM values. The footer has no published corporate ZIP, so none is invented.

## Idempotence, verification and limitations

- Proposals have deterministic IDs from source evidence and selected CRM fields. Re-scans reuse prior decisions; unchanged rejected/applied cases do not return to pending. Material evidence changes may yield a **new** proposal for fresh review.
- A SQLite journal records every decision and write intent. Every approval rechecks website identity and fresh CRM data; writes are read back. Prior successful operations are recovered, not replayed. A uncertain POST is **not retried** unless its unique marker proves the previous create succeeded; otherwise manual intervention is needed.
- POST/PATCH are never automatically retried. The API does not document an idempotency-key or conditional-update endpoint; the app fails closed if the outcome is uncertain or source data changes.
- Strict completeness checks catch missing public pages, inconsistent directory counts, incomplete CRM pagination and abrupt location drops. Fully unlinked sites cannot be guaranteed.
- Run only **one** reviewer/scan process against the same state directory; a local journal lock prevents parallel actions on one machine. For daily automation, use a single persistent host/data directory, **not ephemeral GitHub Actions runners**.

## Daily schedule (configuration only)

See [`docs/daily-schedule.md`](docs/daily-schedule.md). Scheduled jobs run **`scan` only**. The included example is not installed or enabled.

## Configuration and tests

Site paths, selectors, API field names, timeout, pagination, coverage thresholds and port can be overridden with `--config path/to/config.json`; see [`config/example.json`](config/example.json). Examples are not location records; **no facility/account IDs are hard-coded**. Default host and generic HTML/API schema mappings live in `src/config.js`.

```sh
git clone https://github.com/TerenceHK24/Clipboard-Health_Sales-Operations-Analyst.git
cd Clipboard-Health_Sales-Operations-Analyst
npm install
npm test
node bin/bellhaven-scrape.js --help
```

Tests use local mock data only and never access or mutate the live CRM. Live operation requires a valid token and host connectivity. API reference: https://analyst-assessment-production.up.railway.app/api/docs

**Important:** If a bearer token was shared in a conversation or other location, replace/revoke it according to your CRM's controls and use the replacement only in your private local `.env` file.
