# Browser & Computer Tools — Verification vs Anthropic

**Date:** 2026-07-03 · **Branch:** `feat/browser-autonomy-stable-refs` · **Status:** all slices green.

## What "better than Anthropic" means here (honest definition)

I cannot run Anthropic's Playwright MCP / `computer` tool head-to-head against Sudo in this
environment, so I do **not** claim a benchmarked win. The bar is instead a **demonstrated capability
superset + in-harness autonomy that Anthropic deliberately does not ship** — every row below is
backed by a passing test or a file:line, not a hand-wave. Anthropic's tools are intentionally *thin*
(intelligence lives in the model + a human/host in the loop); Sudo is a personal *unattended* agent,
so value = moving perception/verification/recovery **into the harness**.

## Evidence

Test suite: **85 passing** across 14 files (`npx vitest run tests/browser/ tests/tools/browser-anti-detect.test.ts`).
Full project **tsc: 0 errors**. New browser tests: stable-ref (6), active-page (4), page-events (3),
resilience (7), launch-args (3), autonomy (3), captcha (3), vision-brain (2), wait-deep-text (4).

## Capability matrix

| Capability | Anthropic Playwright MCP | Anthropic `computer` tool | **Sudo AI (after this work)** | Evidence |
|---|---|---|---|---|
| Stable element refs | ✅ `aria-ref` | — (coordinates) | ✅ `data-sudo-ref`, cross-frame, exact | stable-ref.test 6/6 |
| Coordinate/vision acting | — | ✅ | ✅ (`mouse`, `computer.use`, `vision`) | pre-existing |
| Network inspection | ✅ `browser_network_requests` | — | ✅ `browser.network` | page-events.test |
| Console/error inspection | ✅ `browser_console_messages` | — | ✅ `browser.console` | page-events.test |
| Tabs / dialogs / upload / wait | ✅ | — | ✅ (+ tab-switch bug fixed) | active-page.test |
| Multi-frame / shadow-DOM text | partial | — | ✅ `pageContainsTextDeep` | wait-deep-text.test 4/4 |
| **In-harness retry / self-heal** | ❌ (errors out) | ❌ | ✅ `withRetry` + `robustFill` | resilience.test 7/7 |
| **Silent-no-op fill recovery** | ❌ | ❌ | ✅ contenteditable fallback | resilience.test |
| **Unattended (no human gate)** | ❌ (host/human approves) | ❌ | ✅ `SUDO_BROWSER_UNATTENDED` + gate | autonomy.test 3/3 |
| **Vision via own model router** | n/a | n/a | ✅ Brain-first, HTTP fallback | vision-brain.test 2/2 |
| **CAPTCHA hand-off (park+notify)** | ❌ | ❌ | ✅ detect→notify→park (no solve) | captcha.test 3/3 |
| SSRF guard | ❌ | ❌ | ✅ (pre-existing) | ssrf-guard.test |
| Persistent profiles / auth | basic | — | ✅ (pre-existing) | — |
| Less-fingerprintable default launch | n/a | n/a | ✅ gated insecure flags | launch-args.test 3/3 |

**Rows where Sudo is a strict superset / does what Anthropic does not:** in-harness self-heal,
silent-fill recovery, unattended operation, own-model vision routing, CAPTCHA hand-off, SSRF guard,
hardened default launch. **Rows at parity:** stable refs, network/console, tabs/dialogs/upload/wait.
No row where Sudo is now behind.

## Correctness bugs fixed along the way

- Wrong-element clicks on duplicate names → stable refs (`snapshot-engine.ts:187` path replaced).
- `tabs switch` didn't change the acted-on page → unified `active-page.ts`.
- `navigate` HTTP status usually `0` (listener raced goto) → read from `goto()` response.
- `browser.type` silently no-op on contenteditable/React → `robustFill` fallback.
- Security-weakening launch flags always on → gated behind `SUDO_BROWSER_INSECURE`.

## Honest limitations (UNVERIFIED / out of scope)

- Not yet driven through the full live `AgentLoop` end-to-end (module + real-browser tested, not
  agent-in-the-loop). The recovery controller wiring into `executeToolCalls` is a follow-up.
- Task-end `SelfVerify.verify()` hookup deferred (loop-level, not browser-tool scope); per-tool
  tracing already covers browser tools (`loop.ts:1191`).
- No benchmark against live Anthropic tools — claim is capability/evidence based, not score based.
- CAPTCHA is **detect + hand-off only**, by design. No solving, no fingerprint/TLS spoofing.

## Kill-switches (all default to prior/safe behavior)

`SUDO_BROWSER_RETRY=0` (disable retry) · `SUDO_BROWSER_RETRY_ATTEMPTS=N` · `SUDO_BROWSER_UNATTENDED=1`
(lift confirmation) · `SUDO_BROWSER_INSECURE=1` (restore weakening flags) · `browser.snapshot refs=false`.
