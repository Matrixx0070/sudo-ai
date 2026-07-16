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
| 3 | F18 F1 F15 F19 F20 guarded ingestion | **shipped (this PR)** — see below |
| 4 | F3 F4 F7 F6 F30 F21 human interface | todo |
| 5 | F22 F23 F24 F31 F33 F37 epistemics | todo |
| 6 | F12 F11 F27 F28 F35 F14 autonomy | todo |
| 7 | F8 F32 F25 F26 F38 F34 experimentation/ops | todo |

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
F3 todo · F4 todo · F5 todo · F6 todo · F7 todo · F8 todo ·
**F9 shipped** (CLI wiring → Phase 5) · **F10 shipped** (run-end wiring → Phase 5;
replay = digest-verify stub) · F11 todo · F12 todo · F14 todo · **F15 shipped** ·
**F16 shipped** (e2e proof now in inbox tests) ·
**F17 shipped** (GC scheduling lands with F2) · **F18 shipped** ·
**F19 shipped** (outbound tool-call check → Phase 5 seam; HUMAN planting open) ·
**F20 shipped** (CI gym; scheduled run + scorecard → F4) ·
F21 todo · F22 todo · F23 todo · F24 todo · F25 todo · F26 todo · F27 todo ·
F28 todo · **F29 shipped** · F30 todo ·
F31 todo · F32 todo · F33 todo · F34 todo (heartbeat producer shipped in Phase 0) ·
F35 todo · **F36 shipped** · F37 todo · F38 todo

## Known gaps / UNVERIFIED

- Live bootstrap against a real folder: blocked on the HUMAN GCP step; commands in
  `docs/gdrive-setup.md`. All CI tests run against mocks.
- `runOAuthLoopbackFlow` is unit-untested (needs a browser); labeled UNVERIFIED.
