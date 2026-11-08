# Runbook: Local-first deployment and demo verification

## Quick demo (no secrets)

```bash
npm ci
npm run ops:demo
```

The localhost URL printed in the terminal includes a one-time session access token in the URL fragment. Keep it private. The demo creates two **synthetic in-memory** sources (`demo_crm`, `demo_erp`) and enables three sandbox-only capabilities, including `demo.update_customer`. It cannot access actual business accounts. Closing the app discards ephemeral source rows; fake review journal metadata may persist in the default demo directory.

In the UI, select `Data sources` → compare `demo_crm` and `demo_erp` on `id`; compare `status:status, parent_id:parent_id`. Open the resulting finding, select **Investigate**, author a plan using `demo.update_customer`, review the exact arguments, then select **Approve… → Confirm & execute**. View the durable worker receipt under Activity. No real provider receives a request.

## Company-owned configuration

1. Generate a secure 256-bit master key via your secrets platform. Inject it as `OPS_AGENT_MASTER_KEY`, a 64-character hex value. Do not store the master key inside the application's persistent data folder or Git.
2. Assign `OPS_AGENT_TENANT` (for example `acme_company`). Use a separate `OPS_AGENT_DATA_DIR`, master key and OS identity for each company/tenant. The built-in SQLite implementation is single-host, not a multi-tenant shared cloud cluster.
3. Set `OPS_AGENT_ADMIN_SCOPES` to exactly the scopes allowed for the local administrator, separated by commas. The UI allows configuring more roles, but it cannot bypass the server's admin-scopes allowlist.
4. Run `npm run ops:start` and open the local URL. The master key is required in company mode, ensuring data snapshots and finding journal entries are encrypted at rest.
5. In Integrations, configure the verified provider endpoint, vault key, OAuth client if needed, read-only test path, declared REST tool and reviewer policy. Verify in the provider's sandbox before enabling writes. The system will not automatically enable every discovered MCP tool.
6. Optional AI: `npm install --prefix universal/ai`, then in the UI choose the exact model ID your API account supports, provider and `vault://`/`env://` key reference. The AI only receives schema statistics by default.
7. Optional Slack callbacks: inject `OPS_SLACK_BOT_TOKEN_REF`, `OPS_SLACK_SIGNING_SECRET_REF`, `OPS_SLACK_TEAM_ID`, `OPS_SLACK_CHANNELS` and `OPS_SLACK_WEBHOOK_PORT`. Terminate public TLS at a secure reverse proxy and expose **only** `/slack/interactions` to the callback port. Do **not** proxy the privileged Studio port to the internet without a separately audited SSO gateway.

## Port and keys

| Variable | Example / meaning |
|---|---|
| `OPS_AGENT_PORT` | Studio localhost port, default `4321` |
| `OPS_AGENT_DATA_DIR` | Private SQLite and journal directory |
| `OPS_AGENT_MASTER_KEY` | Required in company mode; use your secret manager |
| `OPS_AGENT_TENANT` | Single isolated company namespace |
| `OPS_AGENT_ADMIN_SCOPES` | Explicit administrator action scopes |
| `OPS_SLACK_WEBHOOK_PORT` | Signed Slack callback listener; disabled without Slack configuration |
| `OPS_AI_PROVIDER` / `OPS_AI_MODEL` / `OPS_AI_SECRET_REF` | Optional legacy environment fallback; IT UI settings take precedence |
| `OPS_AI_ALLOW_APPROVAL_CONTEXT` | Explicit opt-in for AI review-summary Q&A when using environment configuration |

The provider token itself is never put into an integration manifest. A `vault://...` reference is encrypted by the app and protected by the external master key; an `env://...` reference resolves within the trusted process only. OAuth PKCE callback for a local registered client is `http://127.0.0.1:4321/oauth/callback` when the default port is used. Different OAuth providers have different redirect registration and consent rules.

## Security acceptance checklist before any real writes

- [ ] Org's identity gateway, network policy and TLS evaluated; privileged Studio remains private
- [ ] Master key backed up separately, private SQLite data folder encrypted/backed up, retention policy defined
- [ ] No keys, customer exports, call transcripts or approval URLs committed to Git, issues or CI artifacts
- [ ] Provider/OAuth app installation and least-privilege scopes approved by IT
- [ ] Target system owner explicitly confirms source-of-truth semantics and permissible correction strategy
- [ ] Sandbox read/write/read-back tests pass for the exact provider version and role
- [ ] Wrong tenant, invalid signature, stale evidence and replay/duplicate approval tests pass
- [ ] Manager can inspect real evidence and exact before/after consequences before confirm
- [ ] Error recovery documented for partial external execution, network outages and lost API responses
- [ ] Monitoring, alerting, admin access review and incident response arranged

This repository's CI tests and browser screenshot capture run against **synthetic fixtures only**. They do not certify a particular organization's Slack/CRM/OAuth deployment.
