# Bellhaven website / CRM review

A small Node.js app: discover public facilities and the corporate footer, compare the entire CRM, review evidence, and write only explicitly approved changes. No LLM, frontend framework, hosted service, Python runtime or saved CRM credential is required.

## Run

Requirements: Node.js **22.16+**, npm/npx, Git and internet access.

```sh
npx --yes github:TerenceHK24/Clipboard-Health_Sales-Operations-Analyst --version
npx --yes github:TerenceHK24/Clipboard-Health_Sales-Operations-Analyst review
```

Enter the CRM token at the **hidden terminal prompt on every launch**, open the private localhost URL printed in the terminal, and click **Run read-only scan**. The token stays in that process's memory. It is not accepted in a file, environment variable, browser form or CLI argument, and is not written to the database or logs.

If npm shows an older version, append `#<commit-sha>` to the GitHub package spec to run the exact reviewed commit. Do not delete your decision database or clear your entire npm cache. The dashboard displays its version.

```sh
# Corporate row and all discovered facilities; no token needed.
npx --yes github:TerenceHK24/Clipboard-Health_Sales-Operations-Analyst scrape --output locations.csv
# Website + CRM comparison; prompts for token, never changes CRM.
npx --yes github:TerenceHK24/Clipboard-Health_Sales-Operations-Analyst scan
# Existing local journal; no credential needed.
npx --yes github:TerenceHK24/Clipboard-Health_Sales-Operations-Analyst status
# Read-only rescans every 24 hours while this process stays open.
npx --yes github:TerenceHK24/Clipboard-Health_Sales-Operations-Analyst review --daily
```

Use the same persistent `--data-dir` across launches. By default it is under your home directory, outside npm's cache. Keep it private and backed up. Use a different directory for each CRM sandbox/person; do not share journals across tenants.

## Review screen

Successful scans display the corporate name/address, website/account/contact counts, each facility's classification, and grouped proposals with exact before/after values and source links. Failed scans display **SCAN FAILED**, not “no inconsistencies.” Previous successful results are labelled stale and cannot be approved until a new successful scan.

Repeated corrections are grouped by change type, fields and decision status. Expand evidence, approve/reject an individual member, or decide the exact displayed group. Changed group membership blocks the batch before writing. Each target is rechecked, so stale members can be blocked while other members succeed. The API does not support a remote transaction for the whole group.

## Matching and safety rules

- Discover same-origin directory pagination and homepage/about location links, including acquired brands with unrelated names. Compare advertised counts and detect large coverage drops. Parse the company from the footer; do not invent an unpublished ZIP.
- Normalize API primary IDs at one boundary: `account_id` and `contact_id` become internal `id` for lists, detail reads, creation responses and patch responses. A contact's `account_id` remains its account relationship. Conflicting or malformed primary IDs abort; explicit custom mappings remain supported.
- Follow `page` and `page_size` until the declared unique total is satisfied, or an empty page when no total is provided. Identical overlap requires a declared total and a second matching full read. Incomplete, conflicting or stalled pages abort instead of guessing page sizes or silently discarding rows.
- Compare normalized names, locality, street and phone across every parent. Name identity tolerates punctuation and leading “The”; the official display name can still need correction. Address suffixes are normalized. Care aliases are configurable; `Memory Care` and `Memory Support` are equivalent.
- **Administrator parity:** For every matched facility, compare the published website Administrator against active CRM Administrator contacts. Display both names and an explicit Match / Approval required / Manual review / Deferred / Not published result. If different, create an approval-only contact proposal; reuse an existing matching person by updating only title/status, or propose creating a new contact if none exists. Superseded active Administrators can be marked Inactive after approval. Never overwrite names, emails or phone numbers. Multiple same-name people are flagged for manual identity review rather than auto-selected. CHOW and inactive facilities defer contact changes.
- When revenue history **and** outstanding AR are positive, create the new correct-parent account and change only the old account's `chow_current_account`. Preserve the old parent, name, finances, status, notes and contacts. Otherwise directly re-parent. Missing/invalid billing data blocks ownership changes.
- Duplicate dispositions identify the survivor with `duplicate_of_account` and mark the losing copy Inactive. No merging, deletion or transfer of billing history. Co-location alone is not proof of a duplicate.
- An account absent from the website is flagged Needs Review with evidence; absence alone does not establish closure or a new owner.
- If all identifying fields changed, do not guess from care type. A reviewer can save a verified manual link and rescan; that link alone does not change the CRM.

## Approval, recovery and safe reruns

SQLite stores evidence, decisions and per-step operations, not credentials. Unchanged decisions remain decided across runs and upgrades, even when an unrelated field changes. Full evidence and revision checks still prevent a stale browser from approving changed data.

Before writing, reread public evidence and affected CRM records, check financial gates, persist explicit approval, then POST/PATCH and read the result back. A group fetches public evidence once but still checks each CRM target. Scans never apply or resume writes.

Writes are not blindly retried. Account creates carry a deterministic operation note for recovery; uncertain outcomes stop instead of creating another record. Contact creates recover by the approved identity. Resuming an approved operation requires another explicit reviewer action. The API does not document conditional writes, idempotency keys or remote transactions, so no global race-free exactly-once guarantee is claimed. Rescan after applying a group to refresh dependent proposals.

## Configuration, scheduling and development

`--config config/example.json` overrides selectors, paths, field mappings, aliases and safety limits. Protocol/schema labels and general business rules are necessary contracts, not hard-coded facility answers. No real facility ID, address, count or personal token is embedded in runtime logic. Tests/fixtures are excluded from the installed runtime package.

See [daily scheduling](docs/daily-schedule.md) and [verification](docs/verification.md).

```sh
npm ci
npm test
npm run test:core
npm pack
```

Tests include synthetic HTTP responses with API-style primary keys, the full HTML-to-review-to-approved-write pipeline, CHOW, contacts, grouping, retries, saved decisions and localhost security. Browser checks run the real UI against synthetic servers. Test definitions are not evidence of a pass: inspect the actual CI run and artifacts. No real CRM writes are made by the tests.

## Assessment handoff

The assessment requires a **corrected CRM**, not only code or an unapproved queue. Run the authenticated scan, review and approve justified changes, and verify their CRM end state. Record approximately two minutes showing evidence, one approval, one rejection, and the approved change in the CRM browser. Submit the repository, demo, honest time spent and short writeup. The app does not approve on the reviewer's behalf.
