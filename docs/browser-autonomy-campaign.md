# Browser & Computer Tools — Autonomy Campaign

**Goal:** make Sudo AI's browser + computer control tools *fully autonomous* — self-perceiving,
self-verifying, self-healing — so an unattended personal agent completes web tasks without a
human in the loop. Measured by **autonomous task-completion rate** and **actions-per-human-interrupt**,
not by any bot-detection "score".

**Non-goal (explicit line):** this campaign does **not** build fingerprint-spoofing, TLS/JA3
forgery, or CAPTCHA-*defeating* solvers to circumvent third-party anti-abuse controls. CAPTCHA
handling is detect → try legitimate paths (logged-in session, site-provided accessible/audio
alternative) → on hard block, notify the operator and park the task. Reliability, not evasion.

---

## Why (verification findings, 2026-07-02)

Full read of `src/core/tools/builtin/browser/*` + `computer-use*`. Defects cluster into five classes:

1. **No retry / self-heal (top blocker).** No tool retries a transient failure. `browser.click`
   / `browser.interact` emit a prose *"RECOVERY REQUIRED — call browser.snapshot"* string
   (`interact.ts:146`, `click.ts:115`) and offload reliability to the model.
2. **Silent-failure-as-success.** `browser.scrape` returns `success:true` with all-null fields
   (`scrape.ts:114`); `browser.auth` returns `success:true` for merely *submitting* the login form,
   no credential-acceptance check (`auth.ts:94`).
3. **Human-gates on a "fully autonomous" agent.** `computer.use` (`computer-use-tool.ts:82`) and
   `browser.auth` (`auth.ts:21`) are `requiresConfirmation:true` → stall unattended.
4. **Broken/inconsistent targeting.** Registered path re-resolves elements by role+name `.first()`
   (`snapshot-engine.ts:187`) — wrong-element on duplicate names. The richer `BrowserActionSuite`
   (`action-suite.ts`) targets `[aria-ref=...]` attributes **nothing sets** (grep-confirmed dead)
   *and* is never registered (orphan). 7 different addressing schemes across tools; `browser.snapshot`
   emits an ARIA tree with no actionable refs.
5. **Correctness / security.** `browser.tabs switch` doesn't change which page other tools act on
   (`bringToFront` ≠ reordering `pages()`); SSRF guard only on `navigate` (`fetch`/`download`/`tabs`
   unguarded); `browser.search` uses synchronous `execSync` blocking the event loop (`search.ts:122`);
   `browser.download` `waitForEvent` has no timeout (`download.ts:99`); no iframe/shadow-DOM in
   snapshot/wait; 6 dead `if(!instance)` guards; `navigate` HTTP status races its listener → usually `0`.

Also: `browser.vision` bypasses the `Brain` class (raw `fetch` to xAI/OpenAI, `vision.ts:18`) — no
shared failover, cost tracking, or Claude vision.

## vs Anthropic (what "10× for a personal agent" means honestly)

Anthropic ships **thin tools** (Playwright MCP: `browser_snapshot` + stable `aria-ref` targeting,
`browser_network_requests`, `browser_console_messages`; the coordinate `computer` tool; `str_replace_editor`;
`bash`) and deliberately leaves intelligence to the **model + a human/host in the loop**. Sudo is a
personal *unattended* agent, so the win is **moving that intelligence into the harness**: stable
perception, self-verification, self-healing. Sudo already has profiles, an SSRF guard, and a CAPTCHA
detector the MCP lacks — the gap is reliability + autonomy, not spoofing.

---

## Reuse map (existing infra to build on, not reinvent)

- **ConfidenceGate** `src/core/agent/verify-gate.ts` — `evaluate(toolName)`; `SUDO_VERIFY_GATE=1`.
- **SelfVerify** `src/core/agent/self-verify.ts` — post-task `verify(goal, files, cwd)`.
- **StuckDetector** `src/core/agent/stuck-detector.ts` / **DoomLoop** `doom-loop.ts` — already
  instantiated in `loop.ts:2328,2803`.
- **Executor seam** `executeToolCalls(...)` `src/core/agent/loop-helpers.ts:857` — already threads
  `verifyGate`, `brain`, `hooks`. Retry/escalation belongs here.
- **Brain (vision-capable)** `src/core/brain/brain.ts:647` `call(BrainRequest)`; `BrainMessage.images`
  (`brain/types.ts:51`) accepts base64 screenshots.
- **TraceStore** `src/core/learning/trace-store.ts:283` `recordToolCall(...)`; screenshots already
  flow into `AgentRunResult.attachments` (`loop.ts:1083`).
- **Operator hand-off** `comms.notify` `src/core/tools/builtin/comms/notification.ts:185`.

## The control loop

`perceive (stable-ref snapshot + screenshot) → act (by ref) → verify (state changed?) →
self-heal (re-snapshot, re-match, retry, alt strategy) → escalate (ConfidenceGate/StuckDetector →
comms.notify + park)`. Attach a `BrowserRecoveryController` onto `AgentLoop` the way gates attach
(`loop.ts:798-838`); enforce inside `executeToolCalls`.

---

## Phases

**Phase 1 — Perception that doesn't lie.**
1. **Stable refs (THIS SLICE).** `stable-ref.ts`: stamp `data-sudo-ref` on interactive elements
   (across frames) via one `page.evaluate`; emit ref-annotated snapshot; resolve ref → Locator by
   attribute. Wire into `browser.snapshot`; add optional `ref` param to `browser.click` / `browser.type`.
2. Unified, tab-aware active-page resolver (kill the 3× duplicated CDP round-trips; fix `tabs switch`).
3. iframe / shadow-DOM traversal in snapshot + wait.

**Phase 2 — Actions that self-heal.**
4. Retry/backoff wrapper; on stale ref → auto-re-snapshot → re-match by role+name+nearby-text → retry.
5. Post-action verification (URL/DOM/value delta); convert silent-success into real success/failure.

**Phase 3 — Un-gate for autonomy, safely.**
6. Replace `requiresConfirmation` on `computer.use`/`auth` with ConfidenceGate + Stuck/DoomLoop escalation.

**Phase 4 — Vision & CAPTCHA through the Brain.**
7. Route `browser.vision` through `Brain.call` (`BrainMessage.images`).
8. CAPTCHA detect → legitimate paths → `comms.notify` + park (no evasion solver).

**Phase 5 — Observability.**
9. `browser.network` + `browser.console` over `CDPManager.interceptRequests`.
10. Persist attempts/verdicts via `TraceStore`; close with `SelfVerify.verify()`.

**Phase 6 — Security/stealth own-goal.**
11. Gate `--disable-web-security` / `--no-sandbox` / `--allow-running-insecure-content`
    (`browser-manager.ts:223`) behind explicit opt-in; default hardened (also less fingerprintable).

## Delivery

~8 stacked PRs, Phase 1→2 first (the real reliability jump), each with a **real end-to-end browser
test** (not just unit). Kill-switch env per slice where behavior changes.

## Status

- [x] Phase 1 #1 — stable refs. `stable-ref.ts` (`captureStableRefs` / `resolveStableRef` /
      `renderStableRefs` / `parseRefParam`); `browser.snapshot` emits `[N] role "name"` refs
      (param `refs`, default on); `browser.click` / `browser.type` accept `ref=N` (exact,
      duplicate-name-proof, cross-frame). e2e: `tests/browser/stable-ref.test.ts` (6/6, real
      Chromium). tsc clean. Un-committed on working tree.
- [x] Phase 1 #2 — unified tab-aware active-page resolver (`active-page.ts`; fixes tabs-switch
      targeting; migrated all 14 leaf tools; e2e `tests/browser/active-page.test.ts` 4/4).
- [ ] Phase 1 #3 — iframe/shadow-DOM in remaining tools (snapshot refs already cross-frame)
- [x] Phase 5 #9 — `browser.network` + `browser.console` (`page-events.ts` ring buffers, capture
      starts at first interaction; MCP parity; e2e `tests/browser/page-events.test.ts` 3/3).
- [x] Phase 2 #4/#5 — self-heal retry + robust fill. `resilience.ts` (`withRetry` exp-backoff on
      transient Playwright errors, kill-switch `SUDO_BROWSER_RETRY=0`; `robustFill` verifies value
      stuck + `pressSequentially` fallback for contenteditable/React). Wired into navigate (also
      fixed HTTP-status race via goto() return), click, type. e2e `tests/browser/resilience.test.ts`
      7/7; full browser suite 55/55.
- [x] Phase 3 #6 — un-gate behind kill-switch. `autonomy.ts` `requiresConfirmationDefault()`;
      computer.use + browser.auth confirm by default, lifted under SUDO_BROWSER_UNATTENDED=1 (runtime
      ConfidenceGate/StuckDetector enforce safety instead). e2e `tests/browser/autonomy.test.ts` 3/3.
- [ ] Phase 4 #7/#8 — vision through Brain; CAPTCHA detect→handoff
- [ ] Phase 5 #10 — TraceStore/SelfVerify wiring
- [x] Phase 6 #11 — gated launch flags. `buildLaunchArgs` in `anti-detect.ts`: security-weakening
      flags (--disable-web-security, --allow-running-insecure-content, cert-ignore, IsolateOrigins-off)
      now opt-in via SUDO_BROWSER_INSECURE=1; default off (safer + less fingerprintable). Wired into
      browser-manager + cdp-manager. e2e `tests/browser/launch-args.test.ts` 3/3.
</content>
