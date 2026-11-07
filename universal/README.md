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
