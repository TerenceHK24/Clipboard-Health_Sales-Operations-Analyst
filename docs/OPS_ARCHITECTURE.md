# Universal Operations Agent — Architecture

## Components

| Component | Path | Responsibility |
|---|---|---|
| Discovery engine | `universal/discovery/engine.mjs` | Schema profiling, explicit mapping suggestions, duplicate-ID, sparse-field, relationship-cycle, numeric-outlier, cross-source mismatch and schema drift signals |
| AI SDK wrapper | `universal/ai/ai-sdk-agent.mjs` | OpenAI/Anthropic BYOK structured hypotheses and plan proposals with no LLM write tools |
| Generic data source | `universal/platform/sources.mjs` | JSON import / REST read, per-tenant snapshots and version fingerprints; encrypted at rest with a master key |
| Approval kernel | `universal/core.mjs` | Runtime-only capability registry, evidence-supported discoveries, two human decisions, exact-plan approval and read-back verification |
| IT policy | `universal/admin/policy-store.mjs` | Connection registry, role/scopes, approved capabilities and provider/model configuration |
| Secret vault | `universal/platform/vault.mjs` | AES-256-GCM encrypted credential values; master key never stored in code or DB |
| OAuth | `universal/platform/oauth.mjs` | PKCE browser setup, token exchange, refresh and revoked-credential handling |
| REST action SDK | `universal/connectors/templates.mjs` | Declarative fixed-URL action manifest, validated inputs, scope-bound execution, independent GET readback |
| MCP | `universal/adapters/mcp.mjs` | Register only IT-approved tools from a trusted installed MCP SDK client |
| Slack | `universal/adapters/slack-workflow.mjs` | Rich Block Kit, signed callbacks, manager scope check, second confirmation |
| Durable queue | `universal/platform/queue.mjs` | Persist decision intent before Slack ACK, at-most-once dispatch with uncertainty blocking |
| Operations Studio | `universal/studio/*` | Local-only IT, data source, findings, plan approval, activity and connector UI |

## Decision protocol

**Decision 1** (Investigate / Monitor / Dismiss) changes only the review lifecycle. It does *not* give the agent permission to edit anything.

**Decision 2** chooses a proposed exact plan. A reviewer authorizes or rejects that specific plan, including tool IDs, arguments and required scopes. No predetermined final outcome is built into the engine; a plan might involve updating a CRM, notifying accountants, reconciling a document, or making a multi-step request. Unsupported tools cannot be proposed. Write executors never receive raw model credentials and must independently verify their postcondition.

### Consistency safeguards

- Source evidence refs are pinned to a SHA-256 snapshot fingerprint; replacing the data invalidates previous references.
- The runtime checks tool registry, tenant identity, schema validation, scopes, active connection state, role and plan digest.
- The executor repeats live authorization checks before each action. Revocation between steps stops remaining operations.
- A `sent` operation is journaled before invocation. On uncertain network outcomes, no automatic replay occurs. A human must reconcile and explicitly authorize a recovery strategy. Some provider APIs lack transactions and idempotency keys; global exactly-once semantics cannot be guaranteed.
- A Slack callback persists approval intent **before** sending HTTP ACK. The durable worker processes it later and reevaluates role and scopes. Interrupted `running` jobs are quarantined, not replayed.

## Schema adaptation

Data sources describe arbitrary object records. Profiles automatically infer field types, null frequency, cardinality, sample uniqueness and probable semantic roles. Suggested mappings are *hypotheses*. Two source snapshots are reconciled only after an IT/user selects identity keys and paired fields, so a model never silently decides that `owner_ref` equals a legal entity's `parent_id`.

AI novel discovery operates on permitted schema statistics by default. It can propose anomalies not hard-coded in the deterministic library, but each output must cite existing evidence references. Admin-approved custom connectors or MCP clients can provide more context under organization policy; their data classifications require a separate security review.

## Limits

Local-first reference deployment uses Node.js built-in SQLite; multiple replicas sharing one SQLite file on a network volume are not a supported cluster configuration. The web console binds only to `127.0.0.1`; an organization must add SSO, TLS, network policy and enterprise audit/retention controls before a remote multi-user rollout. The Slack callback listener is a separate signed endpoint. UI documentation intentionally differentiates `adapter`, `generic-rest`, `template` and `sdk-needed` provider catalog states.
