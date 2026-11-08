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

## Universal Operations Agent connectors

Please start with [Architecture](docs/OPS_ARCHITECTURE.md) and [Connector certification](docs/OPS_CONNECTORS.md). Use `npm run ops:test` and the full `npm test` CI matrix. A source adapter can read arbitrary schemas, but must not silently transform unknown fields into company-authoritative facts. An action connector must verify permissions and postconditions and must not blindly retry ambiguous external writes.

The repository includes a **synthetic** public demo. Use test domains, generated IDs and fake manager accounts in tests. Do not file screenshots containing bearer tokens, real company account data, private calendars, or customer contact information.

Ask contributors to create a topic branch, include tests and a written threat model for any new integration, and open a PR for review. Never automatically merge AI-generated connector code without human code review and sandbox verification.
