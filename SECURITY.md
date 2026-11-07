# Security Policy

**Never submit credentials in issues, commits, or public pull requests.** Remove secrets from screenshots and logs.

- Company keys are injected into trusted runtime processes; the model sees only tool metadata and sanitized observations.
- AI suggestions are untrusted data, never executable code or authorized instructions.
- All non-read operations must be individually validated, scoped, human-approved, journaled, and independently verified.
- Slack callbacks must pass HMAC signature verification, timestamp freshness, workspace identity, one-time request ID, and manager permission checks.
- Review logs and SQLite journal contain business metadata and must be protected by the operator. Encryption-at-rest, data retention, SSO/RBAC and central secret storage are deployment concerns.
- For security vulnerabilities, please use GitHub's private vulnerability reporting if enabled, or contact repository maintainers privately. Do not publish details or exploit code in a public issue.

The experimental universal-agent package is **not** a production security certification. Its Slack callback request map is memory-only and a production adapter needs durable delivery, HTTPS hosting, tenant identity binding, and reliable queue recovery.
