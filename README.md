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

## CRM token: prompted every time, not stored

**Do not create a token file.** Every time you start `scan` or `review`, the application requests the CRM bearer token directly in the terminal, with **input hidden**. Paste the token, then press Enter. The value stays in the running Node.js process only, is sent only as the `Authorization` header to the configured CRM API, and is not saved in `.env`, JSON, SQLite, CSV, logs, CLI arguments or shell history. Exit the process to end that authenticated session. A new process prompts again, even when you use the same state directory.

```sh
npx --yes github:TerenceHK24/Clipboard-Health_Sales-Operations-Analyst scan --data-dir ./bellhaven-state
# Terminal: Enter CRM bearer token (input hidden):
```

The `scan` command reads the public website and full CRM accounts and contacts via GET requests, then journals suggested changes. **It never writes to the CRM.** All account/contact data and decisions (but no token) are stored in local `review.sqlite`. Keep that directory private and backed up.

To start the local reviewer:

```sh
npx --yes github:TerenceHK24/Clipboard-Health_Sales-Operations-Analyst review --data-dir ./bellhaven-state
# Terminal: Enter CRM bearer token (input hidden):
```

Open the **private loopback URL printed in the terminal**, e.g. `http://127.0.0.1:4310/#...`. The fragment is a randomly generated session key, **not your CRM token**. Click **Run read-only scan**, inspect public and CRM evidence and field-level changes, then explicitly Approve or Reject. Repeated issues are grouped with per-account details and group decisions. For unresolved identity, make a manual link, which does not write to CRM.

To inspect the local journal without contacting CRM or entering a token:

```sh
npx --yes github:TerenceHK24/Clipboard-Health_Sales-Operations-Analyst status --data-dir ./bellhaven-state
```

**Interactive-terminal requirement:** `scan` and `review` fail closed if started without a real terminal. The old `--env-file` flag has been removed; `CRM_TOKEN` in the environment is ignored. Do not put the token in any config file or shell command. No browser prompt or token storage is used. Running the public-only `scrape` command requires no token.

**Persistent decisions across token changes:** the state is scoped to the website and CRM API URL, not the token. Always use the same `--data-dir`. For previously saved v2.1 journals using the old token-based scope, pass the old data directory and its original token once to migrate; after that, new tokens work with the same journal. If the original token is already revoked, preserve the old journal and arrange a controlled migration rather than deleting the decisions.

## Reconciliation rules

- Public corporate parent is discovered from the footer; the CRM parent is identified from its normalized name, not a fixed account ID.
- Public facility-to-CRM matching compares normalized street, city, state, name, and phone across **all** accounts, including those under a different parent. Ambiguous cases are flagged for review and cannot be silently created or re-parented.
- Missing website facility: propose a new facility under the correct parent **only when no plausible CRM candidate exists**.
- CRM child of Bellhaven absent from the public directory: propose `Needs Review` plus an explanatory note. **Never auto-close or delete** based on absence alone.
- Duplicate candidates: propose `duplicate_of_account=<survivor ID>`, `status=Inactive`, and explanatory note on the losing record; preserve all billing history, contacts, and data. Never merge or delete.
- Wrong parent **with `lifetime_revenue > 0` AND `outstanding_ar > 0`**: propose CHOW. After approval, create the current facility account under the correct parent and set **only** `chow_current_account` on the old account. Keep old parent, billing fields, name, status, notes and contacts unchanged.
- Wrong parent when either numeric financial value is zero: propose direct re-parent of the existing record. Missing or invalid financial figures block ownership changes.
- Administrator is verified against active CRM contacts (not facility-account fields). A missing/different administrator creates a separate approval-only **contact proposal**: create or reactivate the published administrator, then mark outdated administrator contacts Inactive. Never rename an unrelated person, change their email or phone, invent a new email, or modify historical non-administrator contacts. Ambiguous contact identity requires manual resolution. With CHOW, old contacts remain untouched; a follow-up scan proposes the new current account's administrator.
- Care-type equivalence is configurable: **Memory Care** in CRM and **Memory Support** on the website mean the same category. Neither causes a false discrepancy. Additional equivalences may be configured without listing facilities.
- The leading article and punctuation in a community name are ignored **for identity matching**, but canonical public spelling is still proposed as a name correction (e.g., initial “The” and a hyphen).
- Exact global name matches can identify relocated or reparented facilities even when their city/state/phone changed. If **every identifying field differs except care type**, no defensible automatic identity match exists: reviewers can manually link a specific verified existing CRM account, which is saved to SQLite and triggers a new **read-only** scan. Linking is not CRM approval. The link must remain unchanged through approval.
- Repeated discrepancies of the **same kind and field set** appear as **one review group**, with an account-by-account before/after preview, expandable evidence and a single explicit Approve All / Reject All action. The server rejects partial, stale or substituted group membership; each member is individually journaled. Group CHOW/reparent/duplicate actions carry a prominent financial/identity warning; failed members remain blocked for explicit retry.
- Publicly missing fields are not used to erase existing CRM values. The footer has no published corporate ZIP, so none is invented.

## Idempotence, verification and limitations

- Proposals have deterministic IDs from source evidence and selected CRM fields. Re-scans reuse prior decisions; unchanged rejected/applied cases do not return to pending. Material evidence changes may yield a **new** proposal for fresh review.
- A SQLite journal records every decision and write intent. Every approval rechecks website identity and fresh CRM data; writes are read back. Prior successful operations are recovered, not replayed. A uncertain POST is **not retried** unless its unique marker proves the previous create succeeded; otherwise manual intervention is needed.
- POST/PATCH are never automatically retried. The API does not document an idempotency-key or conditional-update endpoint; the app fails closed if the outcome is uncertain or source data changes.
- Strict completeness checks catch missing public pages, inconsistent directory counts, incomplete CRM pagination and abrupt location drops. Fully unlinked sites cannot be guaranteed.
- Run only **one** reviewer/scan process against the same state directory; a local journal lock prevents parallel actions on one machine. For daily automation, use a single persistent host/data directory, **not ephemeral GitHub Actions runners**.

## Daily schedule (configuration only)

See [`docs/daily-schedule.md`](docs/daily-schedule.md). You can schedule **public-site-only** `scrape` daily with no token, but a daily CRM reconciliation cannot run unattended while requiring a fresh hidden token from a person each time. Run `scan` interactively when present. The example schedule is not installed or enabled.

## Configuration and tests

Site paths, selectors, API field names, timeout, pagination, coverage thresholds and port can be overridden with `--config path/to/config.json`; see [`config/example.json`](config/example.json). Examples are not location records; **no facility/account IDs are hard-coded**. Default host and generic HTML/API schema mappings live in `src/config.js`.

```sh
git clone https://github.com/TerenceHK24/Clipboard-Health_Sales-Operations-Analyst.git
cd Clipboard-Health_Sales-Operations-Analyst
npm install
npm test
node bin/bellhaven-scrape.js --help
```

Tests include synthetic examples based on the public Amberly Manor, Dayton and Akron record shapes, but they do **not** assert current CRM values. They use local mock data only and never access or mutate the live CRM. The CRM API's OpenAPI documentation does not specify contact request-body schemas, so production POST/PATCH contact compatibility must be checked in a credentialed sandbox before approval; failure is surfaced as blocked rather than silently retried. Live operation requires a valid token and host connectivity. API reference: https://analyst-assessment-production.up.railway.app/api/docs

**Important:** If a bearer token was shared in a conversation or another location, rotate/revoke it using the CRM controls and paste the replacement only into the hidden terminal prompt.
