# NotebookLM Annex Status (F39–F80)

Living status doc. **Read this first each session.** Spec: `docs/NOTEBOOKLM_ROADMAP.md`.
Composes on the completed Drive roadmap (`docs/DRIVE_ROADMAP.md`, F1–F38 shipped+live).

## Phase status

| Phase | Scope | Status |
|---|---|---|
| N0 | Recon + core rails (E1/E2/E3) | **recon confirmed; build in progress (this PR)** |
| N1 | Broadcast surface | **build in progress (this PR)** — shapes+CLI+rituals+2 gap-repairs |
| N2 | Probe & verification | **shipped** — E4 engine + F40/F50/F58/F61/F63/F68 (#790) |
| N3 | Judgment/relationship/self-knowledge | **COMPLETE** — G-PLANNER+G-F32WIRE (#791), F69 (#792), F48 (#793), F54 (#794), F49+F66 (#795), F62 (#796), F59 (#797) all shipped |
| N4 | Lineage & society | **build in progress** — G-MODELGEN (#798), F64 (#800), F60 (#801), F65 fork-interviews (this PR) shipped; F67/F70/F56 remain |
| N5 | The Organ (optional autonomous) | todo (gated; not entered) |

## N0 recon — confirmed 2026-07-17

All F1–F38 modules present + test-hardened. `notebooklm/`, `returns`, `embassy` are net-new.
Load-bearing reuse points verified with signatures (see recon in git history). Three named
unknowns resolved: `modelGeneration` ABSENT (add), local transcription EXISTS
(`voice/whisper-local.ts`), planner consult hook NOT LIVE.

## Gap register (gap-repair protocol)

Structural gaps (minimal Drive-side repair PR first, then annex builds — D-N0.3):

| Gap | What | Blocks | Repair plan |
|---|---|---|---|
| ~~G-PLANNER~~ | **REPAIRED** — `src/core/agent/dead-end-seam.ts` (injected `setPlanDeadEndMatcher`, hot-path-safe: no core/gdrive import) wired into the live GoalPlanner at `loop.ts` (STRATEGY message gets a "previously-failed approaches" warning); cli.ts binds it to gdrive `matchDeadEnds`. | F69/F70/F73 (N3) | DONE — repair PR shipped. Annex adds precedent/assumption consults on the same seam. |
| ~~G-F32WIRE~~ | **REPAIRED** — `src/core/agent/second-opinion-seam.ts` (injected fire-and-forget `requestSecondOpinion`, in-process dedup) triggered from the veto gate on a CRITICAL-risk APPROVE; gdrive `runSecondOpinionCycle` composes export→independent dissent; reviewer pinned to the judge route (G-JUDGE). Opt-in `SUDO_SECOND_OPINION=1`. | F48/F65 (N3/N4) | DONE — repair PR shipped. |
| ~~G-F13~~ | Weekly self-diff — **REPAIRED** (src/core/gdrive/self-diff.ts, weekly cron, F53 topology slot). | ~~F42/F53~~ | DONE — Drive-side repair PR shipped. |
| ~~G-JUDGE~~ | **REPAIRED** — `sudo/judge` alias + `src/llm/judge.ts` (providerOf/isIndependentJudge/judgeFor: holds-for-human when judge shares a provider with a route under test). | E4/F64/F68 | DONE — repair PR shipped. |

Additive gaps (small, mechanical, done inside their phase):

| Gap | What | Phase |
|---|---|---|
| ~~G-MODELGEN~~ | **DONE** — `modelGenerationOf`/`currentModelGeneration` in aliases.ts (family+major, point releases dropped) + `modelGeneration` on `ResolvedRoute`; F64 succession watches it | N4 (F64) |
| ~~G-F46MARK~~ | **DONE** — comments.ts extracts `[F46]`/`F46:` marker → dataset row + memory name | N1 (F46) |
| G-CANARYWRITE | `registerCanary(entry)` writer (canary is read/trip only) | N4 (F67) |
| ~~G-F52RANK~~ | **DONE** — dream.ts ranks (orphaned>stale>hold); open-questions file carries `ranked[]` | N1 (F52) |
| G-PROPOSALS | `tasks/proposals/` folder key (blackboard peer-read grabs all `.json`) | N4 (F70) |
| G-F43 | incident-theater net-new (consumes `ops/incidents` + `unpackBundle`) | N1 (F43) |

## Decisions

- **D-N0.1** Materialized `docs/DRIVE_ROADMAP.md` from session text + STATUS ledger (spec file was absent) rather than block.
- **D-N0.2** Provenance stays JSON-in-`content` + belief graph; no new `StructuredMemory` column (no schema fork).
- **D-N0.3** Four structural gaps get minimal Drive-side repair PRs at the phase that needs them, then annex builds on them.
- **D-N0.4** `NlmClient`/programmatic NotebookLM access stays out of N0–N4 entirely (export-lane + rituals + returns only).
- **D-N0.5** notebooklm folders live under `sudo-ai/notebooklm/` via a self-contained `ensureNotebookLmTree` reusing `DriveClient` primitives — NOT appended to gdrive `CANONICAL_FOLDERS` (keeps the base tree clean when notebooklm is disabled).
- **D-N0.6** Master switch `SUDO_NOTEBOOKLM=1`, default OFF (mirrors `SUDO_GDRIVE`); requires `SUDO_GDRIVE=1`.

## Safety-critical acceptance fixtures (for spot-check)

| Fixture | File | Asserts |
|---|---|---|
| Zone screen sweep | `tests/notebooklm/zone-screen.test.ts` | seeded zone-1 record absent from every compiled shape; secrets regex catches |
| Returns routing | `tests/notebooklm/returns.test.ts` | filename convention → tier/category; unparseable held; quarantine-before-route |
| Judge independence | `tests/llm/judge.test.ts`, `tests/notebooklm/probe.test.ts` | student ≠ judge enforced; comparator HOLDS when judge shares student's provider |
| E4 end-to-end | `tests/notebooklm/probe-route.test.ts` | F40 probe-answers return → comparison report; external-only = dark memory; never ingests to memory |
| F61 Feynman gate | `tests/notebooklm/probe.test.ts` | blocks (blocked===true) when self coverage below threshold |
| F63 identity pulse | `tests/notebooklm/probe.test.ts` | alerts when identity answers drift from baseline |
| F68 curriculum ladder | `tests/notebooklm/probe.test.ts` | advances one rung on pass; holds on fail; fully offline |
| F69 error atlas | `tests/gdrive/error-atlas.test.ts` | clusters corrections into ranked themes; bias-priors preamble; zone-1 example screened out of the broadcast shape |
| F48 debate chamber | `tests/notebooklm/debate.test.ts` | symmetric FOR/AGAINST pack; reuses F32 conclusion-guard; zone-1 position never broadcast (fail-closed, zero partial writes) |
| F54 informed approval | `tests/notebooklm/informed-approval.test.ts`, `tests/gdrive/experimentation.test.ts` | explainer-bound token; gate grants ONLY on exact token; promoteCandidate HOLDS a required candidate until granted (harness-enforced, invariant 8) |
| F49/F66 dyad analysis | `tests/gdrive/dyad.test.ts` | windowed correction stats + trend (F66); persistent-blind-spot detection across time windows (F49); export shapes are zone-2 aggregates |
| F62 study-of-principal | `tests/gdrive/study-of-principal.test.ts`, `tests/notebooklm/no-zone1-export.test.ts` | operator model SEALED (AES-256-GCM); principal's words never plaintext at rest; wrong key → null; **no F62 shape in the export registry (zone-1 never broadcast)** |
| F59 reception | `tests/notebooklm/reception.test.ts` | sentiment/theme/confusion analysis of a returned transcript; reception Doc + EXTERNAL-tier memory; never the default chunk ingest |
| F64 succession | `tests/notebooklm/succession.test.ts` | generation change → PAUSE; sealed successor pack (ciphertext at rest); ack token-bound; pulse-before-ack holds; alerting pulse holds for human; resume only when acked+pulsed → baseline advances |
| F60 forks museum | `tests/gdrive/forks-museum.test.ts` | past-self catalog (metadata only, newest era first, junk skipped); zone-2 museum shape; F60:dialogue return → external-tier memory |
| F65 fork interview | `tests/notebooklm/fork-interview.test.ts` | packet-bound token; grants only on PASS+token; FAIL holds; adoptFork BLOCKED until passed (harness-enforced); F65:interview return route |
| (later) embassy verbatim | tbd (N4) | verbatim-dump held, authored distillate external |

## Annex B — API-day upgrade map (maintain from day one)

| Ritual | Becomes |
|---|---|
| add/refresh sources | `sources.sync(shapeRegistry)` nightly |
| generate Audio/Video | `studio.generate` on cadence; audio → returns → F59 |
| chat probe answers | `notebook.query(probeSet)` → E4 |
| flashcard/quiz | `studio.flashcards(corpus)` |
| Deep Research | `research.run(target)` → returns |
| paste-backs | eliminated; E2 consumes API payloads, same provenance rules |
