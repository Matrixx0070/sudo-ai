# Persistence Map — Wave F verdicts (F115–F118)

Generated 2026-07-18 from the round-2 persistence inventory
(docs/CORE_ROADMAP.md). Retention/WAL enforcement lives in
`src/core/health/retention-sweep.ts` (F113/F114).

## F115 — Audit-store layering VERDICT: keep separated, shared retention

Five audit-ish stores exist: `audit.db` (security AuditTrail, HASH-CHAINED —
row deletion would break chain verification; WAL-checkpoint only),
`alignment-audit.db` (append-only scores — retention via F113, 90d),
`trust.db` (trust tiers — LIVE data consumed by trust-tier routing, not a
log; no prune), `calibration.db` (verify-gate calibration — live model data;
pruning could degrade gate quality; no prune), plus rotated JSONLs
(exec/browser/github-audit — F113 size-rotation). **Physical consolidation
REJECTED**: chain integrity + live-vs-log semantics differ per store. The
consolidation the inventory suggested is delivered as: one retention owner
(F113), this layering doc, and the F123 metabolism dashboard for visibility.

## F117 — Session-store layering VERDICT (absorbs F99)

Six mechanisms, roles clarified: `mind.db` sessions via sqlite-session-store
= SOURCE OF TRUTH (write-through persistence #668/#670); JSONL journal
(sessions/journal-store) = crash-forensics append log, NOT read for state
except recovery; `migrate-jsonl.ts` = one-time legacy importer (keep until a
scan shows zero unmigrated JSONLs, then delete); acp/session-store +
task-manager per-session JSON = separate subsystem-scoped stores (fine);
session-backups/*.sql = survival backups (capped at 10). **Engineering
follow-up (own slice): auto-run the unmigrated-JSONL scan at boot and log a
deletion recommendation; no physical merge needed.**

## F118 — Dead-store cleanup ACTIONS

- `data/cron-jobs.db` (0 bytes, superseded by data/cron/*.json): DELETE at
  runtime (done by operator/session, not tracked in git).
- `data/task_queue-backup-*.json` one-off stale snapshots: delete when seen.
- `data/costs/transparency-report.json` staleness: owned by cost-reporter;
  regenerates on demand — leave.
- `data/structured-memory/` empty dir: KEEP (live module writes on demand).

## F116 — mind.db table ownership map (59 tables)

`mind.db` is written by ~37 modules. Attribution below is by CREATE TABLE
location in src ("unattributed" = schema built dynamically/template —
attribute by hand when touched). Decomposition verdict: **no big-bang
split**; new domains MUST NOT add tables here (use a domain DB); existing
tables migrate opportunistically when their module is next refactored.

| Table | Owning module(s) |
|---|---|
| `agents` | (schema not found in src — legacy/dynamic) |
| `anomalies` | core/prediction/predictor-schema.ts |
| `api_call_log` | core/billing/cost-tracker.ts |
| `api_costs` | core/memory/schema.ts |
| `autonomous_plans` | core/autonomy/schema.ts |
| `canvas_state` | core/canvas/canvas-store.ts |
| `chunks` | core/memory/schema.ts |
| `chunks_fts` | (schema not found in src — legacy/dynamic) |
| `chunks_fts_config` | (schema not found in src — legacy/dynamic) |
| `chunks_fts_data` | (schema not found in src — legacy/dynamic) |
| `chunks_fts_docsize` | (schema not found in src — legacy/dynamic) |
| `chunks_fts_idx` | (schema not found in src — legacy/dynamic) |
| `chunks_vec` | (schema not found in src — legacy/dynamic) |
| `chunks_vec_chunks` | (schema not found in src — legacy/dynamic) |
| `chunks_vec_info` | (schema not found in src — legacy/dynamic) |
| `chunks_vec_local` | (schema not found in src — legacy/dynamic) |
| `chunks_vec_local_chunks` | (schema not found in src — legacy/dynamic) |
| `chunks_vec_local_info` | (schema not found in src — legacy/dynamic) |
| `chunks_vec_local_rowids` | (schema not found in src — legacy/dynamic) |
| `chunks_vec_local_vector_chunks00` | (schema not found in src — legacy/dynamic) |
| `chunks_vec_rowids` | (schema not found in src — legacy/dynamic) |
| `chunks_vec_vector_chunks00` | (schema not found in src — legacy/dynamic) |
| `content_ideas` | core/memory/schema.ts |
| `cron_runs` | core/memory/schema.ts |
| `cross_channel_messages` | core/channels/cross-channel-memory.ts |
| `embedding_cache` | core/memory/schema.ts |
| `epistemic_log` | core/cognition/cross-signal-diagnostics.ts; core/cognition/epistemic-gate.ts |
| `exec_policy_rules` | core/agent/exec-policy.ts |
| `failure_log` | core/learning/failure-learner-store.ts |
| `failure_prevention_rules` | core/learning/failure-learner-store.ts |
| `federation_error_reports` | core/federation/federation-error-ingestor.ts |
| `federation_token_pool` | core/federation/federation-token-pool.ts |
| `feedback` | core/feedback/store.ts |
| `feedback_memory` | core/self-improvement/feedback-memory.ts |
| `files` | core/files/store.ts |
| `inspection_queue` | core/memory/schema.ts |
| `loop_signatures` | core/agent/loop-signature-store.ts |
| `messages` | core/memory/schema.ts |
| `pipeline_runs` | core/memory/schema.ts |
| `predictions` | core/prediction/predictor-schema.ts |
| `scheduled_messages` | core/memory/schema.ts |
| `scheduled_posts` | core/memory/schema.ts |
| `self_initiated_actions` | core/autonomy/schema.ts |
| `sent_side_effects` | core/comms/idempotency.ts |
| `session_messages_fts` | (schema not found in src — legacy/dynamic) |
| `session_messages_fts_config` | (schema not found in src — legacy/dynamic) |
| `session_messages_fts_data` | (schema not found in src — legacy/dynamic) |
| `session_messages_fts_docsize` | (schema not found in src — legacy/dynamic) |
| `session_messages_fts_idx` | (schema not found in src — legacy/dynamic) |
| `session_skills` | (schema not found in src — legacy/dynamic) |
| `sessions` | core/memory/schema.ts |
| `skill_versions` | core/skills/versioning-io.ts |
| `skills` | (schema not found in src — legacy/dynamic) |
| `sqlite_sequence` | (schema not found in src — legacy/dynamic) |
| `task_queue` | core/orchestration/task-queue-schema.ts |
| `tasks` | core/memory/schema.ts |
| `test_runs` | core/testing/test-harness.ts |
| `tool_outcome_stats` | core/agent/tool-success-store.ts |
| `video_metrics` | core/memory/schema.ts |
