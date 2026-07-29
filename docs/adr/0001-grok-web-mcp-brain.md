# ADR 0001 — grok-web-mcp: free grok brain with native tool-calling

Status: Accepted (implementation in progress) · Date: 2026-07-25 · Branch: feat/grok-web-chat-brain

## Problem

We want a FREE brain (grok.com app-chat lane, SuperGrok weekly pool, zero api.x.ai
billing) that can reliably call sudo-ai's tools. Prompt-emulated tool-calling on this
lane is DISPROVEN (consumer persona narrates/refuses — this caused a live hallucinated
"browser tool executing…" reply). The only reliable free path is grok's NATIVE MCP
connectors: grok's cloud calls a PUBLIC MCP server directly and drives the tool loop
server-side, returning a final grounded answer. Proven browserless this session with an
un-forgeable per-boot token (grok's cloud logged a real `tools/call`). The missing piece
vs earlier failures was a per-user CONNECT step (`POST /rest/oauth/auth-url` →
`authValid:true`) after team-scope `connectors/create`.

## Alternatives considered

1. **Per-step IR model** (grok returns synthetic `tool_use`, sudo-ai executes, feeds
   back). IMPOSSIBLE on this lane — app-chat has no way to return a tool result into an
   in-flight turn; grok owns the loop and streams a final answer.
2. **Metered cli-chat-proxy** (OpenAI-style inline function-calling). Works but BILLS
   (~$80/day) — money-guarded OFF. Rejected for the free-brain goal.
3. **Full OpenAI-compatible chat-proxy CLI** reflecting grok's tool-calls back to a
   client. General but fights the loop-ownership model; deferred as a separate engine.

## Decision

Model grok-web-mcp as a **full-turn executor** provider, not a per-step model:

- New alias `grok-web-mcp/grok-4`, distinct from the proven text-only `grok-web/grok-4`,
  so each reverts independently via `config/sudo-ai.json5 models.primary[]`. Default OFF;
  never in the default primary chain until it survives repeated nonce probes + a billing
  check.
- The IR call renders the transcript into one app-chat message, drives
  `app-chat/conversations/new` with `connectorIds`, and returns `stop_reason:'end_turn'`
  text — never synthetic `tool_use`. The outer ReAct loop is unchanged; tool execution
  for this turn is outsourced to grok, which calls our public MCP server.
- **Trust boundary = the public MCP server** (`src/core/gateway/mcp-public-server.ts`),
  a dedicated hardened `node:http` port fronted by a reverse proxy — NEVER the gateway
  router. Fail-closed guards:
  1. Explicit non-empty allowlist REQUIRED (no "all non-destructive" default).
  2. Readonly-only — every exposed tool must be `safety:'readonly'`; anything else aborts
     startup. Makes the trust-tier sandbox unnecessary by policy (no exec/file-write/shell
     reachable; memory-API/frozen surfaces stay off the wire).
  3. F18 injection-quarantine on grok-authored tool ARGS (deterministic score gate).
  4. Capability-token auth + stateless re-validation + SSE framing (mcp-http-transport).
- Connector lifecycle (create → **connect** → discover) is idempotent, run at bootstrap
  OUTSIDE the hot path; the provider learns `connectorId` + serverUrl via config/injected
  callback (hot-path invariant: `src/llm` never imports `core/gateway`/`core/gdrive`).
- F18 on grok's FINAL answer is applied at the provider seam via an INJECTED callback
  (src/llm cannot import core/gdrive).

## Tradeoffs / consequences

- No per-step approvals, doom-loop guard, or per-step telemetry for grok-driven turns;
  tool RESULTS are invisible to sudo-ai (only the final answer lands). Mitigation: readonly
  allowlist, log every MCP `tools/call`, claude failover behind the alias.
- Data egress: every exposed tool's output ships to xAI's cloud → zone-2-only tool
  outputs is a hard rule.
- Tool invocation is the model's non-deterministic choice; gate rollout on nonce probes.
- Rides an RE'd consumer surface (statsig mint, connector endpoints) xAI can break;
  keep it a flagged, explicitly-selected alias, replaceable (serverUrl is a plain param).

## Open decisions (gate the LIVE path, not the code)

- **Public HTTPS endpoint hosting** reachable by xAI's cloud (tunnel vs sudoapi.shop
  subdomain + nginx vs cloudflared). Prototype used tinyfi.sh.
- **Final-answer quarantine policy**: pass-through-with-high-risk-flag vs hard-block.
- **Billing verification** on MCP-tool traffic (console.x.ai) before any prod enable.
