# MISSION — production-ready core, designed a year out

**Owner directive (2026-08-06, Frank):** fix the sudo-ai core, make it production-ready,
redesign it for where models will be a year from now. Full autonomy — do not stop for
permission. Do not report back until there is a production-ready working version.

**READ THIS FILE FIRST in any session that picks this up.** It is the durable state.
Context ends; this file does not. Update it as facts change — it is the mission's memory,
not a status report.

---

## DONE MEANS (executable, not aspirational)

1. `pnpm verify` green: `tsc --noEmit` exit 0, full suite 0 test failures, build succeeds.
2. `pnpm check:arch` green (max-lines, flags, architecture tests).
3. No open PR in this mission carries an unresolved REJECT from an adversarial reviewer.
4. Every autonomous write path (self-build, cron, agent tools) is either **provably
   disabled** or **provably scoped** — no path can destroy human work or escape containment.
5. No shell-string `exec()` with interpolated values in any autonomously-reachable path.
6. Identity and state are separately addressable (ADR 0011 executed).
7. Every claim in this file traces to a command output, not to a recollection.

## NON-GOALS

- Merging to `main` without CI green.
- Touching the Grok/statsig lane (port 9223, `/root/grok-warm-profile`, `grok-warm-browser.ts`,
  `scripts/grok-web/*`, `scripts/_warmup.mts`). Two prior outages. Owner-gated.
- Touching port 9333 / `/root/claude-telegram-profile` (live browser awaiting login).
- Removing any working capability without the owner's explicit permission.

---

## VERIFIED STATE (2026-08-06) — corrections included

These were measured. Where an earlier claim of mine was wrong, the correction is recorded
because the wrong version is still written in merged PR bodies.

| claim | status |
|---|---|
| "self-build destroys uncommitted work every 30 min" | **FALSE.** `SUDO_SELF_BUILD_MODE` appears only in comments (`config/.env:66`, `ecosystem.config.cjs:676,768`), is unset, and absent from the daemon env → `runSelfBuildTick` returns `disabled` (orchestrator.ts:373). The destructive `git checkout -- .` never runs. **This wrong claim is in merged PR #1105's body.** |
| `auto-fix-trigger` switches branches in the live checkout | **TRUE.** 16 reflog entries; observed corrupting a 145s test run at 09:39:21. Disruptive to long-running commands; not file-destructive. |
| TUI header named a model that never ran | **TRUE, FIXED** (PR #1104, merged). |
| Credentials followed the TUI's private `DATA_DIR` | **TRUE, GUARDED** (#1104): adapter pre-captures identity root, refuses to boot if identity == state. Root fix is ADR 0011. |
| CDP `9223` is unauthenticated on loopback with an authenticated session behind it | **TRUE.** Port is load-bearing for statsig — must NOT be removed. Fix is profile separation, owner-gated on one Telegram login. |
| `browser-manager.ts:204` `localhost:9222` | **DEAD** (nothing listens). **Never "repair" it to 9223** — that would hand tools a logged-in session for another service. Delete or gate only. |
| Browser tools fail outside the daemon process | **TRUE.** Reproduced: `launch('default')` from a second process aborts on `ProcessSingleton`. |

## OPEN PRs FROM THIS MISSION (none merged)

| PR | task | verdict | required rework |
|---|---|---|---|
| #1106 | self-build revert scoping | **REJECT ×2** | Fix is **inert**: Gate 8 (`orchestrator.ts:~505`) cleans the tree *before* the baseline snapshot, so `baseline` is always empty. Also: git C-quoted paths abort the whole batched revert (reproduced — reverts nothing, exit swallowed); unbounded argv → E2BIG. Re-spec must start by establishing whether the path executes at all. |
| #1107 | identity root (ADR 0011 steps 1-3) | 3× CONCERNS | New env var name collides with an existing one; 3 credential stores missed. |
| #1108 | browser per-process profile | 3× CONCERNS | Abort fixed, but the fork is invisible on 20 of 21 tool entry points; opens an owner-only bypass window. |

Waves 2 and 3 were in flight when this was written: dead SDK path, self-build worktree
isolation, `.gitignore` hardening, argv-exec hardening, OpenClaw pattern ADR (0012),
scaffolding sweep. Check `gh pr list` for their state before starting anything.

---

## OPERATING DISCIPLINE (non-negotiable — these caused ~25 wrong answers in one session)

1. **Empty output is not evidence.** Validate the instrument with a positive control before
   concluding absence. This single error recurred four times.
2. **Never conclude from a truncated list.** Re-run one scope wider and one filter looser.
   `src/`-only and `*.ts`-only (missing `.tsx`) each produced confident wrong answers.
3. **A probe you write can create the phenomenon.** Prefer the real entry point; if probing,
   run both directions and require them to disagree.
4. **Verify the mechanism fires before fixing it.** PR #1106 shipped a fix for a path that
   never executes. Establish reachability first, always.
5. **Cost and severity claims need a measurement**, same as behaviour claims. Three turns
   were spent arguing for a fix worth 3.2 s/day.
6. **Every new test must be proven to fail** when a violation is planted. A green test
   without that proof is not evidence.
7. **Never drop a capability** to make a problem go away. Surface it; let the owner decide.

## HOW TO RESUME COLD

1. Read this file, then `gh pr list --state open`.
2. Read `docs/adr/0011-identity-root-vs-state-root.md` (and 0012 if it exists).
3. Re-derive any list before acting on it — a prior regex returned 1 site when there were 11.
4. Work in `git worktree`s, never the live checkout: `auto-fix-trigger` switches branches
   under long-running commands.
5. Update the VERIFIED STATE table above when you measure something new — especially when
   it contradicts what is written here.

---

## INCIDENT LOG

### 2026-08-06 — a test overwrote the live secrets file (caught pre-merge)

`tests/cli/chat/provider-dotenv.test.ts` (added by an agent on PR #1110) computed
`path.join(process.cwd(),'config','.env')` and, **at module scope**, read that file into
memory then overwrote it, restoring only in `afterAll`. In a worktree `config/.env` is
absent so it looked harmless; in the main checkout it is a 10,659-byte 0600 file with 241
lines of live credentials the prod pm2 process reads. Any interruption between write and
`afterAll` would have left it truncated with **no on-disk backup**. Several parallel
workflow waves were running vitest at the time.

Resolved: test deleted (`1c5523ca`). `config/.env` verified intact and backed up to
`/root/.env.backup-1786024871` (0600).

**Found by an adversarial reviewer — not by the author, not by CI.** Green CI does not
mean a diff is safe to run. This is the strongest argument for keeping the review lenses
on every wave.

**Standing rule:** no test may read or write a real credential file. If exercising a
module-private loader requires the real path, export the loader or inject the path —
change the code under test, never point a test at production state.

## WAVE STATUS (update as waves land)

| wave | tasks | outcome |
|---|---|---|
| 1 | revert scoping, identity root, browser profiles | PRs #1106/#1107/#1108 — 2 REJECT, rest CONCERNS. **None mergeable.** Reworked in wave 4. |
| 2 | dead SDK path, worktree isolation, gitignore | PRs #1110/#1109/#1111 — 7 of 9 lenses CONCERNS. #1111 is strongest (CI green, 79 .py identical). **None merged.** |
| 3 | argv-exec hardening, OpenClaw ADR 0012, scaffolding sweep | in flight |
| 4 | rework of #1106/#1107/#1108 | in flight |

### Carried forward (owned by nobody yet)
- `orchestrator.ts` still runs `git checkout -- .` and `git commit` in the **shared live
  checkout**. Wave 2 fixed only `auto-fix-trigger.ts`; the seam (`withAutoFixWorktree()`)
  now exists, so applying it is mechanical once the file is free.
- The auto-fix flow is **non-functional in production regardless**: `_triggerFix` opens a
  PR on a branch with zero commits and no push, so `gh pr create` fails. Pre-existing.
- PR #1109's advertised concurrency guard **does not work** (two reviewers measured it).
- PR #1111's new test breaks `check:arch` on developer machines; `docs/OPUS_HANDOFF_CAS_WIRING.md:222`
  still instructs contributors to use the removed `*.py` pattern.
- 5 `@ai-sdk/*` packages sit in `dependencies` imported by zero shipped code → `devDependencies`.

---

## BLOCKER — subagent orchestration is DOWN (owner action required)

11 agents across waves 3 and 4 failed with:

> `Your organization has disabled Claude subscription access for Claude Code · Use an
> Anthropic API key instead, or ask your admin to enable access`

This is an account/entitlement block, not a code problem. **I cannot fix it from inside the
session.** Until it is resolved, multi-agent orchestration is unavailable and the review
lenses — the only thing that has caught every defect so far — cannot run.

Owner options: re-enable Claude Code subscription access for the org, or supply an
`ANTHROPIC_API_KEY` for subagents (note: the metered anthropic API-key lane was previously
recorded as dead, so verify it before relying on it).

## PR INVENTORY — review status is the merge gate

**RULE: do not merge a PR that has not completed adversarial review.** Every unreviewed
agent PR in this mission so far has contained a defect, including one that would have
destroyed the live credentials file while CI was green.

| PR | what | review | mergeable? |
|---|---|---|---|
| #1112 | argv-array exec for the git worktree lane (no shell) | ✅ 3 lenses | assess findings, then likely YES |
| #1113 | ADR 0012 — which OpenClaw patterns to adopt / reject | ✅ 3 lenses | docs-only; assess then merge |
| #1111 | stop ignoring Python by default; artifacts only | ✅ 3 lenses (CI green, 79 .py identical) | fix dev-machine `check:arch` break + stale doc first |
| #1110 | delete dead SDK path in the chat surface | ✅ 3 lenses | live-secrets test REMOVED (1c5523ca); re-review that commit |
| #1109 | auto-fix cron stops mutating the live tree | ✅ 3 lenses | concurrency guard proven NOT to work — needs rework |
| #1106 | tick skips a dirty tree instead of "cleaning" it | ❌ **all 3 lenses failed (auth)** | **NO** |
| #1107 | CREDENTIAL_DIR + credentialPath (ADR 0011 1-3) | ❌ **all 3 lenses failed (auth)** | **NO** |
| #1114 | first scaffolding sweep — audit + 1 deletion | ❌ **all 3 lenses failed (auth)** | **NO** |
| #1108 | browser per-process profile fork | ❌ rework agent failed (auth); still v1 w/ CONCERNS | **NO** |

Note #1106 and #1107 appear to have addressed their wave-1 rejections (titles changed to
"skip a dirty tree instead of cleaning it" and "CREDENTIAL_DIR", i.e. the Gate 8 finding and
the env-var collision). **That is inference from PR titles, not verification.** Both still
need the review that failed to run.

### First actions when orchestration is restored
1. Review #1106, #1107, #1114 (never reviewed) and #1110's post-fix commit.
2. Rework #1109 (concurrency guard) and #1108 (never reworked).
3. Then merge in dependency order, CI green, one at a time.
