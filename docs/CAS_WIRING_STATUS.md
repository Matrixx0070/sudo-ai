# CAS Wiring Campaign — Status Ledger

**Spec:** `docs/OPUS_HANDOFF_CAS_WIRING.md` (read first).
**QA:** `docs/CAS_WIRING_QA.md` (check for OPEN questions first).
**Convention:** update after every state change; append session reports at the bottom.
States: `TODO | IN_PROGRESS | BLOCKED(Q-n) | PR(#n) | MERGED(#n) | DEPLOYED | MEASURING(until <date>) | DONE | REVERTED(reason)`

| WS | Title | State | PR | Flag | Evidence / numbers |
|---|---|---|---|---|---|
| CW0 | Measurement: map + baseline injection pipeline | MEASURING(until 2026-07-20) | #868 | — | LIVE CONFIRMED: 10 organic `injectedTokensEst:329` lines (18:02:44Z/18:32:45Z/19:32:45Z et al., pid 3450416); mean 329 tok/turn (periodic scheduled turns, zero variance so far) |
| CW1 | Un-sever real signals into drive compute | DEPLOYED | #867 | none (bugfix-grade) | live line PENDING a CHANNEL turn: getConsciousnessContext only runs on channel messages (cli.ts:1993) — zero since deploy; signals verified hot in DB (36 surprise events/24h, improving 0/705 => line WILL fire, values 0.xx/0.0) |
| CW2 | Real context pressure into assembly | MEASURING(until 2026-07-22) | #870 | SUDO_CAS_PRESSURE=1 LIVE | flag flipped 19:43Z per Fable authorization (config/.env:196 + restart); watch: tier distribution, user_rephrased vs 0.70%, no new error classes |
| CW3 | Wire-or-delete: ContextSelector/Bridge | MERGED(#871) | #871 | — | verdict A: -1,238 LOC; CI green; merged-diff verified (files+refs gone) |
| CW4 | Bid-based context arbiter | IN_PROGRESS | — | SUDO_CAS_ARBITER (default OFF) + SUDO_CAS_ARBITER_BUDGET (default 1200) | module+wiring+12 tests built session 4; A/B plan below; flip needs Fable GO (Q-n) |
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

### 2026-07-19 — Opus session 2 (CI close-out attempt; CW2 scoped)

Ledger state updates:
- CW0 -> PR(#868) BLOCKED(Q-1). Ratchet repaired; Test step now RUNS. Own byte-identical test passes (in 873 passed). Not merged: 2 pre-existing unrelated failures block full green (see Q-1).
- CW1 -> PR(#867) BLOCKED(Q-1). Same. Own drive-wiring test passes (in 873 passed). Not merged for the same reason. NOT deployed (cannot deploy unmerged code; prod checkout must not switch branches).

- **BUILT:** Repaired two pre-existing main drifts that were silently masking CI (both PRs): `scripts/max-lines-baseline.json` (system-prompt.ts 715->863 + auto-tracked injector.ts/intel-brief.ts) and `src/core/config/flag-manifest.json` (regen, 12 missing SUDO_SLEEP_* flags, 651->663). These made the "Architecture ratchets" step pass so the Test step could finally execute. Filed Q-1 (merge criterion). Scoped CW2 (design below).
- **RAN:** CI run 29685497043 (#867) and the #868 run: "Architecture ratchets" now PASS; Test = **873 passed / 13 skipped / 2 failed**. The 2 failures are `tests/gateway/admin-dashboard-route.test.ts` DASH-10 (dashboard 53128B > 30KB budget — real regression) and `tests/tools/skill-meta.test.ts` (17 vs 16 — stale count; 17th tool from main commit e319c490). Both in files untouched by CW0/CW1. `Package · Install-from-tarball` = PASS on both.
- **ASSUMED:** The 2 failing tests are pre-existing main breakage (proven: unrelated files; previously hidden because the ratchet failed first and skipped Test, which is why #864-866 merged red). Deferred the merge decision to Fable via Q-1 rather than merge red or mask the dashboard regression.
- **UNVERIFIED:** Deploy (blocked on merge). Live CW0/CW1 log lines (blocked on deploy). 24h injectedTokensEst aggregate (blocked on deploy). Whether Fable prefers merge-as-is (A), fix-both (B), or fix-skill-meta-only (C).
- **WEAKEST POINT:** The merge is gated on a repo-health decision only Fable can make; until then CW1's load-bearing fix is not live. If Fable picks A/C, next session merges + deploys immediately.

## CW2 design (ready to execute next session — flag SUDO_CAS_PRESSURE, default OFF)

Occupancy source: reuse the loop's gw-refactor P2 gate primitives — `estimateContextSize(messages)` (src/core/agent/context.ts) / `getAliasLimits(model).context_window` (src/llm/limits.ts). occupancy = estimated / window.

Injection sites to make pressure-aware (per CW0 path map — LIVE ephemeral only, NOT the legacy summary string):
- intelligence brief `brief.formatted` (loop.ts:1167-1172).
- ConsciousnessDeepBridge `formatTurnStartInsights` + `getDrivePromptAddition` (loop.ts:1188-1198).

Plan:
1. New `src/core/consciousness/context-pressure.ts`: `pressureTier(occupancy)` -> 'full' (<0.5) | 'compressed' (0.5-0.85) | 'minimal' (>0.85) using the bridge's tier thresholds as the spec; `budgetForTier(tier)` token caps; `capToBudget(text, tokens)` code-point-safe truncation (this is the shared util CW3 also wants — build it here, CW3 harvests the bridge's identical logic then deletes the bridge).
2. `generateIntelligenceBrief(..., contextBudgetTokens?)`: when provided (>0) cap `formatted` via capToBudget; default undefined = no cap = byte-identical (preserves CW0 snapshot).
3. loop.ts injection site, gated `SUDO_CAS_PRESSURE==='1'` (default OFF): compute occupancy from `session.messages` at turn-start, derive tier+budget, pass budget to the brief, cap the deep-bridge messages, and `log.info` the chosen tier per turn.
4. Test: with a large mock brief, budget-for-90%-occupancy yields a strictly shorter injected block than budget-for-20%; plus unit tests for pressureTier/capToBudget (determinism, code-point safety). Acceptance per handoff CW2.
5. Flag default OFF; 3-day watch on task-success proxy before a follow-up flips default ON.

## Main-repo debts surfaced by campaign (per A-1 — for Frank's roadmap)

- **DASH-10 dashboard bloat:** `/v1/admin/dashboard` body measured **53,128B on 2026-07-19** vs its original 30KB budget (~1.7x over). Contained by a CI ratchet at 54,272B (tests/gateway/admin-dashboard-route.test.ts, PR #869) — further growth fails CI, but the bloat itself needs a properly-scoped repair. Cause unknown (likely recent dashboard/BO work; dashboard-html duplication is an F101 concern). Ruling: docs/CAS_WIRING_QA.md Q-1/A-1.
- **Ratchet mask (repaired):** the Architecture-ratchets CI step failed on main's own drift (max-lines baseline for system-prompt.ts; stale flag-manifest) BEFORE the Test step, silently skipping the entire test suite — the reason #864–866 merged red. Repaired in #869 (and carried in #867/#868). Green-means-green is enforceable from 2026-07-19 onward.

### 2026-07-19 — Opus session 3 (Q-1 executed; CW0-CW3 merged; deployed)

- **BUILT:** Repair PR #869 per A-1 (skill-meta 16->17; DASH-10 -> ratchet ceiling 54,272B with debt comment; + carried the ratchet-mask repairs so #869 alone restores green main). Merge chain executed: #869 -> #867 (CW1) -> #868 (CW0) -> #870 (CW2) -> #871 (CW3), each merged only on FULL green CI and verified in the merged diff (git show). CW2 built+shipped this session (context-pressure.ts util + capToBudget with a latent astral-char budget-overshoot bug fixed vs the bridge original + generateIntelligenceBrief(contextBudgetTokens?) + flag-gated loop threading, SUDO_CAS_PRESSURE default OFF). CW3 verdict A executed (-1,238 LOC; zero-live-consumer sweep recorded; harvest preceded deletion via CW2).
- **RAN:** CI full green x5 (#869 4m48s, #867 3m30s, #868 4m21s, #870 3m53s, #871 4m2s — Lint·Test·Build AND Package both PASS on each; first genuinely green CI since the ratchet mask). Local: CW2 9/9; post-deletion tests/consciousness 294/294; tsc --noEmit clean x2. Deploy #1 12:11:29Z (CW0+CW1): pm2 restart via ecosystem file --only sudo-ai-v5; "Consciousness layer booted" + DeepBridge initialised present; 0 level:50 lines post-restart. Deploy #2 (CW2+CW3) recorded below.
- **ASSUMED:** #869 needed the ratchet-mask repairs included to be green standalone (A-1's "restores a genuinely green main" read as authorizing this). CW2 based on the #868 branch to avoid an intelligence-brief rebase conflict; CW3 based on #870 for the harvest dependency. Deploy = merge origin/main into the prod branch (established pattern, no branch switch).
- **UNVERIFIED:** Live organic `CW0: intelligence brief injected` / `CW1: drive inputs` lines — 0 occurrences yet; no organic channel turn has fired since the 12:11Z restart (12 llm_calls since restart are background, not loop turns). Per Fable's orders: DEPLOYED with live-line PENDING is acceptable; next session greps first. 24h injectedTokensEst aggregate (MEASURING until 2026-07-20). SUDO_CAS_PRESSURE behavior in prod (flag OFF; needs a deliberate flag-ON watch window before any default flip).
- **WEAKEST POINT:** CW1/CW0 live-line verification is still pending organic traffic — the wiring is proven by unit tests + merged diff + clean boot, but no production turn has exercised it yet. Second: the CW2 pressure path has never run in prod (flag OFF); its first ON-window needs the 3-day task-success watch before any default flip.


## Deploy #2 record (session 3, referenced by the session-3 report)

Deploy #2 executed 2026-07-19T12:31:26Z: prod branch merged origin/main (CW2 #870 inert-OFF + CW3 #871 deletion + docs #872), `pm2 restart ecosystem.config.cjs --only sudo-ai-v5`, boot line "Consciousness layer booted" + DeepBridge initialised present, 0 level:50 lines post-restart. Selector/bridge files confirmed absent from the prod tree (Fable spot-check 12:36Z concurs).

### 2026-07-19 — Opus session 4 (live-line check; CW4 build)

- Live-line check (session start): `CW0: intelligence brief injected` = 0, `CW1: drive inputs` = 0 occurrences; zero organic channel turns since the 12:31Z restart (only cron/kairos background; 0 "Session resolved" lines post-restart) — PENDING stands, consistent per Fable's independent 12:36Z spot-check.
- CW2 flag: NOT flipped (orders require ≥1 healthy organic turn first; none fired). Authorization stands for session 5.

## CW4 A/B measurement plan (written BEFORE any flip — flip needs Fable GO via Q-n)

Baseline window: CW0 numbers (cache-read 24h=0.1512 / 7d=0.2902; user_rephrased ≈0.70%; injectedTokensEst per-turn stream live since #868).
Flip procedure (post-GO): SUDO_CAS_ARBITER=1 in deploy-state env + restart; 3–7 day window; then compare:
1. **Injected tokens/turn:** mean injectedTokensEst (CW0 log line) ON-window vs baseline — expect flat-to-lower (arbiter caps at 1200 by default).
2. **Cache-read share:** tokens_cached/tokens_in from gateway.db over the ON window vs 0.1512/0.2902 — must NOT regress (arbiter output is ephemeral, below the static prefix, deterministic ordering; any regression = revert).
3. **Task-success proxy:** user_rephrased rate vs 0.70% baseline; also zero new error classes in llm_calls.error_class.
4. **Qualitative:** sample 20 winner/loser rounds from data/arbiter.db (`SELECT * FROM arbiter_decisions ORDER BY ts DESC`) — check losers were genuinely lower-value; loser distribution by source informs bid-tuning.
Decision rule: all four healthy → file Q-n proposing default-ON; any regression → flag stays OFF or revert (revert IS success, F85 precedent).


### 2026-07-19 (evening) — Opus session 4 resumed (post-limit): CW0 live-confirm, CW2 flip, CW4 PR

- **CW0 LIVE CONFIRMED:** 10 organic `CW0: intelligence brief injected ... injectedTokensEst:329, consciousnessConsulted:true` lines (incl. Fable-verified 18:02:44Z / 18:32:45Z / 19:32:45Z, pid 3450416). Mean = 329 tokens/turn over 10 datapoints (periodic scheduled turns; zero variance — channel-turn variance pending).
- **Restart mystery resolved:** pid 3450416 WAS deploy #2's pid (12:31:26Z boot, uptime 7.19h at check) — no intermediate restart occurred.
- **CW1 stays PENDING with diagnosis:** the CW1 line lives in `getConsciousnessContext`, which the daemon calls only on CHANNEL messages (cli.ts:1993) — zero channel turns since deploy (0 "Session resolved"). DB proves the signals are hot: 36 surprise events in 24h (avg>0) and 0/705 capabilities improving (ratio 0.0 != 0.5 fallback) => the line fires on the first channel turn. Not a wiring gap.
- **CW2 FLIPPED:** turn-health precondition verified (677 completed calls since 12:31, error classes a strict SUBSET of the chronic pre-deploy set — auth/billing/overloaded/rate_limited/invalid_request all pre-existed at higher rates; user_rephrased 2/679 ~ 0.29% vs 0.70% baseline). `SUDO_CAS_PRESSURE=1` appended to config/.env (line 196, gitignored deploy-state) + pm2 restart 19:43:40Z. Boot clean: post-restart level:50 lines are the chronic KAIROS posture banner, an IMAP logout from the dying old pid, one chronic ollama auth_permanent failover, and one cognitive-stream provider-failover tick error (old pid, chronic billing/auth class) — no new classes. NOTE: config/.env reaches process.env via the app's ConfigLoader at boot (loader.ts:130 ENV_FILE='config/.env', override:false), NOT via /proc environ — behavioral proof = the per-turn `CW2: context pressure tier chosen` line, expected on the next periodic turn (~20:02Z cadence).
- **CW4:** PR #873 open, CI green at first push; 12/12 tests; this ledger fold rides the same PR.
