# SUDO-AI × Google Drive — Roadmap (F1–F38)

> **Provenance:** reconstructed 2026-07-17 from the original build spec + the shipped
> reality. The authoritative per-feature *shipped* detail (paths, decisions D1–D10,
> deviations, live-rollout results) is `docs/DRIVE_ROADMAP_STATUS.md`; this file is the
> stable F1–F38 *definition* reference the NotebookLM annex composes on. Status: all 8
> phases MERGED (#775–#785), live in prod (oauth mode), F34 pacemaker + F19 canaries live.

## Prime directives (global invariants)

1. Zero synchronous Drive calls on the hot path; all Drive I/O is background jobs.
2. The model never writes its own memory via Drive; mutation goes through the internal memory API (the sole agent-callable exception is F5, a gated user-file tool).
3. Everything read FROM Drive is untrusted input → injection-guard/quarantine before model context.
4. Frozen safety surfaces (`PROTECTED_PATHS`, `src/core/self-build/protected-paths.ts`) never hydrated/modified via Drive.
5. Provenance derived from Drive ACLs, not claims (F16).
6. Memory blobs content-addressed + immutable; manifests HMAC-signed (F17).
7. Sensitivity zones enforced at sync time (F29): zone 0 local-only, zone 1 encrypted, zone 2 plaintext.
8. Least privilege, client-side rate limiting, backoff+jitter, background yields to interactive.
9. Every background job emits audit entries; never logs secrets/decrypted zone-1.
10. Graceful degradation: Drive down is invisible to the loop.

## Zones, tiers, ranking
- **Zones (F29):** 0 local-only · 1 encrypted sync (AES-256-GCM) · 2 plaintext sync.
- **Trust tiers (F16), ranked:** `principal` > `agent` > `self_acquired` > `external` (weights 1.0/0.9/0.7/0.5).
- **Epistemic ranking rider:** score = similarity × trustWeight × freshnessDecay × validationState (`scoreMemory`, `src/core/memory/epistemic-score.ts`).

## Feature index

**Phase 0 — foundation:** DriveClient (files/changes/permissions/comments/revisions/Sheets), token-bucket limiter (two lanes), typed errors, backoff+jitter, service-account + OAuth loopback auth, idempotent folder bootstrap, audit emitter (hash-chained `AuditTrail`), heartbeat writer.

**Phase 1 — integrity:**
- **F17** content-addressed signed brain: immutable sha256 blobs + HMAC-signed manifest; hydration verifies HMAC then each blob, refuse-and-alert on mismatch.
- **F16** ACL trust zones: `deriveTrustTier` from `permissions.list` (weakest writer wins, fail-closed external).
- **F29** encrypted sensitivity zones: `classifyZone`, AES-256-GCM zone-1, zone-0 never synced.

**Phase 2 — durability:**
- **F2** checkpoint & restore: write-behind mirror of consolidated memory; hydrate on startup when remote counter ahead; restore drills.
- **F36** brain releases + schema migrations: named immutable releases, migration ladder, golden-brain CI fixture.
- **F10** flight recorder: per-run reproducible trace bundles (traces.db + gateway.db + events), gzip+AES, incidents/audit routing, replay.
- **F9** memory bisection: git-bisect over the manifest's Drive revision history.

**Phase 3 — guarded ingestion:**
- **F18** detonation chamber: quarantine + disposable no-tools inspector; verdict clean/hold; deterministic + LLM layers.
- **F1** knowledge inbox: drop files in Drive → quarantine → chunk → memory API with ACL provenance.
- **F15** free OCR: Drive import-conversion OCR path.
- **F19** canary files: local-only tripwires (fileId + marker) → CRITICAL audit + PAUSE.
- **F20** adversarial gym: injection regression corpus in CI.

**Phase 4 — human interface:**
- **F3** daily self-report (comment-able Doc); **F4** eval scorecard + telemetry Sheet; **F7** control-panel Sheet (typed tunables, PAUSE, frozen tab); **F6** comment-driven corrections (principal → feedback memory → reply → resolve); **F30** brain atlas; **F21** push notifications (HMAC pings, Apps Script transport).

**Phase 5 — epistemics:**
- **F22** belief maintenance (beliefs graph + changes feed → stale/orphaned); **F23** spaced re-validation (7/30/90/365 ladder); **F24** prospective memory (`noteToFutureSelf`); **F31** bitemporal chronicle + `knewAt`; **F33** dead-ends ledger (`matchDeadEnds` planner pre-check); **F37** world mirror; epistemic ranking rider live in retrieval.

**Phase 6 — autonomy:**
- **F12** nightly dream cycle (re-derive/confirm/reconcile/open-questions agenda); **F11** tier-4 deep-freeze (index hot, payload cold); **F27** free recall (Drive fullText); **F28** embedding-index snapshots; **F35** task hibernation; **F14** multi-instance blackboard.

**Phase 7 — experimentation & ops:**
- **F8** eval-gated skill registry (dual gate: eval + approval; rollback via revisions); **F32** cold second opinion (conclusion-free packets, dissent, escalate-on-timeout); **F25** brain forks; **F26** dataset farming (exemplar bank, zone-1 excluded); **F38** curiosity buffer; **F34** Apps Script pacemaker + dead-man's switch.

**Deferred slices (shipped post-roadmap, #785):** F5 gated user-file tools (owner-only, refuses memory tree); loop-side auto-hibernation; `sudo-ai gdrive` CLI (status/knew-at/bisect/resume).

## Known integration notes for the annex
- Second-opinion (F32) machinery complete but has **no trigger site** — nothing decides which actions cross the impact threshold (annex F48/F65 must wire it).
- `matchDeadEnds` (F33) is consulted only inside `dream.ts`, **not** the agent's `GoalPlanner` — no live planner pre-commit hook (annex F69/F70/F73 must build it).
- F13 weekly self-diff was scoped but **not built** (annex F42/F53 build it).
- Brain routes have **no `modelGeneration` field** and **no `judgeRoute` pin** (annex adds both).
- Local STT exists (`voice/whisper-local.ts`).
