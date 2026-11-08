# Security policy

## Supported boundaries

The **Operations Studio is a local-first single-company application**, not an authenticated public SaaS endpoint. Its admin URL contains an ephemeral capability token in the URL fragment and the admin HTTP API binds to `127.0.0.1`. Do not expose that port publicly. Corporate remote access requires an independently secured SSO/TLS gateway and authorization design. Signed Slack webhooks are a separate endpoint.

The company must provide `OPS_AGENT_MASTER_KEY` outside Git. With that key, imported source records, business findings/action plans and vault items are encrypted at rest (AES-256-GCM). The master key is not stored inside the app's SQLite files; losing the key makes stored data unrecoverable. Unencrypted provider connection metadata, audit labels, Slack user IDs and job identifiers remain sensitive to employees and must be secured with OS ACLs and appropriate retention. `--demo` uses synthetic records and may leave demo metadata on disk.

## Credentials and external AI

Do not submit real API keys, refresh tokens, credentials, passwords, private account exports, employee details or customer PII to public GitHub branches/issues/CI logs. Never copy company API keys into AI prompts or plans. Providers are configured through the trusted vault or environment, and the agent only sees capability metadata. An optional AI SDK sends bounded **schema field statistics** by default, not raw company records. Review provider terms, retention, consent and data residency before enabling model use.

## Operations and approval

Every side-effect tool needs explicit scopes, a deployed verified connector, a named approver, immutable plan authorization, an independently checked postcondition, and an audit receipt. Incidentally successful API requests are not necessarily business-correct. Source snapshot changes or permission revocation block execution. On unclear external outcomes, the durable queue quarantines the action rather than guessing or blindly replaying it.

## Report a vulnerability

Use GitHub's **Private Vulnerability Reporting** if enabled for this repository. Otherwise contact the maintainers privately through an established secure channel. Do **not** create a public issue containing a working exploit, customer exports, API keys or environment configuration. Include the affected release, minimal synthetic reproduction and business impact. Rotate or revoke a disclosed credential immediately; deleting a commit alone does not invalidate it.

## Third-party services

The provider catalog includes **connection templates**, not attestations that all providers are production-ready. Slack, generic REST, OAuth/PKCE and MCP integrations use isolated local/synthetic tests. Your organization must validate provider-specific permissions, callback auth, OAuth consent, retention policies and the intended source of truth before production use.
