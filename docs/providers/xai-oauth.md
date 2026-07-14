# xai-oauth — subscription OAuth Grok (Responses API)

Provider prefix: `xai-oauth/` (e.g. `xai-oauth/grok-4.3`). Rides the gw-cutover
IR transport as family `xai-responses` against `https://api.x.ai/v1/responses`
(`XAI_RESPONSES_URL` in `src/llm/endpoints.ts`). Route/breaker key:
`xai-oauth:responses` — an OAuth outage never opens the API-key `xai:chat`
breaker, and vice versa.

## Login (headless device flow)

```
sudo-ai xai-oauth login     # prints a verification URL + user code
sudo-ai xai-oauth status    # connected / expiry / needs-relogin
```

Open the URL on any browser (phone is fine), enter the code, approve. Tokens
are persisted atomically with mode 0600 to `<DATA_DIR>/xai-oauth.json`. No
browser is needed on the host.

## Token rotation + multi-process safety

- Access tokens last ~6h; the manager refreshes when within **1h** of expiry.
- **xAI rotates the refresh token on every refresh.** Two concurrent refreshes
  invalidate each other, so every refresh runs under BOTH a cross-process file
  lock (`xai-oauth.json.lock`, stale-steal after 30s) and an in-process
  single-flight promise. Rotated tokens are persisted BEFORE first use.
- If the refresh token dies (`invalid_grant`), the store is flagged
  `needs_relogin` and every call fails with class `auth` and the message
  `run \`sudo-ai xai-oauth login\`` — nothing retry-loops.
- Never run a second refresher implementation against the same store file.

## Quota

Usage draws from the **subscription's weekly pool**, shared with Grok Build /
grok-cli usage on the same account. There is no per-token metering visible to
this daemon; a 429 honors `retry-after` via the standard policy classes.

## personalOnly — hard rule

`xai-oauth/` is the OWNER's personal subscription and must be unreachable from
non-owner/public paths:

1. **Transport guard (implemented):** `prepareWireCall` refuses any IR with
   `extra.untrusted === true` targeting `xai-oauth/` (`invalid_request`,
   "xai-oauth is personalOnly"). Both `callIR` and `streamIR` pass through it.
2. **Upstream gating (relied upon):** no untrusted ingress currently sets that
   flag automatically — enforcement for hook/webhook/email/community callers
   relies on the existing isOwner gating: those paths run with tool
   allowlists/deny sandboxes that never include model-routing tools, and model
   selection (`config/sudo-ai.json5` failover chain, `LLM_ALIAS_*`) is
   operator-controlled config, not caller input. If a future ingress path lets
   non-owner input choose a model alias, it MUST set `ir.extra.untrusted = true`.

## Error classes

- **401** → class `auth`, message hints `sudo-ai xai-oauth login` (token
  rejected/expired beyond refresh).
- **403** → class `auth` with `extra.tier_gated = true`: the subscription tier
  is **not allowlisted** for OAuth inference (the Phase-0 probe's documented
  gate). Use the `XAI_API_KEY` path (`xai/` prefix) instead — re-login won't fix it.
- **429** → `rate_limited`, standard retry-after handling.

## Models

- `grok-4.3` — default / recommended.
- `grok-4.1-fast` — cheaper/faster tier (documented; same endpoint).

## Prompt caching

Routed via the `x-grok-conv-id` header: set from `ir.extra.conv_id` when
present (brain threads `request.sessionId` into it), else the call's
`trace_id`. Stable session ids therefore get cache hits across turns
(`usage.cached_in` from `input_tokens_details.cached_tokens`).

## Reasoning replay gotcha

Responses from this endpoint can contain `reasoning` items; the parser maps
them into IR `thinking` blocks (so they are logged/visible). On **replay** the
egress adapter STRIPS all thinking/reasoning history — replaying encrypted
reasoning items to `/responses` returns 400.

Structured output (`response_schema` → `text.format` json_schema) is emitted
per the OpenAI Responses spec that xAI mirrors, but has not been live-verified
against xAI — treat as best-effort.

## Adding to the failover chain

In `config/sudo-ai.json5` `models.primary` (order = failover order):

```json5
{ id: 'xai-oauth/grok-4.3', contextWindow: 256000, maxOutputTokens: 8192, temperature: 0.7 },
```

A commented example line is already in place. Deploying it is an operator
decision — remember the weekly-pool quota is shared with interactive Grok use.

## Verified model availability (live sweep, 2026-07-14)

| Model | Status | Note |
|---|---|---|
| `grok-4.3` | ✅ | default; main reasoning model |
| `grok-build-0.1` | ✅ | coding-agent model |
| `grok-4.20-0309-reasoning` | ✅ | |
| `grok-4.20-0309-non-reasoning` | ✅ | |
| `grok-4.20-multi-agent-0309` | ✅⚠ | ~50x token burn per call (internal fan-out bills the weekly pool) — never put in a failover chain |
| `grok-4-fast-non-reasoning` | ✅ | cheap/fast tier — good failover entry |
| `grok-4.1-fast` | ❌ 400 | model does not exist on this surface |

Recommended chain entries: `xai-oauth/grok-4.3` then `xai-oauth/grok-4-fast-non-reasoning`.
