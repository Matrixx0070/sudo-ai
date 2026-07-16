# Drive Roadmap Status (F1–F38)

Living status doc for the SUDO-AI × Google Drive build. Feature IDs are stable —
referenced in commits, PRs, and code comments. Spec: the 38-feature roadmap
(Phases 0–7). Recon report delivered + confirmed 2026-07-16.

## Phase status

| Phase | Scope | Status |
|---|---|---|
| 0 | Recon + foundation | **foundation shipped (this PR)** — recon confirmed |
| 1 | F17 F16 F29 integrity substrate | todo |
| 2 | F2 F36 F10 F9 durability | todo |
| 3 | F18 F1 F15 F19 F20 guarded ingestion | todo |
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

F1 todo · F2 todo · F3 todo · F4 todo · F5 todo · F6 todo · F7 todo · F8 todo ·
F9 todo · F10 todo · F11 todo · F12 todo · F14 todo · F15 todo · F16 todo ·
F17 todo · F18 todo · F19 todo · F20 todo · F21 todo · F22 todo · F23 todo ·
F24 todo · F25 todo · F26 todo · F27 todo · F28 todo · F29 todo · F30 todo ·
F31 todo · F32 todo · F33 todo · F34 todo (heartbeat producer shipped in Phase 0) ·
F35 todo · F36 todo · F37 todo · F38 todo

## Known gaps / UNVERIFIED

- Live bootstrap against a real folder: blocked on the HUMAN GCP step; commands in
  `docs/gdrive-setup.md`. All CI tests run against mocks.
- `runOAuthLoopbackFlow` is unit-untested (needs a browser); labeled UNVERIFIED.
