# Verification — version 2.3.0

## Root cause

The user's account response exposes `account_id`; the earlier app and its mocks assumed `id`. The scan failed before matching, and the empty queue was not persistently distinguished from a successful scan with no differences. This release normalizes primary keys at the API boundary for list, get, create and patch, separately for accounts and contacts.

## Independent verification layers

1. Core and regression tests: resource-specific primary keys, malformed/ambiguous IDs, all response paths, pagination, finance gates, duplicate dispositions, contacts, saved decisions, stale approvals, recovery and credentials.
2. HTTP pipeline and packaging: actual HTML parser against a paginated synthetic website, real HTTP client against API-shaped fixtures, SQLite, review API, approved writes/read-back and reruns. Packaged CLI is exercised separately.
3. Real browser: Playwright drives the dashboard against synthetic HTTP servers. It checks initial/failure/success states, groups and individual actions, approvals, rejection/rerun, parent/finance display, care synonyms and stale-data protections. Screenshots and receipts are CI artifacts.

A defined test is not evidence of a pass. Consult the exact GitHub Actions run and artifacts. The credential-free public-site smoke test is distinct from authenticated CRM testing.

## Limits

No automated test uses the user's CRM token or performs real CRM POST/PATCH. The reported account_id payload establishes that adapter; contact_id is exercised in synthetic HTTP contract tests, not asserted to have been independently read from the authenticated live sandbox. Public API docs do not provide a complete body schema or documented conditional-write/transaction guarantees.

The reviewer must still run the authenticated scan, approve justified changes, and check the final CRM state and required demo. No guarantee of zero possible future software errors is claimed.

## Hard-coding and dependency review

Production code contains protocol/schema names, configurable paths/selectors and general matching/safety rules. Real facility names, IDs, addresses, counts and credentials are not exception cases in production code. Named examples appear only in tests/fixtures, excluded from the npx package. Runtime uses built-in Node APIs and one HTML-parser dependency; no frontend framework, separate database server or AI API is needed.
