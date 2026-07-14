# MISSION SPEC — GW-CUTOVER: traffic onto the in-process IR transport

Successor to gw-refactor (PR #752, deployed 2026-07-14). Goal: real traffic flows
through the IR pipeline (client → policy → egress adapter → provider → parser),
`LLM_DIRECT_FALLBACK=0` becomes reality, and legacy ai-SDK provider calls are
deleted. Architecture decision already made: IN-PROCESS transport, no external
gateway (claude-oauth subscription auth cannot ride one).

## Non-negotiable rules (inherited + new)

1. Branch `gw-cutover` in an INDEPENDENT CLONE (never a worktree — prod's
   auto-fix automation steals checkouts; keep the pre-commit branch guard).
2. FAIL-OPEN for users: any transport error before cutover-flag flip falls back
   to legacy within the same call. After flip: policy retry pre-first-token only.
3. Ramp per-caller, background first. The agent (user) lane moves LAST.
4. `pnpm build && pnpm test && pnpm lint` green before every commit; conformance
   goldens extended, never weakened.
5. claude-oauth token refresh must stay SINGLE-FLIGHT shared with legacy path
   (the #457 refresher-collision class — one refresher, not two).
6. Never restart prod outside deploy steps; staging soaks in the clone.

## PHASE 0 — Transport core (non-streaming)

- `src/llm/transport.ts`: `callIR(ir: IRRequest): Promise<IRResponse>` —
  resolveAlias → provider family (anthropic-shaped: `anthropic/`, `claude-oauth/`;
  else openai-compat incl. xai/groq/deepseek/ollama/custom baseURLs) →
  egressAnthropic/egressOpenAI → authed fetch → parse*Response → IRResponse.
- Auth: `getProviderApiKey()` for API-key providers; claude-oauth via the
  existing manager in `src/llm/legacy/claude-oauth-manager.ts` (reuse, do not
  fork; port `sanitizeOAuthToolName` — the reserved `mcp_` prefix 400 class).
- Wrap every call in `runWithPolicy` (route = `<family>:<endpoint>`, caller,
  priority from IR); full `llm_calls` row (real ir_request/ir_response — retire
  the `{legacy:true}` summary shape), wire_payload_sha256.
- Thinking blocks: extend IR v1 with an optional `thinking` block (A15 debt) —
  passthrough, never silently dropped for opus/fable models.
- DoD: unit tests with mocked fetch for both families ×
  (text/tools/tool_result/response_schema/errors incl. 429→policy retry,
  200-garbage→provider_bug); conformance transport goldens vs a local mock server.

## PHASE 1 — Streaming

- `streamIR(ir): AsyncIterable<IRStreamEvent>` using parseAnthropicSSE /
  parseOpenAISSE machines; ttft_ms captured; Rule 4 enforced by the machines'
  firstTokenEmitted (retry only before first event; after: terminal
  stop_reason 'error', never re-stream).
- OpenAI trailing-usage contract: transport calls machine.end() at [DONE].
- DoD: golden SSE scripts replayed through the transport (happy, truncation,
  abort, tool-args accumulation); no unhandled rejections under injected faults.

## PHASE 2 — Brain integration behind ramp flag

- In `Brain._callSingleModel` / `stream`: when `LLM_IR_CALLERS` matches the
  request source (comma list or `*`), build IR via `brainRequestToIR` (exists,
  shadow-proven 0/341), call transport, map IRResponse back to the legacy
  result shape (inverse of resultToIR — write + test it). Everything else
  (failover profile loop, cooldowns, billing recorder) UNCHANGED — the swap is
  strictly the per-attempt wire call.
- Same-call fallback: transport throw (non-policy-terminal) → legacy attempt,
  log `ir_transport_fallback` — users never see the difference during ramp.
- Priority set on all rows; noteTraceForSession wired (markOutcome goes live).
- DoD: full suite green; brain harness test proves byte-equivalent results
  legacy vs IR on mocked providers; LLM_SHADOW row comparisons stay 'match'.

## PHASE 3 — Ramp + soak (staging clone → prod)

- Staging soak `LLM_IR_CALLERS=health,consciousness` 24h (or operator-waived
  accelerated review): zero unhandled rejections, error_class rates ≤ legacy
  baseline, latency p50 within 10%.
- Prod ramp, one deploy per step: background callers → verifier/cron → agent.
  Per-step gate: `SELECT error_class, COUNT(*)` on llm_calls + cache_pct ≥
  baseline (64.6% daily / 88.4% warm) + no ir_transport_fallback storms.
- DoD: `LLM_IR_CALLERS=*` on prod 48h clean; CUTOVER_REPORT.md committed.

## PHASE 4 — Flip + legacy quarantine + deletion

- Default flips: IR transport is the path; `LLM_DIRECT_FALLBACK` retired
  (fallback = legacy code path only via explicit `LLM_LEGACY_FORCE=1`).
- One week quarantine, then delete `src/llm/legacy/` + shims + brain's ai-SDK
  call path in a single commit (original spec's deletion clause). ai-SDK deps
  removed from package.json if nothing else imports them (CHECK: coder tools
  arsenal/swarm/codex still use getModel+streamText — they migrate to chatIR in
  this phase or keep a documented exception).
- DoD: provider grep AND ai-SDK-import grep clean outside src/llm; suite green;
  npm release cut per updater-safe order (merge → pull+restart → publish).

## Known risk register (from gw-refactor evidence)

- claude-oauth: reserved `mcp_` tool prefix (#685), refresher collision (#457),
  streaming-first headers behavior (SUDO_BRAIN_OAUTH_STREAM_DISABLE parity).
- Thinking blocks currently dropped by parseAnthropicResponse (A15) — Phase 0 fixes.
- grok-4.5 reports no cached tokens — cache assertions only on anthropic routes.
- Coder tools bypass brain (getModel+streamText direct) — inventory says 5 sites.
- prompt-cache parity: cache_control injection must produce byte-identical
  boundaries via egressAnthropic as via legacy buildCachedSystemMessages
  (conformance golden pins this).

## Estimated shape

~4 sessions of work + 2 soak windows. Phase 2 is the delicate one (brain seam);
Phase 4 is bulk deletion. Everything else is additive and testable offline.
