/**
 * meta.survival — Unbreakable Persistence / Survival System tool.
 *
 * Actions:
 *   backup           — Create a full tarball backup of all database files.
 *   restore          — Restore a database backup by ID.
 *   list-backups     — List all recorded backups.
 *   prune-backups    — Delete old backups keeping the N newest.
 *   heartbeat        — Record an "I'm alive" signal.
 *   dead-man-check   — Check whether SUDO has been silent >24h.
 *   test-models      — Probe each LLM provider endpoint for availability.
 *   migration-history — Return model migration history.
 *   export           — Export full state to a portable tarball.
 *   import-state     — Import state from a tarball.
 *   resilience-score — Compute and return composite resilience score.
 */

import path from 'node:path';
import { SurvivalSystem } from '../../../persistence/survival.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('meta-survival');

const DATA_DIR = path.resolve('/root/sudo-ai-v4/data');
const DB_PATH  = path.resolve('/root/sudo-ai-v4/data/mind.db');

// ---------------------------------------------------------------------------
// Lazy singleton
// ---------------------------------------------------------------------------

let _system: SurvivalSystem | null = null;

function getSystem(): SurvivalSystem {
  if (!_system) _system = new SurvivalSystem(DATA_DIR, DB_PATH);
  return _system;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const survivalTool: ToolDefinition = {
  name: 'meta.survival',
  description:
    'Unbreakable persistence system. Create and restore database backups, monitor the dead-man\'s switch (auto-recovery if silent >24h), probe LLM provider availability, export/import full system state, and retrieve a resilience health score (0–100).',
  category: 'meta',
  timeout: 120_000,
  requiresConfirmation: false,

  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Operation to perform.',
      enum: [
        'backup', 'restore', 'list-backups', 'prune-backups',
        'heartbeat', 'dead-man-check',
        'test-models', 'migration-history',
        'export', 'import-state',
        'resilience-score',
      ],
    },
    backupLocation: {
      type: 'string',
      description: '[backup] Optional directory path to write the backup tarball (default: data/backups/).',
    },
    backupId: {
      type: 'string',
      description: '[restore] UUID of the backup record to restore.',
    },
    keepCount: {
      type: 'number',
      description: '[prune-backups] Number of newest backups to keep (default 10).',
      default: 10,
    },
    importPath: {
      type: 'string',
      description: '[import-state] Absolute path to the .tar.gz export file to import.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    logger.info({ session: ctx.sessionId, action }, 'meta.survival invoked');

    try {
      const sys = getSystem();

      switch (action) {
        // -------------------------------------------------------------------
        case 'backup': {
          const location = params['backupLocation'] as string | undefined;
          const state    = await sys.createBackup(location);
          return {
            success: true,
            output:  `Backup created: ${state.location}\nDatabases: ${state.databases.join(', ')}\nSize: ${(state.totalSizeBytes / 1024).toFixed(1)} KB\nVerified: ${state.verified ? 'yes' : 'no'}`,
            data:    state,
            artifacts: [{ path: state.location, action: 'created' as const, size: state.totalSizeBytes }],
          };
        }

        // -------------------------------------------------------------------
        case 'restore': {
          const backupId = params['backupId'] as string | undefined;
          if (!backupId?.trim()) return { success: false, output: 'backupId is required for restore.' };

          const ok = await sys.restoreFromBackup(backupId);
          return {
            success: ok,
            output:  ok
              ? `Backup ${backupId} restored successfully.`
              : `Restore failed for backup ${backupId} — check logs for details.`,
            data: { backupId, success: ok },
          };
        }

        // -------------------------------------------------------------------
        case 'list-backups': {
          const backups = sys.listBackups();
          if (backups.length === 0) {
            return { success: true, output: 'No backups found. Run action=backup to create one.', data: [] };
          }
          const lines = backups.map(
            (b) =>
              `[${b.id.slice(0, 8)}] ${b.timestamp} | ${(b.totalSizeBytes / 1024).toFixed(0)} KB | verified:${b.verified ? '✓' : '✗'} | ${b.databases.length} db(s)`,
          );
          return {
            success: true,
            output:  `${backups.length} backup(s):\n${lines.join('\n')}`,
            data:    backups,
          };
        }

        // -------------------------------------------------------------------
        case 'prune-backups': {
          const keepCount = Math.max(1, (params['keepCount'] as number | undefined) ?? 10);
          const pruned    = sys.pruneOldBackups(keepCount);
          return {
            success: true,
            output:  `Pruned ${pruned} old backup(s). Keeping newest ${keepCount}.`,
            data:    { pruned, keepCount },
          };
        }

        // -------------------------------------------------------------------
        case 'heartbeat': {
          await sys.heartbeat();
          return {
            success: true,
            output:  `Heartbeat recorded at ${new Date().toISOString()}.`,
            data:    { recordedAt: new Date().toISOString() },
          };
        }

        // -------------------------------------------------------------------
        case 'dead-man-check': {
          const check = await sys.checkDeadManSwitch();
          const silentStr = isFinite(check.silentHours)
            ? `${check.silentHours.toFixed(1)} hours`
            : 'unknown (no heartbeat recorded)';
          return {
            success: true,
            output:  check.alive
              ? `SUDO is ALIVE. Last seen: ${check.lastSeen} (${silentStr} ago).`
              : `WARNING: SUDO may be DEAD. Last seen: ${check.lastSeen} (${silentStr} silent — exceeds 24h threshold).`,
            data:    check,
          };
        }

        // -------------------------------------------------------------------
        case 'test-models': {
          const results = await sys.testModelAvailability();
          const lines   = results.map(
            (r) => `  ${r.available ? '✓' : '✗'} ${r.model} — latency: ${r.latencyMs}ms`,
          );
          const available = results.filter((r) => r.available).length;
          return {
            success: true,
            output:  `Model availability (${available}/${results.length} available):\n${lines.join('\n')}`,
            data:    results,
          };
        }

        // -------------------------------------------------------------------
        case 'migration-history': {
          const history = sys.getMigrationHistory();
          if (history.length === 0) {
            return { success: true, output: 'No model migrations recorded.', data: [] };
          }
          const lines = history.map(
            (m) => `[${m.migratedAt}] ${m.fromModel} → ${m.toModel} (${m.success ? 'ok' : 'failed'}) — ${m.reason}`,
          );
          return {
            success: true,
            output:  `${history.length} migration(s):\n${lines.join('\n')}`,
            data:    history,
          };
        }

        // -------------------------------------------------------------------
        case 'export': {
          const result = await sys.exportState();
          return {
            success: true,
            output:  `State exported: ${result.path} (${(result.sizeBytes / 1024).toFixed(1)} KB)`,
            data:    result,
            artifacts: [{ path: result.path, action: 'created' as const, size: result.sizeBytes }],
          };
        }

        // -------------------------------------------------------------------
        case 'import-state': {
          const importPath = params['importPath'] as string | undefined;
          if (!importPath?.trim()) return { success: false, output: 'importPath is required for import-state.' };

          const ok = await sys.importState(importPath);
          return {
            success: ok,
            output:  ok
              ? `State imported from ${importPath}.`
              : `Import failed — see logs. Ensure the file exists and is a valid .tar.gz.`,
            data: { importPath, success: ok },
          };
        }

        // -------------------------------------------------------------------
        case 'resilience-score': {
          const score = sys.getResilienceScore();
          const level  = score.score >= 75 ? 'EXCELLENT' : score.score >= 50 ? 'GOOD' : score.score >= 25 ? 'FAIR' : 'CRITICAL';
          return {
            success: true,
            output: [
              `Resilience Score: ${score.score}/100 — ${level}`,
              `Backups:  ${score.backupCount} (last: ${score.lastBackup})`,
              `Models available: ${score.modelsAvailable}`,
            ].join('\n'),
            data: score,
          };
        }

        // -------------------------------------------------------------------
        default:
          return { success: false, output: `Unknown action: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'meta.survival error');
      return { success: false, output: `Survival system error: ${msg}` };
    }
  },
};
