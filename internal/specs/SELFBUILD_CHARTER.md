# SUDO-AI Self-Build Charter
Version: 1.0.0
Baseline tag: pre-selfbuild-baseline (8fbf4d1)
Activated by: SUDO_SELF_BUILD_MODE=1

## GOAL
Produce commits on the self-build git branch advancing this codebase toward
public-publishable state, defined as:
- Zero owner-PII in source or docs
- All tests passing (no reductions from baseline count of 3601)
- Clean README with working install instructions
- At least one verified end-to-end example workflow documented
- TypeScript compiles clean (tsc --noEmit exits 0)

## SCOPE
The agent MAY:
- Edit any file under src/ NOT in the protected paths list
- Edit any file under docs/ EXCEPT docs/SELFBUILD_CHARTER.md
- Edit README.md
- Write or improve tests (additions only — no baseline test file deletions)
- Remove dead code with no test coverage
- Improve comments, JSDoc, log messages

## NON-GOALS
The agent MUST NOT:
1. Edit alignment stack files (alignment-aggregator.ts, veto-gate.ts, mistake-auto-block-guard.ts, discordance-detector.ts, commitment-auditor.ts)
2. Modify auth tokens, security middleware, or credential handling
3. Delete or modify this charter (docs/SELFBUILD_CHARTER.md)
4. Delete or modify src/core/self-build/
5. Delete or modify .githooks/
6. Merge any branch into main
7. Force-push, amend commits, or reset any branch
8. Call meta.self-modify with restart, build, or full-cycle actions
9. Delete any test file that existed at pre-selfbuild-baseline tag
10. Write to data/ directories

## STOP CONDITIONS
S1: alignment score < 0.6 OR null (null = abort)
S2: daily LLM spend >= SUDO_DAILY_LLM_BUDGET_USD (default $20)
S3: 3 consecutive ticks with no commit on self-build
S4: 3 consecutive ticks gate-aborted (S1/S2/S5/S6/S7 each count)
S5: MistakeAutoBlockGuard returns BLOCK
S6: SUDO_SELF_BUILD_DISABLE=1
S7: HEAD not on self-build branch
S8: post-commit diff shows protected path modified (triggers revert + halt)
S9: new commit reduces total passing test count vs prior tick

## CONSTRAINTS
- Every committed edit: tsc --noEmit exits 0 AND vitest run exits 0
- All commits on branch self-build with message prefix "self-build: "
- No force-push, no amend, no destructive git ops
- Daily at 09:00 UTC: data/self-build-reports/YYYY-MM-DD.md produced
- No network calls outside repo (no npm install, no git push, no curl)

## DAILY BUDGET MATH
336 ticks over 7 days (30-min cron). Target <= $1.50/tick average.
Default cap: $20/day ($140 total). Tune via SUDO_DAILY_LLM_BUDGET_USD.

## PROTECTED PATHS
The following paths MUST NOT be modified, created, or deleted by the self-build agent.
These are enforced by THREE independent layers (meta.self-modify deny-list, git pre-commit hook,
and orchestrator post-commit diff check). Bypassing all three simultaneously is required to violate
these protections.

- src/core/self-build/          (the orchestrator itself — Layer 3 defense)
- src/core/agent/alignment-aggregator.ts
- src/core/agent/veto-gate.ts
- src/core/cognition/mistake-auto-block-guard.ts
- src/core/cognition/commitment-auditor.ts
- src/core/security/discordance-detector.ts
- src/core/cognition/trust-tier-tracker.ts
- src/core/tools/builtin/meta/self-modify.ts
- docs/SELFBUILD_CHARTER.md     (this file)
- .githooks/                    (Layer 2 protection)
- .git/                         (git internals)
- config/sudo-ai.json5          (primary systemPrompt — agent cannot self-lobotomize)
- ecosystem.config.cjs          (runtime config)
- package.json                  (dep changes need human review)
