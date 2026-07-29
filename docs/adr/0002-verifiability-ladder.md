# ADR 0002 — Verifiability Ladder: deterministic route-qualification rungs 0–5

Status: Proposed · Date: 2026-07-28 · Branch: feat/grok-web-chat-brain

## Problem

Route/model admission into the brain chain is a judgment call today. Two recent
incidents show the cost:

- `models.primary[]` changes ship on vibes — the grok-4.5 primary swap billed ~$8.42 in
  2.5h before an emergency revert, and nothing structural stops a route with broken
  tool-calling from entering the chain (the grok app-chat lane's prompt-emulated tools
  produced a live hallucinated "browser tool executing…" reply before ADR 0001 rerouted
  to native MCP).
- Quality gates that DO exist (AL comparators, flywheel consensus, self-eval adopt) all
  grade with LLM judges, which costs tokens per verdict and drags in the judge-
  independence invariant (CLAUDE.md #7) even for outputs a schema validator could grade
  for free.

Empty-reply → total Telegram silence (#751) is the degenerate case: a failure gradeable
by `text.length > 0` reached prod because no rung-0 check existed anywhere on the path.

We need one reusable, mostly-deterministic grading ladder that (a) gates route
admission, (b) pulls comparator work off LLM judges wherever code can grade instead,
and (c) makes "which routes may serve tool turns" an executable policy instead of tribal
knowledge.

## Alternatives considered

1. **Per-route bespoke test suites** (status quo, e.g. grok-web-tools' 31 tests).
   Works for the route it was written for; nothing transfers, admission stays manual,
   and each new provider re-invents the harness. Rejected: feature, not capability.
2. **LLM-judge everything** (extend the AL comparator to grade admission). Uniform but
   burns tokens per verdict, needs an independent judge route even for JSON-shape
   checks, and is non-deterministic where determinism is available. Rejected.
3. **External eval framework** (promptfoo/inspect-ai style dependency). Heavier than
   the need; our graders must call in-repo seams (tool registry, sandbox, IR transport)
   and respect in-repo invariants (budgets, zone rules). Rejected — the existing
   architecture can evolve; no new dependency justified.
4. **One ladder engine in-repo, deterministic rungs 0–3, judged rungs 4–5** — chosen.

## Decision

Build a single library — `src/core/evals/ladder.ts` (new `core/evals` module, no hot-path
imports) — that grades a **route** (an IR-resolvable model alias, e.g. `grok-web-mcp/grok-4`,
`fable-5`, `xai-oauth/grok-4.5`) against numbered rungs. One engine; admission gates,
comparators, and AL activation memos all call it. Never fork per-corner copies.

### The rungs

Ordered by grading cost. Rungs 0–3 are graded by code — no LLM judge, no judge-
independence concern. Rungs 4–5 are graded by an LLM judge and inherit invariant #7
(judge ≠ route under test, pinned `judgeRoute`, HOLD if no independent route exists).

| Rung | Name | Certifies | Grader |
|------|------|-----------|--------|
| 0 | Liveness / reply shape | Non-empty, parseable, normalized text; no content-filter empty-string (the #751 class) | `normalizeReplyText` + length/parse check |
| 1 | Tool-call contract | Valid tool JSON: known tool name, schema-valid args, correct types after coercion; survives provider name-mangling (e.g. Grok's dot→underscore) | JSON-schema validator against the tool registry |
| 2 | Math / numeric | Correct closed-form answers within tolerance; multi-step arithmetic, unit handling | Exact/tolerance compare vs golden answers |
| 3 | Code unit-test | Generated code passes a fixed unit-test suite in the sandbox | Existing bwrap/Docker sandbox, binary pass/fail per task |
| 4 | Property / end-to-end task | Multi-turn ReACT task completion: goal reached, no doom-loop, artifacts exist | Programmatic assertions where possible; LLM judge for goal-satisfaction |
| 5 | Open-ended quality | Helpfulness/faithfulness of prose answers | LLM judge panel (existing comparator machinery) |

Each rung is a versioned golden set checked into `evals/ladder/rung-<n>/` (prompt +
expected + grader params). Golden sets only grow; changing an existing case bumps the
set version, which invalidates cached verdicts for that rung.

### Admission thresholds

Thresholds are policy data (`config/sudo-ai.json5 → evals.ladder`), not code. Initial
values — deliberately strict at the bottom, tunable at the top:

- **Any brain-chain entry** (`models.primary[]`, cheap, premium): rung 0 = 100% (n≥50),
  rung 1 ≥ 99% (n≥100).
- **Serving tool turns** (provider eligible for `tool_use` turns): rung 1 ≥ 99% AND
  rung 4 tool-task completion ≥ 90% (n≥20). A route below this may still serve
  text-only turns.
- **Code-task routing** (skill.eval, PTC, self-modify authorship): rung 3 ≥ 85% (n≥30).
- **Full-turn executors** (ADR 0001's grok-web-mcp class, where per-step results are
  invisible): rung 4 ≥ 95% on the nonce-probe suite — stricter because there is no
  per-step guard to catch mid-turn failures.
- **Judge eligibility** (a route may sit on the grading side of rung 4/5): rung 2 ≥ 95%
  AND rung 5 self-consistency ≥ 90%, plus invariant #7 independence per comparison.

A route that fails rung N is not run on rungs > N (fail-fast, saves budget). Verdicts
are cached per `(route, model, rung, goldenSetVersion)` in gateway.db; re-qualification
runs only on provider-code change, golden-set bump, or explicit operator request —
never on a schedule by default.

**Gate enforcement (invariant #8 shape):** config load WARNs (does not crash) when a
`models.primary[]` entry lacks a passing cached rung-1 verdict; the flag
`SUDO_EVAL_LADDER_ENFORCE=1` upgrades WARN→refuse-to-route for tool turns. Default OFF
until the ladder has graded the incumbent chain, so a fresh deploy can never brick the
brain. Human-mediated additions still work: the operator runs `sudo-ai evals ladder
<route> --rung N`, and the cached verdict artifact IS the attestation the gate checks.

### Where it hooks in

1. **Route admission** — the WARN/enforce gate above, at config validation time. First
   consumer: `grok-web-mcp/grok-4` (ADR 0001) must clear rung 0/1/4-nonce before it can
   ever be flag-ON.
2. **Comparator down-shift** — AL comparators and flywheel consensus check "is this
   output gradeable at rung ≤ 3?" first and use the code grader when so; LLM judges
   only above the deterministic band. Direct token savings under invariant #10 budgets.
3. **AL9/AL10 activation evidence** — activation memos (SUDO_AL_META / SUDO_AL_FRONTIER)
   cite ladder verdicts for any route the meta-layer proposes to rely on, replacing
   prose claims with cached verdict rows.
4. **Failover ordering signal** — rung pass-rates become a column on the Telemetry tab
   next to latency/success; informs (not auto-rewrites) `models.primary[]` ordering.
   Automated reordering stays out of scope (would need its own gate).

### Budgets (invariant #10)

Ladder runs are background jobs: per-run token/spend budget declared per rung (rungs
0–2 ≈ free; rung 3 bounded by sandbox wall-clock, default 10 min/run; rungs 4–5 bounded
by a per-run token cap and a per-day cap shared with the comparator pool). Exhaustion
halts gracefully, alerts, reports on the Telemetry tab. Metered routes (anything
xai-oauth) are NEVER auto-graded — money-guard rules outrank eval curiosity; grading a
metered route requires the explicit CLI form plus `SUDO_XAI_TEXT_BLOCK=0`.

### Seed sources (reuse, don't rewrite)

- Rung 1: recast the schema-shaped subset of grok-web-tools' 31 tests + the coercion
  fixtures (#671/#674/#681) as golden cases.
- Rung 3: reuse skill.eval's concurrent runner (#672) as the execution engine.
- Rung 4: the grok-web-mcp nonce-probe suite (ADR 0001's "repeated nonce probes")
  becomes the first rung-4 golden set.
- Rung 5: existing flywheel-consensus judge machinery, unchanged, called through the
  ladder API.

## Tradeoffs / consequences

- Golden sets are a maintenance surface; stale goldens grade yesterday's failure modes.
  Mitigation: append-only growth + every prod incident that a rung SHOULD have caught
  files a new golden case in its fix PR (same discipline as regression tests).
- Rungs 0–3 measure competence, not alignment/safety — a route can ace the ladder and
  still leak data. The ladder is an admission gate, NOT a substitute for the trust-tier
  sandbox, F18 quarantine, or zone rules; those remain independently enforced.
- Cached verdicts can go stale when a provider silently changes server-side (same model
  alias, new behavior). Accepted: re-qualification on incident is cheap; scheduled
  re-runs stay opt-in to respect budgets.
- Thresholds are initial guesses; expect one tuning pass after grading the incumbent
  chain. The enforce flag stays OFF until then, so wrong initial thresholds cost
  nothing.
- One new module (`core/evals`) is justified over evolving an existing one: comparators
  live inside AL machinery (wrong dependency direction for config-load-time gating),
  and skill.eval is tool-scoped. `core/evals` imports neither `core/agent` nor `src/llm`
  hot paths; it consumes the IR transport through the same injected-callback seam the
  gdrive invariant already mandates.
