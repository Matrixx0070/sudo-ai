# F103 / CW9 — AgentLoop (`loop.ts`) Decomposition Design

**Status:** DESIGN-ONLY. Execution GATED on Fable's written GO (see `docs/CAS_WIRING_QA.md`).
**Author:** Opus (CAS Wiring Campaign, CW9), 2026-07-19.
**Spec:** `docs/OPUS_HANDOFF_CAS_WIRING.md` §CW9. F103 deferred this for lack of a design language; the CAS campaign supplies the executive vocabulary.

---

## 0. Why now

`src/core/agent/loop.ts` is **3,542 lines / one class (`AgentLoop`)**. Its mass is two mega-methods:
- `run()` — lines ~850–2073 (~1,220 lines): turn setup, injections, guards, dispatch prep.
- `_innerLoop()` — lines ~2116–3542 (~1,430 lines): the ReACT iteration (prepare → budget → call → execute → detect).

The campaign already carved real seams AROUND this file without touching its internals (CW2 pressure, CW4 arbiter, CW7 agency all hook the existing tool-result/injection points). CW9 is the **structural** counterpart: move cohesive responsibilities OUT of the god-method into named modules, using the executive vocabulary as the partition.

**This is a pure-refactor design. Zero behavior change is the acceptance bar.**

## 1. Executive vocabulary → module map

The CAS "executive" frame names five faculties. Each maps to a cohesive slice already present (but inlined) in `loop.ts`:

| Faculty | What it decides | Current inline location | Target module |
|---|---|---|---|
| **Attention** (what enters context) | which consciousness/memory content is injected, at what size | `run()` ~1141–1225 (onInteractionStart, CW2 pressure, intelligence brief, deep-bridge, commitments, skills) | `agent/turn/context-assembly.ts` — already delegates to CW4 arbiter + CW2 pressure; this module becomes the single injection composer |
| **Goals / intentions** | goal classification, forward-commitments, world-goals | `run()` ~1120–1140 (GoalClassifier), commitment injection | `agent/turn/goal-intake.ts` |
| **Planning** | best-of-N, decomposition (currently disabled), prompt prep | `runBestOfN()` + `_innerLoop` prepareMessages/compaction | `agent/loop/planning.ts` (wraps prepare + budget) |
| **Decision / dispatch** | model resolution, routing, tool execution | `_innerLoop` ~2240–3300 (dispatchRouter, brain.call, executeToolCalls) | `agent/loop/dispatch.ts` |
| **Conflict / error monitoring** | doom-loop, stuck, loop-guard, verify-gate, grounding, critic | `_innerLoop` recordCall/onNewTurn sites + result handling | `agent/loop/monitors.ts` (a MonitorBundle wrapping the 4 detectors + verify) |

Two cross-cutting slices are NOT faculties but are the largest movable mass:
- **Effect capture** (file-attachment extraction, taint tagging, trace/skill/outcome recording): the `emit` closure in `run()` ~950–1073 → `agent/turn/effect-recorder.ts` (a factory returning the event handler).
- **Setup / wiring** (the ~18 get/set accessors, lines 652–833): leave in place — they are thin, cohesive, and moving them buys nothing. NON-GOAL.

## 2. Move order (pure moves first — F103 slices 1–2 precedent)

Ordered least-risk → most-risk. Each step is its own PR, CI-green, export-parity-proven, before the next.

1. **`effect-recorder.ts`** (pure extraction). The `emit` closure is already self-contained (captures `session`, `state`, accumulators). Extract as `createEffectRecorder(deps): (event) => void`. Lowest risk: no control-flow change, just relocation of a closure factory. **~130 lines out.**
2. **`monitors.ts`** — wrap `loopGuard` / `doomLoopDetector` / `stuckDetector` / `writeCycleDetector` / `pollingStagnationDetector` into a `MonitorBundle` with `recordCall(tc, turn) → {action, reason}` and `onNewTurn()`. `_innerLoop` calls the bundle instead of five detectors inline. **~120 lines out; the CW7 doom mismatch-weight rides along unchanged.**
3. **`context-assembly.ts`** — move the turn-start injection sequence (attention faculty). This is the CAS integration point, so it lands last among the "medium" moves after monitors prove the pattern. **~180 lines out.**
4. **`goal-intake.ts`** — GoalClassifier + commitments. **~60 lines out.**
5. **`dispatch.ts`** + **`planning.ts`** — the `_innerLoop` core. HIGHEST risk (the ReACT control flow). Split only after 1–4 are merged and the harness is proven. Likely 2–3 sub-PRs (prepare/budget, then model-resolve/route, then execute/monitor). **~600–800 lines out.**

Target end state: `loop.ts` becomes an **orchestrator** (~800–1000 lines) that wires the modules and owns the top-level `run`/`_innerLoop` skeletons; each faculty is independently testable.

## 3. Export-parity proof plan (per move)

The invariant: **`AgentLoop`'s public surface and observable behavior are byte-identical before/after each move.**

1. **Public-API snapshot:** before a move, dump `Object.getOwnPropertyNames(AgentLoop.prototype)` + each method's `.length` (arity) to a golden. Assert unchanged after. (Getters/setters enumerated via descriptors.)
2. **Import-graph guard:** `tests/gdrive/hot-path.test.ts` already forbids `core/gdrive`/`core/notebooklm` imports in the agent hot path — extend it to assert the new `agent/turn/*` and `agent/loop/*` modules obey the same (no Drive/NotebookLM, no `core/brain` cycle).
3. **Behavioral golden:** run the existing agent-loop integration tests (the suite that drives `run()` end-to-end with a mock brain) before and after; diff the emitted event stream + final session messages. Zero diff = parity. Each move PR must show this suite green in CI (the same "Architecture ratchets → Test" gate the campaign already relies on).
4. **max-lines ratchet:** each move SHRINKS `loop.ts` → the ratchet auto-tightens its baseline (a feature, not a fight). New modules enter the baseline at their created size.
5. **Live smoke:** after deploy of each move, one turn on the daemon with 0 non-chronic `level:50` and the expected injection/monitor log lines present (the campaign's standard live check).

## 4. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Closure captures break on extraction (`state`, `session`, accumulators referenced by the `emit` handler live in TDZ before declaration) | HIGH for step 1 | `createEffectRecorder` takes a getter/thunk for late-bound `state`; unit-test the factory with a synthetic event stream before wiring |
| `_innerLoop` control flow subtly changes (early returns, `break`/`continue` semantics) | HIGH for step 5 | keep the loop skeleton IN `loop.ts`; extract only pure helpers (prepare, resolve, execute) that return values — never move the `for`/`while` itself |
| Hidden ordering dependency between injection steps (CW2 budget must precede brief; deep-bridge skip depends on CW4 flag) | MED | context-assembly.ts preserves the exact sequence; the behavioral golden catches reordering |
| Hot-path import regression (a new module pulls in gdrive/notebooklm transitively) | MED | extend hot-path.test.ts (proof step 2) BEFORE the moves |
| ESM/CJS interop landmine on new files (prod tsx vs vitest) | MED | `pnpm smoke:prod-tools` per the repo's established `.default ?? mod` guard; new modules are plain ESM, no dynamic `require` |
| Auto-fix daemon steals the worktree mid-move | LOW | the campaign's standard countermeasures (branch guard, `git checkout` before commit, CI for verdicts) |
| Reviewer cannot diff a 600-line move | MED for step 5 | split step 5 into 2–3 sub-PRs, each < 250 moved lines, each parity-proven |

## 5. Non-goals

- No behavior change, no new flags, no new features — pure structure.
- Do NOT move the 18 thin get/set accessors (652–833) — cohesive, tiny, no benefit.
- Do NOT re-enable task decomposition (deliberately disabled for token savings — a separate decision).
- Do NOT touch the CAS seams' logic (CW2/CW4/CW7 hooks move as-is with their host slice).

## 6. Definition of done (when executed, post-GO)

Steps 1–5 merged + deployed, each with its export-parity golden + behavioral-golden diff = 0 in CI; `loop.ts` ≤ ~1000 lines; hot-path test extended and green; a closing live smoke with 0 non-chronic `level:50`. Each faculty module has at least one direct unit test it did not have while inlined.

---

**Opus requests Fable review before ANY execution.** Filed as Q-2 in `docs/CAS_WIRING_QA.md`.
