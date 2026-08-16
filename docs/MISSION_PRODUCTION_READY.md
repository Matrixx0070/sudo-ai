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

---

## WAVE 5 — merge decision (2026-08-16)

21 agents, all completed. **#1113 MERGED** (ADR 0012, docs-only, 3 lenses). Everything else held.

### CONFIRMED DEFECTS — proven by execution, not by reading

| PR | defect |
|---|---|
| **#1109** | **LIVE COMMAND INJECTION as root.** `removeWorktree` does `execAsync(\`git worktree remove "${dir}" --force\`)` where `dir` comes from `fs.readdir(baseDir)` filtered only by `startsWith('sudo-autofix-')`. Double quotes do not stop `$( )`. A reviewer ran the real exported `pruneAutoFixWorktrees()` against a planted dir named `sudo-autofix-x$(touch PWNED)` → `COMMAND INJECTION EXECUTED = true`. **NOT on main — git-worktree.ts exists only on this branch.** |
| **#1109** | Lane lock is not mutually exclusive: `mkdir` is atomic but the ownership record is check-then-act. Measured: "B acquired lane while A believes it holds it: true", plus a permanently leaked lock. Also wedges forever if a recycled pid matches a stale owner. Also: worktree branches from the shared checkout's HEAD, so it would carry a human's WIP commits once the flow actually commits. |
| **#1108** | Owner-only bypass **not closed**: `personal!` — one appended character — launches a non-owner on the owner's real cookie jar. Two lenses REJECT. Worse than main: converts a loud abort into silent destruction of a saved login. |
| **#1107** | The TUI guard asserts on the **wrong constant** (state root, not credential root) — fails in both directions, confirmed by execution. 3–4 credential stores unmigrated, so setting the new knob strands eval seeding. |
| **#1106** | `revertAgentChanges()` swallows every non-zero exit and never checks its post-condition. Reproduced: with `.git/index.lock` held, reset+checkout both exit 128, are swallowed, and the tick reports `protected-path-reverted` with the agent's edit still staged. |
| **#1112** | Branched off the **pre-rework** head of #1109 and rewrites the same file without the lane lock → merging both conflicts or silently reverts #1109. Transitively blocked. |

### MERGE ORDER (remaining)
1. ~~#1113 ADR 0012~~ — **MERGED**
2. **#1114** scaffolding sweep — ⚠️ **OWNER DECISION REQUIRED, see below**
3. **#1111** gitignore — fix first: its new test breaks `check:arch` on dev machines;
   `docs/OPUS_HANDOFF_CAS_WIRING.md:222` still references the removed pattern.
4. **#1110** dead TUI SDK path — fix first: `provider.ts:54` cites a test this branch itself
   deleted; PR body reports 53 passed/4 files (actual 51/3). Better: export `loadDotEnv` and
   pin it with a tmpdir fixture — after this PR provider.ts is types + one const, exactly the
   shape a future dead-code sweep deletes, which would silently strip every API key from the
   TUI process with no failing test.

No conflicts among these four; merge sequentially, re-running `check:arch` after each
(stacked branches have blown the max-lines ratchet before).

### ⚠️ OWNER DECISION — #1114 is a publication question, not a code question
**This repo is PUBLIC.** The scaffolding audit doc is a searchable index of which safety
guards are advisory / fail-open / default-off, and it states in writing that sudo-ai
disguises the owner-tier remote-command tool to defeat xAI's connector classifier. Every
individual fact is already in public source; the doc *concentrates* them into one map.
Also retitle its `DELETE NOW` verdicts to `CANDIDATE — OWNER GO REQUIRED` before an
autonomous sweep reads them as license to delete.

This is outward publishing of security-relevant material. Frank decides, not an agent.

---

## CORRECTION (2026-08-16) — the "every 30 minutes" hazard does not exist

Measured directly, no agents:

- `autobugfix-boot.ts:50` gates AutoFixTrigger on `SUDO_AUTOBUGFIX=1`. **Not set in the pm2
  daemon env.** Dormant.
- `SUDO_SELF_BUILD_MODE` likewise unset → `runSelfBuildTick` returns `disabled`.
- Auto-fix checkouts in the reflog: May 31(1), Jun 14(2), Jun 15(2), Jul 02(2), Jul 13(3),
  Jul 14(4), Aug 06(2). **Zero in the last 10 days.** The Aug 6 switch targeted a branch
  last committed 2026-07-14 — a one-off, not a schedule.

**Both hazards I asserted were wrong.** Neither self-build's revert nor auto-fix's branch
switching runs. PRs #1106 and #1109 were commissioned against these phantoms and are now
closed; #1109 had introduced a root-level command injection while "securing" a dormant lane.

Consequence: the working tree is NOT at risk, worktree isolation is not urgent, and
auto-fix needs no repair before things that actually execute.

## METHOD CHANGE — diagnose directly, dispatch only for review

Outcome by agent role this mission: **implementers** 9 PRs → 1 merged, 4 closed net-negative.
**Reviewers** caught every defect (root injection, credential-wiping test, one-character
owner-only bypass, wrong-constant assertion).

The implementers executed faithfully; the specs were wrong because they came from an
unverified model of the system. Diagnosis needs accumulated context and stays with the
primary session. Dispatch only bounded adversarial verification of finished work.

## NEXT (in order)
1. Land #1111 and #1110 (wave 6 in flight).
2. **Dependency reduction — 71 vs XClaw's 0.** The one axis where the comparison is
   unambiguous and actionable. Five `@ai-sdk/*` packages already confirmed imported by zero
   shipped code.
3. Redo #1107 (`CREDENTIAL_DIR`) — asserts on the wrong constant; it is the root cause of
   this mission's original bug chain.
4. #1114 — owner decision (public repo, concentrates a map of safety-guard posture).

## CORRECTION (2026-08-16, later) — the branch-switcher is a TEST, and main is green

Triage of "7 failing test files on main" (from the 17:36 `/tmp/verify-wt` run). All
measured, no agents:

**Main is fully green.** Fresh worktree at `0a3432eb`, `GH_CONFIG_DIR` pointed at an
empty dir: **1093/1093 test files, 13,171 tests passed, 0 failures.** The 7 "failing"
files (bash-allowlist, gateway-turn-handler, deps-freshness, restart-sentinel,
embeddings-backoff, agent-loop, whisper-stt) all pass on clean main.

**Root cause of every mass-failure run:** `src/core/self-build/auto-fix-trigger.test.ts`
→ "should allow processing when kill-switch is not set" calls the real
`trigger.processIssue(123)`. Its comment assumes "gh CLI … will fail in test env" — but
on this host `gh` is authenticated, so it fetches real issue #123 ("feat: ACP …"),
passes the mocked gates (`suggestFix` mocked non-null), and runs a **real
`git checkout`** (`createBranch` → fallback plain checkout of the existing
`auto-fix/123-feat-acp-agent-client-protocol`, last committed at `cd153dd5`, months old)
**in whatever checkout the suite runs in**, ~20 s into every run. The rest of the suite
then executes against a mixed/ancient tree → arbitrary failures (7 files at 17:36; 378
at 17:31; 365 in another run — count depends on timing). The test itself stays green
(its assertion is only `reason !== 'disabled'`).

Proven by execution: running only that file in a fresh worktree logged
`tool:github "Creating branch auto-fix/123-feat-acp-agent-client-protocol"` and
attempted the checkout (blocked only because another worktree held the branch).
Reflog: it switched the **live checkout** main→`cd153dd5` at 17:30:16 during the
verify.log run (restored 17:32:31). This — not the dormant daemon — is the mechanism
behind "auto-fix switches branches in the live checkout" (16 reflog entries) and the
"Aug 6 one-off": the earlier correction was right that the daemon lane is dormant, but
wrong to conclude the hazard is gone. It fires from the test suite on any
gh-authenticated host. CI is green because CI's `gh` is unauthenticated → fetch fails →
checkout never runs.

**Fix (small, not yet done):** mock `child_process` in that test file the way
`tests/dev/github-create-branch.test.ts` already does (or stub `createBranch`), and
strengthen the assertion. Belt-and-braces: vitest setup could set
`GH_CONFIG_DIR=<empty>` so no test can reach the real GitHub/git boundary silently.

Interim rule: do not run the suite in the live checkout or any checkout you care about
until this test is fixed (worktree + neutered `gh` is safe).

## XCLAW-LEVEL — executable definition of "done" (2026-08-16, Frank's directive)

Frank: sudo-ai must reach or exceed xclaw's demonstrated level. "Level" here is not
feature count — sudo-ai has more machinery — it is **demonstrated working product**.
Every criterion below is a command or observable proof, re-runnable per release.

| # | criterion | proof command / observable | status 2026-08-16 |
|---|---|---|---|
| X1 | Telegram E2E: owner DM → correct reply | CDP :9223 drive web.telegram.org → @Sudoaii_bot replies | ✅ proven 2× today (18:24, 18:25) |
| X2 | Health: 0 criticals sustained, owner-visible | watchdog log + criticals DM'd to owner | ✅ today ("zero criticals"); keep at 0 |
| X3 | Suite green in isolated worktree, no test touches real gh/git/network | full vitest in worktree + reflog unchanged after | ✅ 13,171 tests; guard PR #1115 in flight |
| X4 | CI green on main, releases + CHANGELOG current per merge | gh run list; releases page | CI ✅; release hygiene UNVERIFIED |
| X5 | Every configured LLM provider proven by one live call, matrix recorded | per-provider probe script output | UNVERIFIED |
| X6 | Approval tiering: read-only auto-runs, risky pends to owner, live-proven | send risky + read-only op via Telegram, observe | UNVERIFIED |
| X7 | Cost governance: per-run + daily spend visible to owner, caps alert | spend report / DM on band change | UNVERIFIED (xclaw parity) |
| X8 | Long-run objectives survive restart/context loss, resume from state | kill daemon mid-mission → resumes, criteria intact | partial (mission wake exists) — UNVERIFIED |
| X9 | Dependencies: 69 → ≤40 (milestone 1), each survivor justified | package.json count + zero-import audit | 69; 5 @ai-sdk/* known dead |
| X10 | Daemon exits: only intentional (SIGINT-clean); SIGKILL class explained | pm2 log exit histogram | 93 clean / 3 SIGKILL / 3 code-1 (lifetime) |
| X11 | No unreviewed merge, ever (standing rule restated) | PR review trail | orchestration RESTORED today — lenses run again |

Method (unchanged): one slice at a time, live-proven same day through the real
Telegram flow, adversarial review before merge. xclaw itself may be used as a dev
tool for bounded verification jobs.

Restart-cause histogram measured 2026-08-16: 99 exits lifetime = 93 SIGINT/code-0
(intentional deploys), 3 SIGKILL (watch: possible shutdown hangs), 3 SIGINT/code-1.
No crash loop. The "32 restarts" pm2 counter is operational history, not instability.

## X5 PROVIDER MATRIX — measured 2026-08-16 ~19:00Z (all through the live daemon or its own endpoints)

| lane | result | proof |
|---|---|---|
| claude-oauth (SUDO_DEFAULT_MODEL claude-opus-4-8; +haiku/sonnet/fable/opus-5 seen live) | ✅ | Telegram E2E replies 18:24/18:25 route through it |
| openai (API key) | ✅ 876 ms | `POST /v1/admin/models/providers/openai/test` → connected |
| google gemini (API key) | ✅ 145 ms | same endpoint → connected |
| ollama `glm-5.2:cloud` | ✅ 461 ms | live `/api/generate` → replied "ok" (ollama 0.24.0) |
| **xai (API key)** | ❌ **DEAD — HTTP 400 "Incorrect API key"** | provider test endpoint | 
| anthropic (API key) | — not configured (422 no key) | by design: claude-oauth covers Anthropic; metered key lane previously recorded dead |
| grok-web seat ($0 cookie lane) | ⚠️ degraded: `oauth-credentials=degraded, statsig-minting=degraded` | checkGrokSeat() direct run 19:03Z; NOT needs-login; owner-gated lane, untouched |
| gemini-web session lane | UNVERIFIED (API-key lane healthy; web lane not probed) | — |

**Owner actions:** (1) new `XAI_API_KEY` from console.x.ai — the Grok API lane is dead
until then; (2) grok-web seat wants its owner-gated refresh (degraded, not down).

X5 status: ✅ measured (2 owner actions pending to make it all-green).

## X6 APPROVAL TIERING — measured 2026-08-16 ~19:07Z (live Telegram probes)

| probe | expected (xclaw-parity) | observed |
|---|---|---|
| A: read-only `ls … | head -3` | auto-run | ✅ auto-ran, output verified against host |
| B: `echo x6-proof > /tmp/…` (risky write) | pend to owner | ⚠️ NO prompt — ran **sandboxed** (bwrap, `--tmpfs /tmp`): host untouched (verified absent), BUT bot replied **"Done — file written"** — the requested host effect never happened and the owner was not told. Truthfulness defect. |
| C: `system.ssh` to localhost (`requiresConfirmation: true`) | pend to owner | ❌ NO prompt — the ssh connection was **actually attempted** (real network, outside sandbox), permission-denied by sshd. |

**Root cause (proven):** `SUDO_AUTO_APPROVE=1` in `config/.env` → `PermissionManager.check()` returns `'auto'` for ALL tools (permissions.ts:139) → `needsConfirmation` false in tool-batch.ts:173 → `requestApproval()` never called. The full approval stack (telegram inline keyboards — senders registered at boot — exec-policy store, DANGEROUS_PREFIXES) is built and wired but globally bypassed by this one env var.

**Posture summary:** safety currently = sandbox containment only. `system.exec` is bwrap-contained (good), but `requiresConfirmation` tools (ssh, nginx, disk, network, cron-system, finance, gdrive, youtube) execute on the REAL host with zero gating.

**OWNER DECISION (not an agent call — Frank set full-auto deliberately):**
- (a) keep `SUDO_AUTO_APPROVE=1` (current: max autonomy, sandbox-only safety), or
- (b) xclaw-parity tiering: unset it, keep read-only/sandboxed auto via PermissionManager defaults, let `requiresConfirmation` tools pend to Telegram (60s timeout, machinery already live).

**Fix candidate regardless of (a)/(b):** probe B's reply must disclose sandbox containment ("wrote inside session sandbox; host path untouched") instead of claiming "Done — file written".

X6 status: ❌ not at xclaw parity under current config; one truthfulness defect filed.
