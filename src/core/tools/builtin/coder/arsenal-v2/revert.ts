/**
 * @file revert.ts
 * @description Auto-revert on all-attempts-fail.
 *
 * Closes PR #186's deferred known limitation: "When all attempts fail,
 * patches from the last attempt stay on disk. Backup dirs (timestamped per
 * attempt) allow manual rollback — auto-revert is not in scope."
 *
 * Semantics:
 *
 *   The retry loop calls applyPatches once per attempt; each call creates a
 *   timestamped backup directory under data/arsenal-v2-backups/<ts>/. For
 *   modify ops, the pre-mutation file content is copied to
 *   <backupDir>/<encoded-path>. For create_file ops, an empty
 *   <encoded-path>.created marker is dropped. For delete_file ops, the
 *   pre-deletion content is copied to <backupDir>/<encoded-path>.
 *
 *   Revert correctness requires the EARLIEST backup per file, not the most
 *   recent — if attempt 2 mutates a file already touched by attempt 1, the
 *   true pre-tool-call state lives in attempt 1's backup. `revertAttempts`
 *   walks attempts in order, recording the first applied op per file, then
 *   restores each file from its earliest backup. Files that were
 *   `create_file`d in the first-touch attempt are deleted instead.
 *
 * Trigger:
 *
 *   `success === false` AND every attempt's per-attempt success bool is
 *   false. A partial improvement (e.g., tsc errors dropped from 50 to 5 in
 *   attempt 1, then everything failed in attempt 2) is preserved as the
 *   final state — caller can still use the existing backup dirs to manually
 *   restore further.
 *
 *   Opt-in via `SUDO_ARSENAL_V2_AUTO_REVERT=1`. Default OFF, matching the
 *   campaign's safety convention for behavior-changing additions: a tool
 *   that mutates user code should not also auto-delete those mutations
 *   without an explicit operator decision.
 *
 * Best-effort:
 *
 *   Each per-file restore is wrapped in try/catch. A failure (missing
 *   backup file, EPERM, etc.) increments `failed` and pushes the error to
 *   `errors[]`, but never aborts the revert. Worst-case the operator falls
 *   back to the existing manual rollback path.
 */

import { copyFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../../../shared/logger.js';
import { encodePath } from './patch-applier.js';
import type { ApplyResult } from './patch-types.js';

const log = createLogger('arsenal-v2:revert');

/** Minimal subset of `AttemptRecord` the revert path consumes. */
export interface RevertAttempt {
  applyResult: ApplyResult;
}

export interface RevertResult {
  /** Files whose original content was copied back from the earliest backup. */
  restored: number;
  /** Files that were created by the first attempt and have now been deleted. */
  deleted: number;
  /** Files for which the restore step threw (logged + captured in `errors`). */
  failed: number;
  /** Human-readable per-failure messages. Order matches the failure order. */
  errors: string[];
}

/**
 * Returns true when the operator has opted into auto-revert via
 * `SUDO_ARSENAL_V2_AUTO_REVERT=1`. Default OFF: a tool that mutates user
 * code should not also auto-delete those mutations silently. Strict `'1'`
 * literal so accidental `=true` / `=yes` don't enable.
 */
export function readAutoRevertEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SUDO_ARSENAL_V2_AUTO_REVERT'] === '1';
}

/**
 * Build the earliest-backup-per-file map. First applied op per relpath wins
 * — the EARLIEST backup is the true pre-tool-call state, since each later
 * attempt's backup captures the state after the prior attempt's mutations.
 */
function buildEarliestBackupMap(
  attempts: readonly RevertAttempt[],
): Map<string, { backupDir: string; created: boolean }> {
  const earliest = new Map<string, { backupDir: string; created: boolean }>();
  for (const attempt of attempts) {
    for (const r of attempt.applyResult.results) {
      if (r.status !== 'applied') continue;
      const file = r.op.file;
      if (earliest.has(file)) continue;
      const created = r.op.op === 'create_file';
      earliest.set(file, { backupDir: attempt.applyResult.backupDir, created });
    }
  }
  return earliest;
}

/**
 * Walk every applied op across all attempts and restore each file to its
 * pre-tool-call state. Best-effort: errors are captured, never thrown.
 *
 * @returns RevertResult with restore/delete/failure counts and error strings.
 */
export function revertAttempts(
  attempts: readonly RevertAttempt[],
  opts: { projectRoot: string },
): RevertResult {
  const result: RevertResult = { restored: 0, deleted: 0, failed: 0, errors: [] };
  const earliest = buildEarliestBackupMap(attempts);

  for (const [relFile, info] of earliest) {
    const absFile = path.join(opts.projectRoot, relFile);
    try {
      if (info.created) {
        // First-touch attempt created this file; pre-tool state is "absent".
        // Tolerate ENOENT directly instead of pre-flighting existsSync —
        // closes a TOCTOU window between check and unlink (verifier MED-3)
        // and matches the patch-applier's "tolerate absence" idiom.
        try {
          unlinkSync(absFile);
          result.deleted += 1;
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code !== 'ENOENT') throw err;
          // Already absent (e.g. a later attempt's delete_file removed it).
          // Pre-tool state was "absent", current state is "absent" → revert
          // is a silent no-op success. Neither deleted nor failed.
        }
      } else {
        const backupPath = path.join(info.backupDir, encodePath(relFile));
        if (!existsSync(backupPath)) {
          // Backup absent — record + continue without throw-to-catch-self
          // (verifier LOW-2). Operator can still use the per-attempt backup
          // dirs manually; current file is left untouched (no destructive
          // guess).
          const msg = `backup file missing at ${backupPath}`;
          result.failed += 1;
          result.errors.push(`${relFile}: ${msg}`);
          log.warn({ file: relFile, err: msg }, 'auto-revert: failed to restore file');
          continue;
        }
        copyFileSync(backupPath, absFile);
        result.restored += 1;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.failed += 1;
      result.errors.push(`${relFile}: ${msg}`);
      log.warn({ file: relFile, err: msg }, 'auto-revert: failed to restore file');
    }
  }

  return result;
}
