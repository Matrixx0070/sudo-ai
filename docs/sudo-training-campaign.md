# SUDO-AI Training Campaign

How SUDO-AI was trained to operate like a disciplined engineer on its own codebase —
and the in-loop fixes that made that behaviour reachable. Companion to
[`SELFBUILD_CHARTER.md`](./SELFBUILD_CHARTER.md).

## Premise

SUDO's *intelligence* is its model (`claude-opus-4-8`, per `config/sudo-ai.json5`).
A prompt does not add intelligence — it shapes **behaviour**. So "training" here means:

1. **Curriculum** — durable, always-on guidance in `assembleSystemPrompt()`
   (`src/core/brain/system-prompt.ts`), above the prompt-cache boundary.
2. **Supporting fixes** — in-loop / tool / infra changes that removed the mechanical
   blockers preventing the trained behaviour from completing.
3. **Supervised drills** — observe-first practice runs fired through the live gateway,
   each surfacing a concrete failure that fed back into (1) or (2).

The arc: from *"there's no actual task… I'm acting on stale context"* (SUDO disowning
its own completed work) → **autonomously shipping CI-green PRs** end to end.

---

## 1. Curriculum (system prompt, always-on)

All sections live above the cache boundary in `assembleSystemPrompt()`.

| Section | PR | What it instils |
|---|---|---|
| **Operating Principles** | #387 | VERIFY-NEVER-ASSUME · CHANGING YOUR OWN CODE (runtime knowledge, self-modify full-cycle, scoped tests, github.* PRs, sandbox-vs-repo) · WORK IN SMALL HONEST STEPS · ASK ONLY WHEN IT MATTERS |
| **Communication & Judgment** | #388 | Minimum formatting · match depth · own mistakes without grovelling · apply learned lessons silently · do less when risky · one question at a time |
| **Playbooks** | #389 | Worked tool-sequences: fix-a-bug · add-feature · diagnose-error · open-PR |
| **Tool-description mastery** | #391 | Sharpened the `system.exec` `target` param (sandbox is blind to the real repo) |

Refinements added as drills exposed gaps:

| Refinement | PR | Trigger |
|---|---|---|
| Scoped-test default | #386 | Drills ran the full suite to check one change |
| Sandbox-vs-repo + empty-output heuristic | #390 | SUDO read logs via the blind sandbox |
| Runtime self-knowledge ("you run SOURCE via tsx, not `dist/`") | #394 | SUDO judged "what's live" by checking stale `dist/` |
| Verify-before-PR ordering + concrete end-of-turn report | #403 | SUDO opened a PR *before* its final scoped test |
| Atomic ship path + don't-stop-after-verify | #406 | SUDO verified a change green then stopped before shipping |

---

## 2. Supporting fixes (made the behaviour reachable)

These are not prompt changes — they fixed mechanical traps in the agent loop, the
self-edit tools, and the GitHub connector that stranded an otherwise-correct turn.

| Fix | PR | Problem it removed |
|---|---|---|
| Window keeps the current user instruction | #392 | A >12-message turn evicted the instruction → "no instruction came through" |
| `meta.self-modify` read returns whole files (pages from the end) | #395 | Read middle-truncated a 198-line file → 5× re-read stagnation loop |
| Agent read cap raised; self-modify recognised as a read tool | #396 | A ~200-line module couldn't reach the model whole |
| Long-turn **work anchor** | #398 | A long turn evicted SUDO's *own* edits → it disowned its work |
| Collapse repeated AlignmentAggregator advisories | #399 | 4+ near-dup advisories filled the system-window, burying the instruction |
| `git ls-files` allowlisted; Intelligence Brief framed as background | #401 | A `git ls-files` refusal stalled the commit step; past-episodes read as a stale "current task" |
| `github.commit` empty-tree refusal made recoverable | #404 | Committing before editing dead-ended ("nothing to commit"), no retry |
| `github.open_pr` returns the tree to base | #408 | The shared checkout was stranded on the feature branch → next branch stacked on it |

Earlier enabling work (narrow-autonomy slices): self-modify `test` action + full-cycle
(#380), repo-allowlist + `repoExecEnv` sanitisation (#381/#384/#385), `SUDO_REPO_EXEC=1`
on prod (#383).

---

## 3. The drill campaign (supervised practice)

Drills were fired observe-first through the live gateway and watched via daemon logs +
the session DB — no merging of SUDO's output without independent verification.

**L3 micro-drills** established the basics and each found a gap:

- Scoped-test, verify-by-running, right-tool-for-code → **landed** in live behaviour.
- Reading logs via the blind sandbox → fix #390.
- Lost instruction across a long turn → fix #392.
- "Is the fix live?" judged against stale `dist/` → fix #394 (re-verify then passed).

**Full-cycle drills** (find → branch → edit → verify → PR) drove the rest:

| # | Outcome | Surfaced → fix |
|---|---|---|
| early | Stuck re-reading a 198-line file 5× | self-modify read truncation → #395/#396 |
| — | Found a real surrogate-split bug, then **disowned it** | long-turn self-amnesia → #398 (bug rescued as #397) |
| — | 81 exec calls, 0 edits, disowned ("no actual task") | context noise → #399 |
| — | Wrote a real test + verified, then disowned | `git ls-files` refusal + stale context → #401 (tests rescued as #400) |
| **5** | ✅ **Finished** — PR #402 (truncate edge) | first clean finish |
| **6** | Wrote + verified, but no PR | `github.commit` ordering dead-end → #404 |
| **7** | Wrote a green test, then stopped before shipping | ship-step follow-through → #406 (test rescued as #405) |
| **8** | ✅ **Finished** — PR #407 | validated #404 recovery + #406 anti-stop |
| **9** | ✅ **Finished, CI-green** — PR #409 | validated #408 tree-to-main + the full chain |

A recurring observation: SUDO's *work* became reliably good early (it finds real gaps,
writes green tests, self-verifies, and catches its own wrong assumptions). The last mile —
**shipping** (branch → commit → PR → clean tree) — is what the #404/#406/#408 fixes hardened.

---

## 4. Outcome

By round 9 SUDO reliably runs the whole loop autonomously:

> find a gap → read the real source → write the change → **verify before the PR** →
> `github.commit` (recovering from its own mis-ordered commit) → `open_pr` →
> working tree back on `main`.

Rounds 8 and 9 are clean, CI-green, end-to-end successes. Across the campaign SUDO
authored **five merged PRs** through the drills:

| PR | What SUDO wrote |
|---|---|
| #397 | Surrogate-safe head cut in `head-tail-buffer.ts` (a real latent bug it found) |
| #400 | 24-case unit suite for `core/shared/utils.ts` |
| #402 | `truncate()` `maxChars===1` edge-case test |
| #405 | `GoalStopDetector` + Skeptic Verifier coverage (11 cases) |
| #409 | `SudoError` hierarchy + `categorizeError` (drives LLM failover/backoff) |

(#407, a truncate test duplicating #402, was closed as redundant.)

---

## 5. Running a drill (repro)

Operator-side, against the live daemon (`sudo-ai-v5` under pm2):

1. Confirm the daemon is **stable** (uptime > ~100s) — a POST into a daemon mid-restart
   returns `ok:true` but the queued turn is silently eaten.
2. Snapshot `MAX(id)` from `data/mind.db` `messages` (do **not** range-filter `created_at` —
   `datetime('now','-N min')` mis-sorts against ISO `T` timestamps).
3. `POST http://127.0.0.1:18900/api/message` with `{peerId, text}` and
   `Authorization: Bearer $WEB_CHAT_TOKEN` (token from `/proc/$(pm2 pid sudo-ai-v5)/environ`).
4. Observe via daemon logs + the session's rows (web turns split across a primary/journal
   store — pull the full session before diagnosing a failure).
5. The full cycle needs `SUDO_GITHUB_TOOLS=1` and `SUDO_REPO_EXEC=1`. Restart-from-source
   deploys via `pm2 restart ecosystem.config.cjs --only sudo-ai-v5 --update-env` (plain
   `pm2 restart <name>` drops ecosystem env keys).

> Note: SUDO's git operations run in the *shared* working tree. #408 returns the tree to
> `main` after a PR is opened; an *abandoned* commit (no PR) can still leave it on a feature
> branch. Run drills from a clean `main` and confirm the branch afterwards.
