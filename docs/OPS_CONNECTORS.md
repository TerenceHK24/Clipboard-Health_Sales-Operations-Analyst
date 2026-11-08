# Build, certify and install connectors

The system has a **capability-based integration model**. The agent only sees tool names, descriptions, modes and scopes; it never directly sees credentials or unrestricted network clients.

## A. Company-configured generic REST

In **Integrations**:

1. Enter the approved HTTPS **base URL**, a GET-only probe path, provider and connection ID.
2. Supply an encrypted `vault://department/service` secret or a preconfigured `env://OPS_SERVICE_KEY` reference. Do not paste raw credentials into a tool's arguments.
3. Run **Test connection**. It checks the provider's read-only endpoint and rejects HTTP 401/403/errors. Test success certifies only that endpoint at the time of the test.
4. Register a tool such as `crm.update_account` with `PATCH /accounts/{id}` and a GET read-back path `/accounts/{id}`. Create body and path arguments are structured JSON.
5. Turn it on in the capability policy and authorize only designated roles/scopes.
6. In a sandbox, test success, unsupported fields, permission revocation, stale evidence and a lost PATCH response. The executor only marks a write verified if the subsequent GET contains the approved body fields and values.

For `POST` creation a verified read-back URL must resolve from the result (for example `{id}` from the create response). If no safe verification endpoint exists, register a separate **notify** or **manual-review** capability rather than pretending an HTTP 202 guarantees delivery.

This generic adapter intentionally accepts fixed, IT-approved endpoints only. Arbitrary model-produced URLs, scripts or authentication fields are rejected.

## B. MCP SDK

Use `registerMcpCapabilities({registry,client,namespace,policies})` from `universal/adapters/mcp.mjs` with a trusted MCP client. Every tool must be explicitly allowlisted and classified `read`, `write` or `notify`, with input validation and independent postcondition verification for side effects. MCP `listTools()` is capability discovery, **not** permission to call every tool.

## C. Rich Slack approvals

The sample `RichSlackApprovalGateway` supports Slack `chat.postMessage`, `views.open`, signed interactive callbacks, second confirmation dialogs, evidence detail and ask-the-agent modals. Its queue integration persists the exact manager decision before acknowledgement, and the worker checks live IT permissions again. Configure your Slack App's signing secret, bot token, team and approved channels; use a trusted HTTPS callback path `/slack/interactions` forwarding only to the signed webhook receiver. Test with Slack's own developer workspace before company rollout.

## D. Office communication and business app templates

The catalog in `universal/platform/provider-catalog.mjs` describes Slack, Teams, Gmail, Outlook/Graph, Google Calendar, HubSpot, Salesforce, Xero, QuickBooks, Jira, MCP, REST and SQL systems. **Catalog presence is not operational integration.** The native Slack callback, generic REST and MCP interfaces are implemented and covered with mocks; Teams bot authentication, Gmail/Outlook OAuth scopes, Calendar writes, Xero accounting workflows and DB-specific drivers need their own certified plugin or declarative REST action.

The Google/Microsoft/HubSpot connector onboarding supports a generic OAuth authorization-code + PKCE client where the provider supports the configured local redirect URI and scopes. IT must register and approve the OAuth client with the provider. Some providers require HTTPS redirect URLs, tenant admin consent or additional registration: a company can instead use its already-authorized API token/vault workflow until its adapter is certified.

## Contribution contract

A new connector contribution must include: metadata (`id`, `description`, mode, scopes), a validator, permission and tenant boundary tests, a connector test probe, side-effect verification, failure modes (timeouts and unknown results), user-facing evidence provenance and usage examples. **No live tokens, emails, private URLs, screenshots containing real CRM data, or company exports** may enter Git. Add a synthetic HTTP fixture and a CI acceptance test. Review open PRs for SSRF, secrets in logs, overly broad scopes and prompt-injection surfaces.
