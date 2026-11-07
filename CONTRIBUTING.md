# Contributing

Open-source contributions are welcome through GitHub issues and pull requests.

1. Open an issue describing the issue type, proposed new capability, expected evidence, and example (synthetic) records.
2. Put new connectors in `universal/adapters/`; never modify core matching logic just to add a vendor.
3. Use the generic `CapabilityRegistry` contract: capabilities must declare `read`/`write`/`notify`, validate inputs, and provide independent verification for writes.
4. Add unit tests and cases for missing fields, duplicate IDs, failed API operations, stale approvals, and safe reruns.
5. Run `npm test` and `npm run test:universal`; include tests in the PR.
6. Never submit actual API keys, auth tokens, workspace URLs, private emails, production customer data, real invoices, proprietary internal docs, `.env` files, SQLite journals or screenshots containing secrets.
7. Use fabricated examples (`example.test`, synthetic identifiers). Run secret scanning locally before push.

A maintainer reviews security-sensitive changes and approves deployment separately. Passing CI does not grant a connector permission to access production systems.
