/**
 * @file retention-sweep.ts
 * @description F113+F114 (docs/CORE_ROADMAP.md Wave F) — one retention pass
 * for the stores that grow without bound, plus WAL checkpoint hygiene.
 *
 * Round-2 review evidence: consciousness.db at 136M was driven not by
 * episodes (1.1K rows) but by body_state_log (152K), concept graph,
 * emotional_state_log (78K) and thoughts (76K — its in-code cap is never
 * called); alignment-audit.db grows append-only; several JSONL audit logs and
 * per-run dirs have no rotation; three DBs carry runaway WALs.
 *
 * Deliberately EXCLUDED: concept_nodes/concept_edges (semantic knowledge —
 * automated deletion is memory surgery, combined-invariant 9: two-reader
 * consensus required; this module only reports their size), audit.db rows
 * (hash-chained — pruning would break chain verification; WAL-checkpoint
 * only), mind.db chunks (auto-dream owns that prune).
 *
 * Kill-switch: SUDO_RETENTION_SWEEP=0. Every rule env-tunable; a rule with
 * days<=0 is skipped. Never throws — per-step try/catch, returns a report.
 */

import { existsSync, statSync, renameSync, readdirSync, unlinkSync } from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import { DATA_DIR } from '../shared/paths.js';

const log = createLogger('health:retention-sweep');

const DAY_MS = 86_400_000;

interface TableRule {
  dbFile: string;
  table: string;
  tsCol: string;
  defaultDays: number;
  envDays: string;
  /** Extra WHERE conjunct (already-safe SQL, no user input). */
  extraWhere?: string;
}

const TABLE_RULES: TableRule[] = [
  { dbFile: 'consciousness.db', table: 'body_state_log', tsCol: 'sampled_at', defaultDays: 14, envDays: 'SUDO_RETENTION_BODY_STATE_DAYS' },
  { dbFile: 'consciousness.db', table: 'emotional_state_log', tsCol: 'created_at', defaultDays: 30, envDays: 'SUDO_RETENTION_EMOTIONAL_DAYS' },
  { dbFile: 'consciousness.db', table: 'thoughts', tsCol: 'created_at', defaultDays: 30, envDays: 'SUDO_RETENTION_THOUGHTS_DAYS' },
  { dbFile: 'consciousness.db', table: 'surprise_events', tsCol: 'created_at', defaultDays: 30, envDays: 'SUDO_RETENTION_SURPRISE_DAYS' },
  { dbFile: 'consciousness.db', table: 'user_interaction_log', tsCol: 'created_at', defaultDays: 90, envDays: 'SUDO_RETENTION_INTERACTION_DAYS' },
  // Episodes: age-prune ONLY low-significance ones; significant episodes are kept forever.
  { dbFile: 'consciousness.db', table: 'episodes', tsCol: 'started_at', defaultDays: 90, envDays: 'SUDO_RETENTION_EPISODES_DAYS', extraWhere: 'significance < 0.8' },
  { dbFile: 'alignment-audit.db', table: 'alignment_audit', tsCol: 'computed_at', defaultDays: 90, envDays: 'SUDO_RETENTION_ALIGNMENT_AUDIT_DAYS' },
];

/** Size-capped rotate: file > capBytes → file.1 (previous .1 replaced). */
const ROTATE_FILES: Array<{ rel: string; envCapMb: string; defaultCapMb: number }> = [
  { rel: 'kairos.log', envCapMb: 'SUDO_ROTATE_KAIROS_MB', defaultCapMb: 8 },
  { rel: 'exec-audit.jsonl', envCapMb: 'SUDO_ROTATE_EXEC_AUDIT_MB', defaultCapMb: 5 },
  { rel: 'browser-audit.jsonl', envCapMb: 'SUDO_ROTATE_BROWSER_AUDIT_MB', defaultCapMb: 5 },
  { rel: 'github-audit.jsonl', envCapMb: 'SUDO_ROTATE_GITHUB_AUDIT_MB', defaultCapMb: 5 },
  { rel: path.join('cron', 'runs.jsonl'), envCapMb: 'SUDO_ROTATE_CRON_RUNS_MB', defaultCapMb: 5 },
  { rel: 'session-bus.jsonl', envCapMb: 'SUDO_ROTATE_SESSION_BUS_MB', defaultCapMb: 5 },
];

/** Directories capped by file count (oldest-by-mtime deleted first). */
const DIR_CAPS: Array<{ rel: string; envMax: string; defaultMax: number }> = [
  { rel: 'workflow-runs', envMax: 'SUDO_CAP_WORKFLOW_RUNS', defaultMax: 500 },
  { rel: 'signals', envMax: 'SUDO_CAP_SIGNALS', defaultMax: 500 },
];

/** F114 — WAL checkpoint targets (TRUNCATE reclaims runaway WALs). */
const WAL_DBS = [
  'skill-optimizations.db',
  'update-versions.db',
  'audit.db',
  'gateway.db',
  'mind.db',
  'consciousness.db',
  'traces.db',
];

export interface RetentionReport {
  tablesPruned: Record<string, number>;
  filesRotated: string[];
  dirFilesDeleted: Record<string, number>;
  oldLogsDeleted: number;
  walCheckpointed: string[];
  skipped: boolean;
}

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function isoCutoff(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

export function runRetentionSweep(dataDir: string = DATA_DIR): RetentionReport {
  const report: RetentionReport = {
    tablesPruned: {}, filesRotated: [], dirFilesDeleted: {}, oldLogsDeleted: 0, walCheckpointed: [], skipped: false,
  };
  if (process.env['SUDO_RETENTION_SWEEP'] === '0') {
    report.skipped = true;
    log.info('retention sweep disabled (SUDO_RETENTION_SWEEP=0)');
    return report;
  }

  // 1. Table prunes
  for (const rule of TABLE_RULES) {
    const dbPath = path.join(dataDir, rule.dbFile);
    if (!existsSync(dbPath)) continue;
    const days = envInt(rule.envDays, rule.defaultDays);
    if (days <= 0) continue;
    try {
      const db = new Database(dbPath);
      try {
        const extra = rule.extraWhere ? ` AND ${rule.extraWhere}` : '';
        const res = db
          .prepare(`DELETE FROM ${rule.table} WHERE ${rule.tsCol} < ?${extra}`)
          .run(isoCutoff(days));
        if (res.changes > 0) report.tablesPruned[`${rule.dbFile}:${rule.table}`] = res.changes;
      } finally {
        db.close();
      }
    } catch (err) {
      log.warn({ table: rule.table, err: String(err) }, 'table prune failed');
    }
  }

  // 2. File rotation
  for (const f of ROTATE_FILES) {
    const p = path.join(dataDir, f.rel);
    try {
      if (!existsSync(p)) continue;
      const capBytes = envInt(f.envCapMb, f.defaultCapMb) * 1024 * 1024;
      if (capBytes <= 0) continue;
      if (statSync(p).size > capBytes) {
        renameSync(p, `${p}.1`);
        report.filesRotated.push(f.rel);
      }
    } catch (err) {
      log.warn({ file: f.rel, err: String(err) }, 'rotate failed');
    }
  }

  // 3. Dir caps
  for (const d of DIR_CAPS) {
    const dir = path.join(dataDir, d.rel);
    try {
      if (!existsSync(dir)) continue;
      const max = envInt(d.envMax, d.defaultMax);
      if (max <= 0) continue;
      const entries = readdirSync(dir)
        .map((name) => {
          const fp = path.join(dir, name);
          try { return { fp, mtime: statSync(fp).mtimeMs, isFile: statSync(fp).isFile() }; }
          catch { return null; }
        })
        .filter((e): e is { fp: string; mtime: number; isFile: boolean } => e !== null && e.isFile)
        .sort((a, b) => a.mtime - b.mtime);
      const excess = entries.length - max;
      let deleted = 0;
      for (let i = 0; i < excess; i++) {
        try { unlinkSync(entries[i]!.fp); deleted++; } catch { /* skip */ }
      }
      if (deleted > 0) report.dirFilesDeleted[d.rel] = deleted;
    } catch (err) {
      log.warn({ dir: d.rel, err: String(err) }, 'dir cap failed');
    }
  }

  // 4. Old rotated/dated log files under data/logs (default 30d; 0 disables)
  const logDays = envInt('SUDO_LOG_RETENTION_DAYS', 30);
  if (logDays > 0) {
    const logsDir = path.join(dataDir, 'logs');
    try {
      if (existsSync(logsDir)) {
        const cutoffMs = Date.now() - logDays * DAY_MS;
        for (const name of readdirSync(logsDir)) {
          const fp = path.join(logsDir, name);
          try {
            const st = statSync(fp);
            if (st.isFile() && st.mtimeMs < cutoffMs) {
              unlinkSync(fp);
              report.oldLogsDeleted++;
            }
          } catch { /* skip entry */ }
        }
      }
    } catch (err) {
      log.warn({ err: String(err) }, 'log dir prune failed');
    }
  }

  // 5. F114 — WAL checkpoint hygiene
  for (const dbFile of WAL_DBS) {
    const dbPath = path.join(dataDir, dbFile);
    if (!existsSync(dbPath)) continue;
    try {
      const db = new Database(dbPath);
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
        report.walCheckpointed.push(dbFile);
      } finally {
        db.close();
      }
    } catch (err) {
      log.warn({ db: dbFile, err: String(err) }, 'wal checkpoint failed');
    }
  }

  // Report semantic-graph size (never auto-pruned — invariant 9) so growth is visible.
  try {
    const cdbPath = path.join(dataDir, 'consciousness.db');
    if (existsSync(cdbPath)) {
      const db = new Database(cdbPath, { readonly: true });
      try {
        const edges = (db.prepare('SELECT COUNT(*) n FROM concept_edges').get() as { n: number } | undefined)?.n ?? 0;
        if (edges > 0) log.info({ conceptEdges: edges }, 'semantic graph size (not auto-pruned — needs two-reader consensus)');
      } finally {
        db.close();
      }
    }
  } catch { /* observational only */ }

  log.info({ ...report }, 'retention sweep complete');
  return report;
}
