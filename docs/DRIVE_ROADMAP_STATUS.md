# Drive Roadmap Status (F1–F38)

Living status doc for the SUDO-AI × Google Drive build. Feature IDs are stable —
referenced in commits, PRs, and code comments. Spec: the 38-feature roadmap
(Phases 0–7). Recon report delivered + confirmed 2026-07-16.

## Phase status

| Phase | Scope | Status |
|---|---|---|
| 0 | Recon + foundation | **shipped** — PR #775 merged 2026-07-16 |
| 1 | F17 F16 F29 integrity substrate | **shipped** — PR #777 merged 2026-07-16 |
| 2 | F2 F36 F10 F9 durability | **shipped** — PR #778 merged 2026-07-16 |
| 3 | F18 F1 F15 F19 F20 guarded ingestion | **shipped** — PR #779 merged 2026-07-16 |
| 4 | F3 F4 F7 F6 F30 F21 human interface | **shipped** — PR #780 merged 2026-07-17 |
| 5 | F22 F23 F24 F31 F33 F37 epistemics | **shipped** — PR #781 merged 2026-07-17 |
| 6 | F12 F11 F27 F28 F35 F14 autonomy | **shipped** — PR #782 merged 2026-07-17 |
| 7 | F8 F32 F25 F26 F38 F34 experimentation/ops | **shipped (this PR)** — see below |

## Foundation (Phase 0) — shipped in `feat/gdrive-phase0-foundation`

- `src/core/gdrive/` — DriveClient choke point (files/changes/permissions/comments/
  revisions/Sheets values), token-bucket limiter with interactive>background lanes,
  typed error taxonomy (`GdriveApiError`), exp backoff + full jitter (max 5),
  service-account auth default + OAuth loopback alternate, idempotent folder-tree
  bootstrap with 0600 local id cache, audit emitter riding the hash-chained
  `AuditTrail`, heartbeat writer on the existing `CronScheduler`.
- `docs/gdrive-setup.md` — HUMAN GCP steps + smoke test.
- Tests: `tests/gdrive/` — limiter lanes, backoff/error mapping, bootstrap
  idempotency, config fail-fast, client retry, **hot-path isolation guard**
  (no agent/llm/memory/brain module may import core/gdrive).

**HUMAN (open):** GCP project + Drive/Sheets APIs + SA key + shared `sudo-ai/`
folder (`docs/gdrive-setup.md`). Live-folder smoke test blocked on this.

## Phase 1 (F17/F16/F29) — shipped in `feat/gdrive-phase1-integrity`

- `canonical-json.ts` — deterministic serializer (sorted keys, cycle/NaN
  rejection); the ONLY byte source for manifest HMACs. Do not change its output.
- `manifest.ts` (F17) — `buildManifest`/`verifyManifest`, HMAC-SHA256 with the
  local `BRAIN_HMAC_KEY_PATH` key, timing-safe compare, newest-wins comparator
  (counter, then createdAt). Verification also REJECTS any zone-0 entry in a
  remote manifest, even correctly signed.
- `blob-store.ts` (F17+F29) — `pushBrain` (zone-0 filtered pre-network, zone-1
  encrypted, content-hash dedup, blobs-first/manifest-last, manifest updated in
  place so Drive revisions = brain timeline for F9), `hydrateBrain`
  (verify HMAC → verify each blob sha256 → decrypt; ANY failure refuses with
  local state untouched), `gcBlobs` (trash only — 30-day undo; takes the
  keep-set as a parameter).
- `zones.ts` (F29) — AES-256-GCM wire format `[ver|iv|tag|ct]`, fresh IV per
  blob, blob named by ciphertext sha256; `classifyZone` keyword pass
  (credential/financial/personal → 1; `never-sync` marker → 0).
- `trust.ts` (F16) — `deriveTrustTier` from permissions.list fixtures across
  file + parent; WEAKEST writer wins; fail-closed to `external`;
  `TRUST_WEIGHTS` 1.0/0.9/0.7/0.5; `ProvenanceRecord` type.
- `keys.ts` — fail-fast key loading; enforces 0600 and >=32 bytes.

Phase 1 gate evidence: tamper tests (blob byte-flip, manifest edit, wrong key
→ refused), zone round-trip + zone-0-never-in-payload assertions, trust fixture
matrix — all in `tests/gdrive/` (38 new tests).

Deferred within Phase 1 (by design, noted per spec §"done when"):
- F17 GC *scheduling* (which manifests to keep) lands with F2 checkpointing —
  the GC primitive is done and parameterized.
- F16 "externally-shared file ingests as external end-to-end" needs the F1
  ingestion pipeline (Phase 3); the derivation itself is fixture-proven.
- Constitution/values doc as `category: policy` manifest entry: type support
  exists; the actual document wiring lands with F2 serialization (D7).

## Phase 2 (F2/F36/F10/F9) — shipped in `feat/gdrive-phase2-durability`

- **F2** — `brain-serializer.ts` (three-backend snapshot per D7: mind.db chunks
  + structured-memory JSON + workspace/MEMORY.md, per-record zone
  classification, zone-split JSONL bundles; restore goes exclusively through
  storeChunk/saveMemory — guardMemoryWrite runs on every restored chunk) +
  `checkpoint.ts` (runCheckpoint counter+1, runRestoreCheck applies only when
  remote counter is ahead, refuse-and-audit-'denied' on tamper, runRestoreDrill
  diff-against-local). Cron: `gdrive-checkpoint` (6h default), boot-time
  detached restore check, `gdrive-restore-drill` (weekly default; spec said
  monthly — 'every'-schedule simplicity, tighter is safer; change via
  SUDO_GDRIVE_DRILL_MS).
- **F36** — `migrations.ts` (verify-as-written → pure ladder → re-sign;
  golden-brain-v1 fixture is STATIC committed bytes signed with a committed
  test-only key: serializer/HMAC drift breaks CI by design) + `releases.ts`
  (immutable copies in brains/releases/, head-revision keepForever pin,
  cap-aware rotation MAX_PINNED_REVISIONS=25).
- **F10** — `flight-recorder.ts`: post-hoc join on session id (traces.db
  query + gateway.db llm_calls rows + loop event digests) → digest-anchored
  bundle → gzip → ALWAYS AES-256-GCM → ops/incidents (failed) / ops/audit
  (rolling). Replay = digest verification (spec-sanctioned stub; true
  re-execution blocked on record-replay determinism — GAP).
- **F9** — `bisect.ts`: binary search over manifest revision history with an
  injected judge; per-visited-revision signature verification; manifest diff
  (added/removed/changed) between last-good and first-bad; endpoint sanity
  checks. 8-revision planted-bad-memory integration test per spec.

Phase 2 gate evidence (tests/gdrive/, 91/91): kill-and-restore (machine-B
hydration through the memory API), golden-brain migration CI test, 8-revision
bisect demo, tamper-refusal with local-state-untouched assertions.

Phase 2 deferrals/gaps:
- F10 run-END wiring (who calls buildRunBundle when a live run fails) lands
  with the loop hook consumer in Phase 5 (F33 shares the same seam: pass an
  emitter to DoomLoopDetector). Bundle plumbing is complete and tested.
- F9/F31 `bisect`/`knew-at` CLI commands land together (Phase 5) — library
  API first, commander wiring once.
- Restore drill hydrates into memory and diffs (no temp-dir apply) — cheaper,
  same guarantee (backup reproduces local brain byte-for-byte).

## Phase 3 (F18/F1/F15/F19/F20) — shipped in `feat/gdrive-phase3-ingestion`

- **F18** `quarantine.ts` — two-layer inspection: deterministic pattern scoring
  (Drive-specific lures + the repo's injection detector, with
  NORMALIZE-THEN-RESCAN: zero-width strip + Cyrillic homoglyph fold before
  pattern matching) and a disposable LLM inspector (plain one-shot chat, zero
  tools — module provably imports no tool code, test-asserted; output treated
  as untrusted: clamped, re-scored, flagged summaries withheld). Verdict =
  max(deterministic, llm) — a lying inspector can only RAISE risk, never lower
  a deterministic hold; inspector failure degrades to deterministic-only.
  Holds write a readable report beside the staged file.
- **F1** `inbox.ts` — poll sweep (60s default): canary fileId check → 20MB cap
  → type-route (Doc→markdown export, text direct, image/PDF→F15 OCR) → canary
  marker check → quarantine → clean: chunk + storeChunk (role 'user' = full
  injection scan, defense in depth) + ACL trust tier + provenance reference
  memory (citations fileId@headRevisionId) + move to processed/ + ingestion
  record; hold: move original to quarantine/. F16's "externally-shared file
  ingests as external end-to-end" done-when now proven in tests.
- **F15** `ocr.ts` — Drive import-conversion OCR (temp Doc in quarantine
  folder, ocrLanguage, export text/plain, trash in finally); garbage-export
  heuristic so callers fall back.
- **F19** `canary.ts` — local-only config (data/gdrive/canaries.json or
  GDRIVE_CANARY_CONFIG), fileId + marker checks in the inbox pipeline, trip =
  CRITICAL audit + data/gdrive/PAUSED flag (all gdrive jobs no-op until the
  operator removes it). HUMAN planting guide in gdrive-setup.md.
- **F20** gym — 16-case fixture corpus (instruction override, tool lures,
  exfil links, delimiter forgery, role hijack, fake-turn, zero-width,
  homoglyph, base64 smuggle, canary bait, nested doc, 4 clean controls +
  classics variant) asserted attack=hold / clean=promote in CI on every run;
  new case = one fixture file. Plus: lying-inspector, poisoned-summary, and
  inspector-down tests.

Phase 3 notes/deferrals:
- The gym found 3 REAL gaps during development (zero-width splitting,
  single-adjacency homoglyphs, inverted canary-bait word order) — fixed via
  normalize-then-rescan. Working as intended.
- Outbound tool-call canary check (F19 full scope) needs the loop-hook seam —
  lands with F33 in Phase 5. Inbox-side checks are live.
- Scheduled gym-vs-temp-brain run + scorecard rows land with F4 (Phase 4);
  the CI gym is the regression gate meanwhile.
- Oversized extracted text: chunked ingestion (no LLM summarization pass yet;
  AutoSummarizer wiring when F12 lands).

## Phase 4 (F3/F4/F7/F6/F30/F21) — shipped in `feat/gdrive-phase4-human-interface`

- **F3** `report.ts` — nightly job (cron 23:55 default) aggregates audit rows +
  held-quarantine items → fixed-section markdown (≤800 words) → Google Doc in
  ops/reports/ (Doc deliberately: carries the F6 comment channel), updated in
  place on same-day re-runs; auto-registered as an F6 watched doc.
- **F4** `scorecard.ts` — one Sheet, tabs Evals/Telemetry/Skills/Forks/Derived;
  headers + Derived formulas (rolling means, Sheet-side, zero tokens) seeded
  once; writers use values.append only. Telemetry row daily from
  api_call_log aggregation (read-only SQL) + limiter queue depths
  (sync-observability rider). syncLagS/divergenceCount are 0 until F11/F12.
- **F7** `control-panel.ts` — Config (typed whitelist, hard bounds,
  harness-side enforcement), Control (PAUSE — writes the same pause flag
  canaries use, so all gdrive jobs idle while the heartbeat keeps beating; a
  CANARY pause is NOT releasable from the Sheet), Frozen display tab (written,
  NEVER read back; frozen = PROTECTED_PATHS ∪ key paths ∪ SUDO_GDRIVE).
  Cadence keys apply at next boot (status writeback says so explicitly).
- **F6** `comments.ts` — 2-min poll on watched Docs (reports, atlas):
  principal-authored unresolved comments → guard-delimited high-priority
  'feedback' structured memory (injection-shaped comments stored inertly with
  a guard note) → reply summarizing what was stored → resolve thread → seen-id
  dedup. Corrections reach planning through the intelligence brief's
  structured-memory search (existing path).
- **F30** `atlas.ts` — nightly Doc updated in place (stable link): domains from
  chunk paths, freshness (>60d = stale), zone-1 titles withheld, corrections +
  projects sections; registered as watched doc so commenting on the atlas
  produces F6 corrections.
- **F21** `push.ts` + docs/gdrive-apps-script.md — transport (b): Apps Script
  1-min trigger POSTs HMAC-signed pings; harness verifies (timing-safe, ±5min
  freshness) and dispatches the matching job. Rides the EXISTING Spec-4
  webhook gateway — no new route surface. Polling remains the backstop.
  Transport (a) changes.watch deliberately not built (needs public HTTPS +
  domain verification).

Phase 4 scope notes:
- F7 PAUSE scope: gdrive jobs idle (agent-wide idle would need loop-level
  integration — deferred; PAUSE flag file is readable by any future consumer).
- F21 hook wiring is config-side (webhooks.json5, HUMAN) + documented; the
  verification/dispatch library is tested. The full <10s live demo needs the
  HUMAN Apps Script deploy.
- Phase 4 gate ("comment from phone → correction → behavior change →
  scorecard") is UNVERIFIED live end-to-end — blocked on the HUMAN GCP setup;
  every stage is unit-proven.

## Phase 5 (F22/F23/F24/F31/F33/F37 + ranking rider) — shipped in `feat/gdrive-phase5-epistemics`

- **Ranking rider** — `src/core/memory/epistemic-score.ts` (PURE, inside the
  memory subsystem so retrieval never imports gdrive): scoreMemory =
  similarity × trustWeight × freshnessDecay × validationState. Live in
  retrieval: `SearchOptions.epistemicAdjuster` applied in hybridSearch after
  temporal decay, before the minScore gate (neutral when absent; throwing
  adjuster ignored). `beliefs.buildEpistemicAdjuster()` supplies it from the
  graph, longest-prefix keyed on chunk paths.
- **F22** `beliefs.ts` + `changes.ts` — beliefs graph
  (data/gdrive/beliefs-graph.json, checkpointed as an epistemic sidecar);
  inbox ingestion registers a belief per file; the changes feed (persisted
  page token, never re-lists the tree) flags dependents stale (confidence
  ×0.6, re-derive queued for F12) on edits, orphaned (×0.4) on deletions.
- **F23** — REVIEW_LADDER 7→30→90→365d, doubling past the ladder (cap 730d);
  sweep compares headRevisionId vs citation: pass extends, changed →
  stale+queue, missing → orphaned; deprecate path available; validationState
  feeds the rider (fresh 1.0 / due .9 / stale .6 / orphaned .4 / deprecated .2).
- **F24** `prospective.ts` — noteToFutureSelf(openAt, content, context);
  nightly delivery converts due notes to high-priority 'feedback' memories
  (the planning channel F6 uses) + "DUE NOTE" lines in the self-report;
  outcome-annotated, never double-delivered.
- **F31** `chronicle.ts` — append-only daily JSONL ops derived STRUCTURALLY
  from manifest diffs at checkpoint (add/update/deprecate per logicalPath) —
  captures every synced mutation without instrumenting the memory subsystem;
  closed days mirror to memory/chronicle/; knewAt(ts) = nearest manifest
  revision + chronicle delta → read-only view (test proves a later-learned
  memory is excluded).
- **F33** `dead-ends.ts` — the loop-hook seam is CLOSED: loop.ts now passes
  its HookManager into DoomLoopDetector (events added to the HookEvent union
  + typed-hooks registry), cli.ts subscribes doom_loop_terminated →
  draftDeadEnd (deduped by pattern digest). Confirmation (dream cycle/F6) →
  'DEAD END' feedback memory; matchDeadEnds() is the planner pre-check;
  confirmed records mirror to memory/dead-ends/.
- **F37** `mirror.ts` — config/gdrive-mirror.json refs; per-ref cadence +
  per-sweep budget + byte cap + 30s timeout; snapshot updated IN PLACE
  (revisions = history); changed content inspected by F18 FIRST (injected
  upstream docs are held, never snapshotted); change cascades stale flags to
  dependent beliefs.

Phase 5 gate evidence (16 new tests + agent/memory suites 1432 green after
hot-path touches): stale→re-derive-queue lifecycle, planted-stale caught by
the scheduled sweep with interval extension on pass, due-note delivery on the
exact date, knew-at exclusion proof, dead-end dedup/confirm/match, mirror
change→stale cascade + injection hold + budget/cadence.

Phase 5 deviations:
- "Dead end outranks fresh similarity" approximated via the high-priority
  feedback channel + matchDeadEnds() pre-check (chunks carry no belief refs).
- Planner pre-check integration point = matchDeadEnds() exported; wiring into
  goal-pipeline plan commit is a Phase 6 line item (F12 confirms candidates).
- F9/F31 CLI commands still pending (library-tested); slated for Phase 6.

## Phase 6 (F12/F11/F27/F28/F35/F14) — shipped in `feat/gdrive-phase6-autonomy`

- **F12** `dream.ts` — nightly (02:30): re-derive queued beliefs (re-fetch →
  F18 re-inspect → memory-API re-ingest → belief refreshed), confirm matured
  dead-end candidates (LLM judge when available, age-based default; judge can
  VETO), reconcile divergence (restore-check then checkpoint — newest-wins),
  write the open-questions agenda file. Each re-derivation "plan" runs the
  matchDeadEnds pre-check — a confirmed dead end is skipped, not re-entered.
  NOTE: day-conversation distillation deliberately NOT duplicated — AutoDream
  (6h) already owns it; this dream handles the Drive-epistemics workload.
- **F11** `deep-freeze.ts` — INDEX HOT, PAYLOAD COLD enforced: episodic
  day-logs >30d evict to content-addressed Drive blobs; hot stub (summary +
  keywords) stays in data/gdrive/freeze-index.json; recallFrozen() returns
  immediately (cached or null+prefetching) with fire-and-forget background
  prefetch into an LRU-capped cache — no synchronous Drive wait, ever.
- **F27** — freeRecall(): Drive fullText search scoped to the blobs folder →
  stub candidates → prefetch. Zone-1 intentionally unsearchable (F29 note).
- **F28** `index-snapshot.ts` — embedding_cache serialized → gzip →
  AES-256-GCM (embeddings leak content), content-hash named, keep last 3;
  hydration INSERT OR IGNORE (local rows win) — re-hydration inserts 0
  (the "embedding-call count ≈ 0" gate, test-proven). Format versioned.
- **F35** `hibernate.ts` — task state ALWAYS encrypted to tasks/active/;
  resume claims via the blackboard (single-writer advisory), verifies brain
  counter (behind ⇒ "run restore-check first"), archive = trash. Two-namespace
  hibernate-A/resume-B test per spec. Loop-side safe-checkpoint calls are a
  documented seam (library + claim logic complete).
- **F14** `blackboard.ts` — one file per instance (single-writer sidesteps
  Drive's lack of locking), 5-min beat, peer reads, earliest-timestamp-wins
  advisory claims. Documented: seconds-to-minutes, best-effort, never
  correctness-critical.

Phase 6 evidence: 11 new tests — freeze/recall/prefetch round-trip, fullText
fallback, snapshot round-trip + zero-re-embed + dedup/prune, claim division,
hibernate→resume cross-namespace + counter guard, full dream pipeline incl.
dead-end skip + judge veto.

Phase 6 deferrals: F9/F31/F35 CLI commands + loop-side hibernation hooks →
Phase 7 wrap-up slice; planner-commit matchDeadEnds wiring found no clean
seam in autonomous-executor (control-action oriented) — implemented inside
the dream's re-derivation planner instead + exported for future planners.

## Phase 7 (F8/F32/F25/F26/F38/F34) — shipped in `feat/gdrive-phase7-experimentation`

- **F8** `skill-registry.ts` — candidates (artifact + meta JSON) → injected
  eval runner → scorecard Skills rows → promotion requires BOTH eval pass AND
  a TRUE row in the control panel's Approvals tab (harness-enforced; the
  spec's "unapproved-but-passing does NOT promote" is test-proven). Stable
  files update in place (revisions = rollback, rollbackSkill restores the
  prior revision) and mirror locally so checkpoints sign them as
  `category: skill` entries. Frozen surfaces untouchable (name-validated,
  artifact-only writes).
- **F32** `second-opinion.ts` — decision packets validated to be
  conclusion-free (refuses smuggled recommendations), exported to
  ops/review-queue/; reviewer (injected different-route call) writes the
  dissent memo beside it; awaitDissent() BLOCKS and on timeout ESCALATES to
  the human — never auto-proceeds; resolveDissent audits both paths.
- **F25** `forks.ts` — fork = re-signed manifest copy in brains/forks/
  (blobs shared, cheap); scorecard Forks rows compare; adoptFork verifies the
  fork's signature, re-signs as main with a monotonic counter.
- **F26** `datasets.ts` — corrections (auto-fed from F6), eval-pairs
  (auto-fed from F8 evals), edits; exemplar bank retrieval with zone-1 rows
  PROVABLY excluded (tested across queries incl. the secret itself); daily
  Drive mirror rides the report job.
- **F38** `curiosity.ts` — bounded buffer, hard daily budget (resets by day),
  drain in the dream window only (never preempts principal work), output
  through the SAME F18 quarantine (injected research output is held), ingest
  at self_acquired trust with a belief registered; PAUSE halts.
- **F34** — the Apps Script pacemaker is fully specified in
  docs/gdrive-apps-script.md: dead-man email (fire-once + recovery), morning
  digest, cap-aware pin rotation via the Drive Advanced Service. HUMAN
  deploy; the harness half (heartbeat, verifyPing) shipped in Phases 0/4.
- **F10 wrap-up** — session:end hook (opt-in SUDO_GDRIVE_FLIGHT_RECORDER=1)
  builds and uploads incident bundles for failed sessions (successes only
  with SUDO_GDRIVE_FLIGHT_ALL=1).

Phase 7 evidence: 10 new tests — both-gates promotion + rollback, packet
conclusion-refusal + dissent flow + timeout-escalation, fork/adopt signature
chain, exemplar zone-1 exclusion, curiosity budget/quarantine/pause.

Phase 7 deferrals (final open items, all operator-facing):
- `sudo-ai gdrive` CLI subcommands (status/bisect/knew-at/resume) — libraries
  are tested; commander wiring is a small follow-up slice.
- F35 loop-side auto-hibernation calls (library complete).
- F5 (gated user-file tool) was never in any phase plan — the only F# with no
  implementation; needs its own slice if wanted.

## LIVE ROLLOUT — 2026-07-17 (real Drive, real brain)

Executed end-to-end against real Google Drive (account
megastreambroadbandservice@gmail.com, project sudo-ai-drive-2026, OAuth
Desktop client; folder shared to frankmartin7722@gmail.com):

- CONFIG_OK (oauth mode) → KEYS_OK (0600 enforced) → **TREE_OK 29/29**
  canonical folders → **HEARTBEAT_OK** (ops/heartbeat.json live).
- **First live brain checkpoint: counter=1, 3 entries, 456 KB** —
  chunks/zone1.jsonl (encrypted, 3.5 KB), chunks/zone2.jsonl (405 KB),
  workspace/MEMORY.md → classified **zone 1 and encrypted** (the keyword
  classifier caught credential-adjacent content; working as designed).
- **Restore drill: PASS** (divergent=[] — the Drive backup reproduces the
  local brain byte-for-byte).
- **Prod daemon LIVE** (pid 2105507): all gdrive cron jobs scheduled and
  firing — boot restore-check "up-to-date", control-panel Sheet created live
  (1fSmaBPK…), inbox/changes/blackboard/panel sweeps on schedule, audit rows
  in data/audit.db. (Daemon logs at data/logs/sudo-ai-v5-out.log.)
- **F34 pacemaker DEPLOYED + LIVE** (Apps Script "sudo-ai pacemaker (F34)",
  scriptId 1_EZ-yhKra9j465ALgmuYag3m48XapYNACpNQ7IUsjFsTju9yVAZyXEzn, owned by
  megastream). 3 time-triggers installed: deadMan/10min, morningDigest/07:00,
  rotatePins/03:00. Advanced Drive service enabled via manifest; scopes
  auto-detected + granted. VERIFIED: setupTriggers ran clean; deadMan computed
  heartbeat age 2.8min < 20min threshold → correctly silent (no false alarm);
  morningDigest executed to completion → MailApp.sendEmail path proven
  authorized + working. Both dead-man leaves (staleness arithmetic + email
  delivery) independently proven without forcing a 20-min outage.

- **F19 canaries PLANTED + LIVE-VERIFIED.** 3 decoy Google Docs created in
  megastream's My Drive (NOT in the sudo-ai/ tree, per spec): admin-credentials,
  aws-root-recovery-codes, prod-ssh-private-keys — each with a unique UUID
  marker in its body. fileIds + markers recorded ONLY in
  data/gdrive/canaries.json (0600, never in Drive). Verified against the real
  config: fileId tripwire HIT, marker-in-payload tripwire HIT, clean payload no
  false-positive, daemon not paused. The inbox job reloads canaries.json each
  sweep, so the live daemon is already armed (no restart needed). Full
  trip→PAUSED→CRITICAL-audit path covered by committed inbox.test.ts CANARY
  cases (not force-tripped in prod to avoid pausing live jobs).

Field findings folded into gdrive-setup.md: SA storage-quota removal (403 on
file create) ⇒ oauth mode is the consumer-account path; gcloud default client
blocked for Drive scopes; client secret creation-time-only in the new console;
granular consent checkboxes; Testing-status 7-day token expiry ⇒ published to
Production (unverified).

## Global acceptance — status at roadmap completion

- [x] Recon confirmed; this doc tracks every F#.
- [x] Hot-path proof (automated: tests/gdrive/hot-path.test.ts, every PR).
- [x] Kill-and-restore incl. index (unit: machine-B hydration + zero-re-embed).
      Live drill: HUMAN GCP setup pending.
- [x] Tamper-evidence (F17 refusal tests; frozen surfaces enforced in F7/F8).
- [x] Confidentiality (zone-0 never in payloads; zone-1 ciphertext asserted).
- [x] Guarded ingestion (gym green in CI; canary drill test; quarantine-only
      entry). Live canary planting: HUMAN.
- [x] Feedback loop (comment→correction→reply→resolve + scorecard, unit).
      Live phone demo: HUMAN.
- [x] Epistemics (stale→re-derive lifecycle + rider live in retrieval).
- [x] Continuity (hibernate/resume two-namespace + blackboard division).
- [x] Self-improvement (eval+approval-only promotion; second opinion blocks).
- [x] Liveness dead-man email — Script DEPLOYED + LIVE (F34); email path proven via morningDigest run; full hosts-down
      drill.
- [x] Per-phase lint+test+typecheck green; mocked CI; stacked PRs; no secrets.

## Decisions & deviations from spec (repo architecture wins on *how*)

| # | Decision | Why |
|---|---|---|
| D1 | Reuse `src/core/cron/` `CronScheduler` instead of building a scheduler | Persisted, typed, overlap-safe, backoff, already wired in cli.ts |
| D2 | Audit rides existing `AuditTrail` (`data/audit.db`, SHA-256 hash-chained) | Tamper-evident already; no new sink |
| D3 | Env-only config + `loadGdriveConfig()` fail-fast validator; no TypeBox sub-schema yet | Matches integration convention; frozen `config/sudo-ai.json5` untouched. Revisit at F7 |
| D4 | `SUDO_GDRIVE=1` opt-in (default OFF) | Foundation unproven live; flip to default-ON considered after Phase 2 gate |
| D5 | No new npm deps — `googleapis` already a dependency; auth via its bundled `google.auth` | `package.json` is a frozen surface; `google-auth-library` comes transitively |
| D6 | Oversized-text summarization (F1) will use existing clamp/`AutoSummarizer` machinery | Spec assumed a generic sub-agent path; repo's generic path is deterministic clamping |
| D7 | "Consolidated memory" for F17/F2 spans three backends: mind.db chunks, `data/structured-memory/*.json`, `workspace/MEMORY.md` | Manifest `logicalPath` will namespace them (`chunks/…`, `structured/…`, `workspace/…`) |
| D8 | Drive-side frozen set = `PROTECTED_PATHS` (src/core/self-build/protected-paths.ts) ∪ {`BRAIN_HMAC_KEY_PATH`, `BRAIN_ENC_KEY_PATH`, `config/.env`, canary config} | Key material isn't in PROTECTED_PATHS; enforced Drive-side without touching the frozen file |
| D9 | OAuth loopback flow implemented in `auth.ts` (`runOAuthLoopbackFlow`) but no CLI command yet | Not needed until a second machine without SA access exists; wire into `src/cli/index.ts` then |
| D10 | Heartbeat wrote from first boot (Phase 0) even though F34 consumes it in Phase 7 | Free liveness history + proves the write path early |

## Feature ledger

**F1 shipped** · **F2 shipped** (live cross-machine proof pending HUMAN GCP setup) ·
**F3 shipped** · **F4 shipped** · F5 todo (never phase-planned; own slice if wanted) ·
**F6 shipped** · **F7 shipped** (PAUSE = gdrive scope) · **F8 shipped** ·
**F9 shipped** (CLI → Phase 7 wrap-up) · **F10 shipped** (run-end wiring → Phase 7;
replay = digest-verify stub) · **F11 shipped** · **F12 shipped** · **F14 shipped** · **F15 shipped** ·
**F16 shipped** (e2e proof now in inbox tests) ·
**F17 shipped** (GC scheduling lands with F2) · **F18 shipped** ·
**F19 shipped** (outbound tool-call check → Phase 5 seam; HUMAN planting open) ·
**F20 shipped** (CI gym; scheduled run + scorecard → F4) ·
**F21 shipped** (lib+Script template; HUMAN deploy for live <10s demo) ·
**F22 shipped** · **F23 shipped** · **F24 shipped** · **F25 shipped** · **F26 shipped** · **F27 shipped** ·
**F28 shipped** · **F29 shipped** · **F30 shipped** ·
**F31 shipped** (knew-at library; CLI = follow-up slice) · **F32 shipped** ·
**F33 shipped** (dream-planner pre-check live) ·
**F34 shipped** (full Script specified; HUMAN deploy + hosts-down drill) ·
**F35 shipped** (loop-side hooks = documented seam) · **F36 shipped** · **F37 shipped** · **F38 shipped**

## Known gaps / UNVERIFIED

- Live bootstrap against a real folder: blocked on the HUMAN GCP step; commands in
  `docs/gdrive-setup.md`. All CI tests run against mocks.
- `runOAuthLoopbackFlow` is unit-untested (needs a browser); labeled UNVERIFIED.
