# Universal Operations Agent

**Open-source, self-hosted AI-assisted business data discovery and human-governed cross-system workflows.** Built from the [Bellhaven reconciliation project](https://github.com/TerenceHK24/Clipboard-Health_Sales-Operations-Analyst). It is a local-first product with an extensible SDK, not a Zapier/n8n dependency and not a hosted multi-tenant SaaS.

[Architecture](docs/OPS_ARCHITECTURE.md) · [Getting started](docs/OPS_DEPLOYMENT.md) · [Add a connector](docs/OPS_CONNECTORS.md) · [Security](SECURITY.md) · [Contribute](CONTRIBUTING.md)

## Run the complete working demo

Requires **Node.js >=22.16**, npm and Git. For a local demo containing only synthetic company data:

```bash
npm ci
npm run ops:demo
```

Open the **private localhost URL** printed in the terminal. The browser UI includes **Overview, Data Sources, Findings, Integrations, Governance and Activity**. No external AI key, SaaS account or website access is required to try the synthetic workflow.

- Select **Data sources**; the demo has `demo_crm` and `demo_erp`.
- Compare `id` to `id`, with field pairs `status:status, parent_id:parent_id`.
- Open a finding and click **Investigate** (Decision 1).
- Choose **Add custom plan**, using an enabled synthetic tool such as `demo.update_customer`; choose explicit arguments.
- Review the complete plan, click **Approve** and **Confirm & execute** (Decision 2).
- View the queued execution and verification in **Activity**. No real CRM or Slack is touched.

Additional commands:

```bash
npm run ops:test       # Universal SDK unit / integration tests
npm run universal:demo # Kernel-only synthetic workflow
npm run test:universal # Same universal tests
npm test               # Bellhaven + Universal (requires npm ci)
```

## Run with company-owned credentials

Configure a **64-character hexadecimal master key**, from your organization’s vault or secret-manager injection (do not commit or paste it into issues). On Unix-like systems a random key can be generated locally with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Retain the key outside the repository: losing it makes encrypted snapshots and credentials unrecoverable.

```bash
export OPS_AGENT_MASTER_KEY="<32-byte-hex-key-from-your-secret-manager>"
export OPS_AGENT_TENANT="your-company"
export OPS_AGENT_ADMIN_SCOPES="crm:read,crm:write,finance:read,notify:send"
npm run ops:start
```

On Windows set the same environment variables using Windows PowerShell or a managed secrets provider. `OPS_AGENT_DATA_DIR` optionally changes the private SQLite storage location. In company mode the master key is **required**: source records, discovery records and action arguments must not silently be stored unencrypted. The app never binds its privileged admin UI to a public interface.

From the **Integrations** tab IT can:

1. Configure a Slack, HubSpot, Gmail, Outlook, Salesforce, custom REST or other compatible connection manifest.
2. Add a vaulted API key/OAuth credential or an `env://VAR_NAME` reference; no secret is written to Git.
3. Optionally register a company-owned OAuth client and initiate OAuth authorization-code + PKCE (availability depends on provider loopback support).
4. Test the read-only API endpoint. A configuration is **not verified** merely because it was saved.
5. Install a declarative REST capability, define required scopes and enable it with authorized roles.
6. Set the AI provider/model and its own `vault://` or `env://` key reference. AI SDK dependencies are optional: `npm install --prefix universal/ai`.
7. Map Slack users to explicit roles and scopes, then publish rich approval cards for findings and tested plans.

**Real credentials and target-system accounts are not bundled.** The templates for other enterprise platforms are discovery/connection guidance, not a claim that their APIs were live-tested. See [verified versus template connectors](docs/OPS_CONNECTORS.md).

## How the agent works

```text
Any JSON / verified REST / MCP adapter / company SDK
      → schema profiling + deterministic anomaly discovery
      → optional AI SDK novel-hypothesis discovery (metadata-only by default)
      → Decision 1: investigate | monitor | dismiss
      → human- or AI-authored action plan from installed capabilities
      → Decision 2: inspect exact plan | approve | reject | request via Slack
      → persistent authorization queue + revalidation
      → verified, separately scoped tool execution + audit
```

**No fixed terminal remedy tree.** Companies configure their own tools, evidence authority, reviewer roles and exact action plans. Decision 1 never authorizes data modification. Slack cards provide Approve/Reject with native second confirmation, View Evidence, and Ask Agent. The same two-step confirmation is available in the local Dashboard.

For real Slack interaction, IT registers a Slack App with Interactivity and a company-owned HTTPS callback, stores bot token and signing secret via `vault://` / `env://` references, and sets `OPS_SLACK_TEAM_ID`, `OPS_SLACK_CHANNELS`, `OPS_SLACK_BOT_TOKEN_REF`, `OPS_SLACK_SIGNING_SECRET_REF`, and `OPS_SLACK_WEBHOOK_PORT`. **Only the signed webhook receiver** may be exposed through the reverse proxy; the privileged Studio must remain local or behind an independently authenticated company admin gateway.

The supported **generic REST source reader** intentionally stops at **3,000 JSON records** per response without explicit pagination. Large datasets need a provider-certified paginated connector. Matching requires explicit identity fields and field pairs; AI does not silently invent record identities or business truth.

## Known boundaries

- **Local-first self-hosted release**, not a security-certified hosted Enterprise SaaS. There is no bundled corporate SSO, centralized multi-tenant IAM or cloud KMS. Security review and company compliance checks are required before exposing any component to production traffic.
- A `verified` connection means its configured read-only probe succeeded; **not** that every action, required approval or target system's eventual write is guaranteed to work. Writes require independent read-back logic and test evidence.
- Production use requires appropriate provider registration, scopes, persistent company-managed master key, backups, live sandbox acceptance tests and a TLS reverse proxy for Slack callbacks. Apps without accounts/credentials cannot be live-certified here.
- The source importer does not support arbitrary HTML changes or every SQL provider out-of-the-box. These are added using documented connector adapters; the core is source-agnostic.
- The optional AI SDK only suggests findings and plans. It cannot execute tools or bypass permissions. Schema-only profiling is the default disclosure to external AI providers.

## Original Bellhaven assessment CLI (preserved)

The original `bin/bellhaven-scrape.js` still provides `scrape`, `scan`, `review`, and `status`, with the existing hidden **interactive** CRM token flow and approval-only CRM modifications:

```bash
node bin/bellhaven-scrape.js review
```

The Bellhaven assessment’s business-specific CHOW, duplicate and administrator rules are independent from the Universal SDK. Review its [specific documentation](docs/verification.md). Neither the universal demo nor its CI tests execute authenticated writes to Bellhaven's actual CRM.

License: **MIT**. By contributing a connector or workflow, you help the open-source community expand verified capabilities without publishing company secrets.
