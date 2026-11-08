# Universal SDK-based Agent Runtime (experimental)

This is an open-source-oriented extension of the Bellhaven reconciliation project, **not a replacement for the existing assessment CLI**. It does not depend on n8n/Zapier. The core accepts arbitrary enterprise tools through company-provided SDK connectors, direct REST adapters or MCP clients.

## Two business decisions; no fixed resolution tree

1. **Discovery decision:** Agent proposes an unusual pattern with evidence refs; user chooses investigate, monitor or dismiss. This does **not** install a permanent business rule or authorize any write.
2. **Resolution decision:** After the company selects or has the AI suggest a plan, a named reviewer explicitly approves the **exact actions, arguments and scopes**. Steps run only after approval. Tool and plan availability are based on the company's connectors, not a static list of remedies.

`GovernedAgentRuntime` has no hard-coded CRM data model, Slack channel, owner ID, or final business action. It manages proposals and authorization only. Connector authors implement executors for their systems. A review app or Slack adapter calls `decidePlan`; a backend worker calls `execute`. The model **never** calls a write executor.

## Try without credentials or internet

Node.js >=22.16:

```sh
node universal/examples/demo.mjs
npm run test:universal
```

The demo uses a **synthetic in-memory CRM** and a temporary local SQLite journal. No network, LLM, or real account data is used.

## Optional real AI SDK 7 provider

To run a real model with **your own API key**, rather than making the original Bellhaven CLI download AI libraries:

```sh
cd universal/ai
npm install
node example.mjs openai <model-id-you-have-access-to>
```

The key is requested in an interactive terminal with hidden input; it is not stored in a file, CLI argument, or environment variable. The model id is chosen by the company. `@ai-sdk/openai` and `@ai-sdk/anthropic` are optional SDK provider packages; other AI SDK providers can be registered by passing their model instance to `suggestDiscoveries`/`suggestPlans`. Model use incurs provider API charges. Only redacted or organization-authorized observations should be sent to an external model.

## Connect any CRM, database, or enterprise app

- `adapters/rest.mjs`: fixed allowlisted URL and HTTPS, company credential resolver at invocation time, no token in a plan.
- `adapters/mcp.mjs`: accepts a trusted MCP SDK client and explicit per-tool allowlist; *tool discovery is not tool authorization*.
- `adapters/slack.mjs`: Slack Block Kit request + signed callback verification; Slack user ID is passed into the company-specific `canApprove` policy.
- `core.mjs`: company-neutral `CapabilityRegistry`, SQLite journal, two decisions, exact-plan approval, single-attempt action execution and verification. Uncertain writes block rather than retry blindly.

Tool catalog names may be `crm.update_customer`, `erp.verify_invoice`, `slack.send_message`, `calendar.create_event`, `mcp.company.issue_ticket` or anything else installed with an executor and a test. No vendor platform is implied to be pre-connected.

## Slack manager approval in a real deployment

The organization installs a Slack app with `chat:write`, enables Interactivity, configures a public HTTPS callback, supplies its Bot Token and Signing Secret to its trusted deployment, and maps Slack `team.id`/`user.id` to its own company permissions.

The host calls `requestApproval({channel,findingId,planId,summary})`; Slack renders Approve / Reject. The callback handler uses **the unmodified raw request body** with `verifySlackRequest`, then `acceptAction`, which records Decision 2. The backend acknowledges Slack promptly and uses a durable worker to call `execute(findingId)`. Do not run external work inside Slack's short ACK deadline.

This reference adapter stores outstanding Slack one-time requests *in memory*. It is for demonstrating the protocol; production requires durable request storage, replay protection across restarts, an execution queue, OAuth lifecycle, audit retention, SSO/RBAC, and tenant isolation. There is **no hosted Slack endpoint**, Teams implementation, or live CRM write in this milestone.

## Security & limitations

- No API keys, credentials, or real tenant data in Git. Keys are provided by the company to the runtime in memory or via its own secret manager.
- The SQLite journal stores findings, planned tool inputs and audit events. These may contain sensitive **business** metadata even without keys; secure its filesystem and restrict access. Encrypt and configure retention in production.
- Runtime rejects obvious credential fields in model-generated action inputs. Sensitive-data redaction before AI inference requires organization-specific classification and policy; this example does **not** claim to solve DLP.
- Every write requires an authorization policy, declared scopes, verified read-back, and a stable selected plan. Unknown actions, unknown evidence references, and uncertain side effects fail closed.
- No tool may be auto-enabled just because a discovered MCP server advertises it. New connector scripts require review, isolation, dependency pinning and tests. Never execute AI-produced JavaScript directly in the host.
- The existing Bellhaven administrator integration must remain in the same branch for `npm test` to pass; watch CI for OS-specific issues.

See the top-level [CONTRIBUTING.md](../CONTRIBUTING.md) and [SECURITY.md](../SECURITY.md).


## Rich Slack approvals and local IT connection console (v0.2 preview)

A new **company-configurable, not hard-coded final remedy** approval surface is available in:

- `admin/policy-store.mjs`: per-tenant connection manifests, credential **references** (`vault://...`), enabled capabilities, roles, Slack user IDs, authorized scopes and auditable IT changes. A connection is *unverified* until a trusted provider-specific probe succeeds. No provider token is written to SQLite.
- `admin/console.mjs`, `admin/index.html`, `admin/admin.js`, `admin/admin.css`: loopback-only, locally authenticated IT web UI to configure connections, assign permissions and approvers, and run injected connector probes. The admin access key is ephemeral and in the local URL fragment, not a file.
- `adapters/slack-workflow.mjs`: rich Block Kit request with evidence preview, four actions (Approve, Reject, View evidence, Ask Agent), Slack-native **second confirmation** for Approve/Reject, modal follow-up, private answers, server-derived permission checks, immutable plan fingerprint, persistent one-use request IDs.
- `adapters/slack-receiver.mjs`: HTTP callback handler verifying Slack signed raw requests and acknowledging before background writes. Deploy behind HTTPS with a queue in production.

**To try the IT UI without connecting to any real organization:**

```sh
npm run universal:admin
```

The UI includes two **synthetic demo** capabilities. Configure provider `demo`, an ID such as `testcrm`, scopes `crm:read,crm:write` (optional `vault://demo/example`), save, and click Test to mark this **demo** connector verified. Enable a demo capability and add Slack manager IDs/scopes. Close the server with Ctrl+C. This does not deploy Slack, acquire an OAuth grant, run AI, or modify any CRM.

### Binding to real Slack / an external AI provider

1. A company admin creates a Slack App, enables Interactivity, configures its HTTPS receiver, and grants appropriate OAuth scopes (start with `chat:write`). Slack's signing secret and bot token are injected by a trusted runtime resolver or enterprise vault. **Never paste them into the Admin UI, CLI arguments, or source files.**
2. The host registers *tested* capabilities with `CapabilityRegistry`. An IT admin enables capabilities in the local console and maps Slack user IDs/roles/scopes to those capabilities. Configuring an API reference alone does **not** establish a working connection.
3. The host builds `RichSlackApprovalGateway`, supplies `CompanyPolicyStore`, `SlackApprovalStore`, the capability registry and allowlisted Slack channels. Call `publish({channel,findingId,planId,runtime})` only after Decision 1 has opted to investigate and the plan has been reviewed.
4. Slack renders rich Blocks and native confirmation dialogs. The Slack callback is verified using the **raw signed form body**; a company-resolved manager identity is required. The callback can open Evidence or Ask Agent modals without changing a CRM. An optional `answerQuestion` handler may use a company-configured AI SDK model with separately authorized, redacted evidence.
5. On confirmed approval, the gateway invokes the runtime's `decidePlan` after the HTTP response is acknowledged. A company-hosted durable worker invokes `execute` for exactly the approved steps, with each operation independently verified; provide `onApproved` to connect the worker. The demo test uses a synchronous mock worker after ACK, **not** a deployable queue.
6. Deploy with a durable job queue, hardened OAuth/webhook lifecycle, enterprise SSO, data-loss prevention and encrypted/managed business metadata storage. The Slack approval request database stores **identifiers and state only**, no credentials; unanswered questions are not persisted by this module. Real Slack and other platforms require verified installations before use.

The UI only configures authorization and **references** to connections. It deliberately does not claim to provide one-click OAuth installation for every provider. Native Slack interactive workflows and the IT console are currently reference implementations, not a hosted multi-tenant SaaS.

### Testing

```sh
npm run test:universal
```

Additional tests exercise rich Slack message composition, confirm controls, signature verification, view/ask modals, private follow-ups, reply replay rejection, exact-plan guard, durable request store, HTTP ACK order, tenant approval roles, admin console origin/authentication controls, provider probe policy, and secret suppression. All cases use synthetic local data and fake Slack APIs; no external credentials are required.
