/**
 * @file metabolism-report.ts
 * @description F123 (docs/CORE_ROADMAP.md Wave G) — one place that answers
 * "what background loops exist, what do they cost, and what ran?".
 *
 * Static registry = the round-2 metabolism map (keep in sync when adding a
 * loop). Runtime side = 24h spend attribution from mind.db api_call_log
 * (GROUP BY source). Output: data/metabolism-report.json + a log summary.
 * Read-only over mind.db; never throws.
 */

import { existsSync, writeFileSync } from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import { DATA_DIR } from '../shared/paths.js';

const log = createLogger('health:metabolism');

export interface LoopInfo {
  name: string;
  module: string;
  cadence: string;
  llm: boolean;
  gate: string;
}

/** Static loop registry — the background metabolism map (round-2 review). */
export const LOOP_REGISTRY: ReadonlyArray<LoopInfo> = [
  { name: 'cognitive-stream', module: 'consciousness/cognitive-stream', cadence: '60s micro / xN medium / x120 deep', llm: true, gate: 'always-on (consciousness-control.json opt-out)' },
  { name: 'heartbeat', module: 'cron/heartbeat', cadence: '30m agentTurn', llm: true, gate: 'always-on (active-hours window)' },
  { name: 'auto-dream', module: 'memory/auto-dream', cadence: '6h', llm: true, gate: 'cron job (enabled by default)' },
  { name: 'brain-liveness', module: 'health/checks', cadence: '15m ping', llm: true, gate: 'SUDO_BRAIN_LIVENESS!=0' },
  { name: 'kairos', module: 'consciousness/kairos', cadence: '5m system watch', llm: false, gate: 'SUDO_KAIROS!=0; autonomous unless SUDO_KAIROS_AUTONOMOUS=0' },
  { name: 'watchdog', module: 'health/watchdog', cadence: '60s', llm: false, gate: 'always-on' },
  { name: 'retention-sweep', module: 'health/retention-sweep', cadence: 'boot+daily', llm: false, gate: 'SUDO_RETENTION_SWEEP!=0' },
  { name: 'self-test', module: 'health/self-test', cadence: 'nightly 03:30', llm: false, gate: 'SUDO_SELFTEST_DISABLE!=1' },
  { name: 'autonomy-wake-sleep', module: 'autonomy/wake-sleep-cycle', cadence: '5m tick', llm: true, gate: 'SUDO_AUTONOMY_V1=1' },
  { name: 'world-state-monitor', module: 'autonomy/world-state-monitor', cadence: '120s', llm: false, gate: 'SUDO_WORLD_STATE_MONITOR!=0 (goals need =1)' },
  { name: 'standing-orders', module: 'automation/standing-orders', cadence: '60s eval', llm: true, gate: 'SUDO_STANDING_ORDERS=1' },
  { name: 'self-build-tick', module: 'self-build/cron-entry', cadence: '30m', llm: true, gate: 'SUDO_SELF_BUILD_MODE=1' },
  { name: 'autobugfix', module: 'self-build/autobugfix-boot', cadence: '5m poll + 5m deploy watch', llm: true, gate: 'SUDO_AUTOBUGFIX=1' },
  { name: 'scheduled-messages', module: 'channels/scheduled-messages', cadence: '60s dispatch', llm: true, gate: 'SUDO_SCHEDULED_MESSAGES=1' },
  { name: 'social-dispatch', module: 'social/schedule-dispatcher', cadence: '60s', llm: false, gate: 'always-on' },
  { name: 'email-imap-worker', module: 'channels/email-imap-worker', cadence: '15s poll', llm: false, gate: 'EMAIL_IMAP_* configured' },
  { name: 'gdrive-lanes', module: 'gdrive/runtime', cadence: 'various (60s..nightly)', llm: true, gate: 'SUDO_GDRIVE=1' },
  { name: 'notebooklm-lanes', module: 'notebooklm/runtime', cadence: 'various (5m..weekly)', llm: true, gate: 'SUDO_NOTEBOOKLM=1' },
];

export interface MetabolismReport {
  generatedAt: string;
  loops: LoopInfo[];
  spendBySource24h: Array<{ source: string; calls: number; usd: number }>;
  totalUsd24h: number;
}

export function buildMetabolismReport(dataDir: string = DATA_DIR): MetabolismReport {
  const report: MetabolismReport = {
    generatedAt: new Date().toISOString(),
    loops: [...LOOP_REGISTRY],
    spendBySource24h: [],
    totalUsd24h: 0,
  };
  const mindPath = path.join(dataDir, 'mind.db');
  if (existsSync(mindPath)) {
    try {
      const db = new Database(mindPath, { readonly: true });
      try {
        const rows = db
          .prepare(
            `SELECT COALESCE(source,'(none)') source, COUNT(*) calls, COALESCE(SUM(estimated_cost_usd),0) usd
             FROM api_call_log
             WHERE called_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')
             GROUP BY source ORDER BY usd DESC`,
          )
          .all() as Array<{ source: string; calls: number; usd: number }>;
        report.spendBySource24h = rows;
        report.totalUsd24h = rows.reduce((a, r) => a + r.usd, 0);
      } finally {
        db.close();
      }
    } catch (err) {
      log.warn({ err: String(err) }, 'spend attribution query failed');
    }
  }
  try {
    writeFileSync(path.join(dataDir, 'metabolism-report.json'), JSON.stringify(report, null, 2));
  } catch (err) {
    log.warn({ err: String(err) }, 'metabolism report write failed');
  }
  log.info(
    { totalUsd24h: Number(report.totalUsd24h.toFixed(2)), topSources: report.spendBySource24h.slice(0, 5) },
    'metabolism report generated',
  );
  return report;
}
