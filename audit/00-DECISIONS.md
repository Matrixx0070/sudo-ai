# 00-DECISIONS — calls made instead of asking

Format: `D-nn | decision | reasoning | reversibility`

---

## D-01 | Interpret "the top of what the audit says to build" as scoped to YouTube autonomy, not general repo health
The brief's Phase 1 capability list is entirely YouTube-operations vocabulary (channel setup, YPP,
Studio ops, thumbnails, RPM). So the audit subject is: *can SUDO-AI run an autonomous YouTube
channel business*, using the existing repo as the substrate. Not a general architecture review.
Reversible: yes — the inventory work is reusable either way.

## D-02 | Repo is read-only in Part One, enforced by convention not by tooling
No git checkout/stash/install during Phase 0-4. Only `./audit/**` is written. The pre-existing dirty
files (`src/llm/client.ts` modified, plus 4 untracked scratch files) are LEFT ALONE — they belong to
a prior session (memory: `client.ts` deploys need stash-ff-pop). I will not clean them up.
Reversible: n/a.

## D-03 | Branch cut point
Part Two branches `sudo-ai/yt-autonomy` from **current HEAD a928d526** as instructed, not from `main`.
HEAD is on `feat/grok-web-chat-brain`. Cutting from HEAD means the branch carries unmerged Grok-seat
work. Chose HEAD anyway because the brief said "cut from the current HEAD" explicitly.
The dirty working-tree files are NOT carried into commits (they stay unstaged).
Reversible: yes — rebase onto main later.

## D-04 | Subagent fan-out unavailable — running the audit single-threaded
At 16:36Z I launched 3 read-only inventory subagents. All three returned immediately with
`You're out of usage credits. Run /usage-credits to keep using Fable 5` and zero tool uses.
Consequence: no parallel fan-out. The entire audit is done in one context by me, which means
I must be economical — I read the files that decide the verdict, not every file in the repo.
Where that forces a coverage cut, the affected capability row is marked **UNVERIFIED** rather
than guessed. Reversible: yes — re-run inventory with credits restored.

## D-05 | Took all four P0 items, stopped before P1
`04-ROADMAP.md` Phase A is GAP-01, GAP-02, GAP-04a, GAP-03. All four shipped. I did not start P1
because `pnpm verify` is red for pre-existing environmental reasons (see D-07) and building further
on an unverifiable baseline is worse than stopping. The brief asked for depth over coverage.

## D-06 | BLOCKED: `src/core/tools/builtin/meta/comment-engine.ts` reads YOUTUBE_OAUTH_TOKEN directly
`src/core/tools/builtin/meta/` is in `PROTECTED_PATHS` (`protected-paths.ts:32`). That wrapper still
reads the static env token and so still dies at the 1h mark. I routed around it: the underlying
`src/core/youtube/comment-engine.ts` (unprotected) now uses the refreshing provider, so the
capability is fixed at the source. The protected wrapper needs a one-line migration by someone with
authority to edit protected paths. **Requires Frank.**

## D-07 | `pnpm verify` reported RED, not massaged to green
6 tests across 5 files fail in this working tree. I did NOT fix them, skip them, or quietly omit
them. Instead I proved they are not mine: worktree at base `a928d526` with identical `data/`,
`workspace/`, and the same uncommitted `src/llm/client.ts`, running the same five files —
**identical failure set, zero mine-only regressions.** Detail in `06-BUILD-REPORT.md`.
Reasoning: a false "verify green" is exactly the kind of claim the brief called the worst thing to
hand over. Reversible: yes, once the other session commits or reverts `src/llm/client.ts`.

## D-08 | Policy gate built as a library, not yet wired onto the publish path
`assessPublishCandidate()` is complete and tested but nothing calls it before upload. Wiring it
requires a publish orchestrator that does not exist yet, which is a P1-sized piece of work. What
stands between the system and a real channel today is `SUDO_YT_PUBLISH_ENABLED` (default OFF).
Listed as next-action #1 in `06-BUILD-REPORT.md`. Reversible: yes.

## D-09 | No new dependencies
The similarity check is plain word-trigram Jaccard rather than an embedding call. Zero deps added,
deterministic, testable offline, and good enough for the "one template, 200 videos" case that
actually matters. Embeddings can be swapped in behind the same signature later.

## D-10 | Did not add policy-gate.ts to PROTECTED_PATHS despite arguing it belongs there
By the same logic as `veto-gate.ts`, a safety gate an agent can edit is not a safety gate. But
`protected-paths.ts` is itself protected, so I cannot add it. Surfaced as a recommendation in
`06-BUILD-REPORT.md`. **Requires Frank.**
