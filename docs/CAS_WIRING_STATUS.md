# CAS Wiring Campaign — Status Ledger

**Spec:** `docs/OPUS_HANDOFF_CAS_WIRING.md` (read first).
**QA:** `docs/CAS_WIRING_QA.md` (check for OPEN questions first).
**Convention:** update after every state change; append session reports at the bottom.
States: `TODO | IN_PROGRESS | BLOCKED(Q-n) | PR(#n) | MERGED(#n) | DEPLOYED | MEASURING(until <date>) | DONE | REVERTED(reason)`

| WS | Title | State | PR | Flag | Evidence / numbers |
|---|---|---|---|---|---|
| CW0 | Measurement: map + baseline injection pipeline | PR(#868) | #868 | — | path map + baselines below; log-only instrumentation + byte-identical test (3/3 local) |
| CW1 | Un-sever real signals into drive compute | PR(#867) | #867 | none (bugfix-grade) | drive-compute reads surprise/world/self accessors; test 5/5 local |
| CW2 | Real context pressure into assembly | TODO | — | SUDO_CAS_PRESSURE | — |
| CW3 | Wire-or-delete: ContextSelector/Bridge | TODO | — | — | — |
| CW4 | Bid-based context arbiter | TODO | — | SUDO_CAS_ARBITER | — |
| CW5 | Surprise gates encoding + attention | TODO | — | SUDO_CAS_SURPRISE_GATE | — |
| CW6 | HomeostatCore (essential variables) | TODO | — | — (sensing only) | — |
| CW7 | Expectation logging + mismatch credit | TODO | — | SUDO_CAS_AGENCY | — |
| CW8 | Eligibility traces (multi-step credit) | TODO | — | SUDO_CAS_AGENCY | — |
| CW9 | loop.ts decomposition DESIGN (execution gated) | TODO | — | — | — |

## Audit re-verification (CW0, 2026-07-19)

§3.2 findings re-checked against current source (line numbers drifted; claims hold):
- **Finding 1 (never attached) — CONFIRMED.** `attachContextSelector`/`attachConsciousnessBridge` (orchestrator.ts:251/258) have zero non-test callers (grep across `src/`). Boot lines "ContextSelector attached"/"ConsciousnessBridge attached" (orchestrator.ts:254/261) appear 0 times in prod logs (`~/.pm2/logs/sudo-ai-v5-*.log`, grep -c = 0 out+err). The bridge branch in `getConsciousnessContext` (orchestrator.ts:659) is dead in prod.
- **Finding 2 (vestigial) — CONFIRMED.** context-selector.ts: `relevance:1.0` (:203) / `0.4` (:211) constants; `_intent` ignored (:194); orchestrator passes `this._lastInteractionAt ?? 'general'` (a timestamp) as intent (:662); context pressure hardcoded `0` (:664); MODULE_FORMATTERS 15/17 static placeholders (:132-147); latent recursion in SelfModel formatter (:126-130).
- **Finding 3 (severed signals) — CONFIRMED (fixed by CW1).** Severed constants were at orchestrator.ts:685-686.

## Injection path map (CW0 step 1)

Which declared path actually reaches the live prompt per turn:

| Path | Source | Reaches prompt? | Notes |
|---|---|---|---|
| (a) `getConsciousnessContext(): string` | orchestrator.ts:651; called cli.ts:1993 | No (daemon) — logging only (`log.debug ctxLen`, cli.ts:1994); used for display by builtin slash commands (builtin.ts:87,189). | BUT its `driveManager.compute()` side-effect (the CW1 site) sets drive state consumed by (c) + deep bridge. |
| (b) `onInteractionStart -> {contextSummary, activeConcepts}` | loop.ts:1144 | No — result only `log.debug`-ged (loop.ts:1145-1148); contextSummary not injected. Used for interrupt logic. |
| (c) `getIntelligenceBriefContext(message)` -> `generateIntelligenceBrief` | loop.ts:1155-1182 | YES — primary live path. `brief.formatted` pushed as `_ephemeral` system message (loop.ts:1168-1172). |
| (d) `ConsciousnessDeepBridge` (not in the 3 declared paths) | loop.ts:1186-1202, init loop.ts:625 | YES — `formatTurnStartInsights` + `getDrivePromptAddition` pushed as `_ephemeral` system messages when `_deepBridge` initialised (duck-typed `getDeepInsights`). |

**Key fact:** `driveManager.compute()` has exactly one caller (orchestrator.ts:683 = the CW1 site). So the severed constants set the drive state every downstream consumer reads (dominant drive, drive influence, intelligence-brief drive fields, deep-bridge drive prompt) — CW1 is load-bearing despite living in a path whose string output the daemon only logs.

## Baselines (CW0)

Source: `data/gateway.db` `llm_calls` (5-day history 2026-07-14 -> 2026-07-19; existing history per handoff, no 24h wait).

- **Prompt cache-read share** (`SUM(tokens_cached)/SUM(tokens_in)`): **24h = 0.1512** (2875 calls, tin=9,940,191, tcached=1,503,102); **7d = 0.2902** (7857 calls, tin=43,244,491, tcached=12,550,246). This is the CW4 guard baseline — arbiter output must not regress it.
- **Task-success proxy** (`llm_calls.outcome`, 24h): 2855 blank + **20 `user_rephrased`** => user-rephrase rate ~= **0.70%** of 2875. Refine once CW7/self-eval proxy is wired.
- **Mean injected consciousness tokens/turn:** instrumentation now emits `injectedTokensEst` per turn (info level, `module:agent:intel-brief`, msg `CW0: intelligence brief injected`). Captured live example (test fixture): 208 tokens for a rich brief. 24h prod aggregate PENDING — collect after #868 deploys (grep `CW0: intelligence brief injected` from pm2 logs; state -> MEASURING).

## Session reports (append-only; five-field format)

### 2026-07-19 — Opus session 1 (CW0 map+baselines+instrumentation, CW1 wiring)

- **BUILT:**
  - CW1 (PR #867): un-severed the drive-compute constants at orchestrator.ts. `recentSurprise <- surpriseEngine.getAverageSurprise(24)`; `worldModelConfidence <- worldModel.getAverageConfidence()` (new read-only accessor); `selfModelImprovingRatio <- selfModel.getImprovingRatio()` (new read-only accessor); `recentInteractionRate` left 0.5 (documented). Old constants kept as module-unavailable fallbacks. Telemetry line emits only when a non-fallback signal flows. Test `tests/consciousness/cw1-drive-signal-wiring.test.ts` (5 cases).
  - CW0 (PR #868): log-only instrumentation in `generateIntelligenceBrief` (per-turn `injectedTokensEst` + per-source share + consciousness-consulted flag). Byte-identical test `tests/agent/cw0-brief-instrumentation.test.ts` (3 cases, inline snapshot pins injected content). Added the three CAS_WIRING docs to git (were untracked). This ledger + path map + baselines.
- **RAN:** CW1 test 5/5 passed locally (vitest, 1.38s). CW0 test 3/3 passed locally against pinned snapshot (0.93s); instrumentation log observed live in test output (`injectedTokensEst:208 ... consciousnessConsulted:true`). Baselines pulled from `data/gateway.db` (numbers above). Prod-log grep confirmed 0 "attached" lines. CI verdicts on #867/#868: pending at report time.
- **ASSUMED:** `worldModelConfidence` := mean confidence of pending predictions (matches drive-computer docstring "average prediction confidence"); 0.5 baseline. `selfModelImprovingRatio` := improving-trend capabilities / total; 0.5 baseline. Task-success proxy uses `llm_calls.outcome` user_rephrased rate (best available without a dedicated self-eval field). CAS docs belong in-repo (added via CW0 PR) so the ledger persists across worktrees.
- **UNVERIFIED:** Full CI suite (green/red) for #867 and #868 — pending at report time. Live deploy of either PR (not yet merged/deployed). 24h prod aggregate of `injectedTokensEst` (needs #868 live). The literal `surpriseEngine.getAverageSurprise(24)` read inside orchestrator is a trivial delegation exercised only indirectly (accessors + drive behavior are unit-tested; the one-line read is covered by merged-diff grep, not a runtime assertion).
- **WEAKEST POINT:** CW1's per-turn info telemetry line — if `getConsciousnessContext` is called more often than once per user turn in some background path it could add modest log volume (guarded to fire only on non-fallback signal, quiet at cold start). Second: node_modules is symlinked from the prod checkout into worktrees for local runs — CI uses a clean install, so dep-drift would only surface in CI.
