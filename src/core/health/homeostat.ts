/**
 * @file homeostat.ts
 * @description CW6 — HomeostatCore: ONE read-side essential-variables organ
 * unifying the repo's four ad-hoc homeostats (KAIROS health checks, USD/token
 * budget caps, disk/RAM checks, cadence throttles). SENSING ONLY: this module
 * reads and reports; it never acts. KAIROS keeps its reflex ACTIONS but reads
 * its disk/RAM sensors from here (checks.ts), so there is a single sensing
 * truth. Placed in core/health (real resources), not consciousness.
 *
 * Setpoints/bounds come from the EXISTING canonical sources wherever one
 * exists: checks.ts DISK_/MEM_ thresholds, billing/daily-budget.ts USD budget.
 * tokens_day and error_rate have no prior canonical constant — their setpoints
 * are env-tunable with defaults derived from measured baselines (recorded as
 * assumptions in docs/CAS_WIRING_STATUS.md). queue_depth has no cheap accessor
 * yet: reported as unavailable rather than invented.
 *
 * Zero LLM calls; sqlite reads are fail-open (sensor -> unavailable).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { DATA_DIR } from '../shared/paths.js';
import { dailyBudgetUsd } from '../billing/daily-budget.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('health:homeostat');

// Canonical thresholds (single definition site stays checks.ts; re-exported there).
import { DISK_CRITICAL_PCT, DISK_DEGRADED_PCT, MEM_CRITICAL_PCT, MEM_DEGRADED_PCT } from './checks.js';

export interface EssentialVariable {
  name: string;
  /** Current sensed value (unit per `unit`); null when the sensor is unavailable. */
  value: number | null;
  unit: string;
  /** Comfortable operating point — urgency is 0 at/below this. */
  setpoint: number;
  /** [lower, upper] viability bounds; urgency reaches 1 at the upper bound. */
  bounds: [number, number];
  /** 0 (fine) .. 1 (at/past the viability bound); 0 when unavailable. */
  urgency: number;
  available: boolean;
}

/** Linear urgency: 0 at/below setpoint, 1 at/above the upper bound. */
export function computeUrgency(value: number, setpoint: number, upper: number): number {
  if (!Number.isFinite(value) || upper <= setpoint) return 0;
  if (value <= setpoint) return 0;
  return Math.min(1, (value - setpoint) / (upper - setpoint));
}

/**
 * Disk-used percentage for DATA_DIR — the EXACT sensing logic KAIROS
 * checkDiskSpace used inline (statfs, df fallback), extracted so both read one
 * sensor. Throws on total failure (caller decides the degraded shape).
 */
export function readDiskUsedPct(dataDir: string = DATA_DIR): number {
  try {
    const stats = fs.statfsSync(dataDir);
    const total = stats.blocks * stats.bsize;
    const available = stats.bavail * stats.bsize;
    return Math.round(((total - available) / total) * 100);
  } catch {
    const raw = execSync(`df -P "${dataDir}" 2>/dev/null | tail -1`, { encoding: 'utf8', timeout: 5_000 });
    const parts = raw.trim().split(/\s+/);
    return parseInt(parts[4] ?? '0', 10);
  }
}

/** System-RAM used percentage — the EXACT sensing KAIROS checkMemory used inline. */
export function readRamUsedPct(): number {
  return Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100);
}

function numEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

interface DayRow { usd: number | null; tokens: number | null }
interface ErrRow { total: number; errored: number }

/** 24h spend/tokens + 1h error rate from gateway.db llm_calls. Fail-open. */
function readGatewaySensors(): { usdDay: number | null; tokensDay: number | null; errorRate: number | null } {
  try {
    const db = new Database(path.join(DATA_DIR, 'gateway.db'), { readonly: true, fileMustExist: true });
    try {
      const day = db.prepare(
        `SELECT SUM(cost_usd) AS usd, SUM(COALESCE(tokens_in,0)+COALESCE(tokens_out,0)) AS tokens
         FROM llm_calls WHERE ts > strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours')`,
      ).get() as DayRow;
      const err = db.prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN error_class IS NOT NULL AND error_class != '' THEN 1 ELSE 0 END) AS errored
         FROM llm_calls WHERE ts > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hours')`,
      ).get() as ErrRow;
      return {
        usdDay: day.usd ?? 0,
        tokensDay: day.tokens ?? 0,
        errorRate: err.total > 0 ? (err.errored ?? 0) / err.total : 0,
      };
    } finally {
      db.close();
    }
  } catch (e) {
    log.warn({ err: String(e) }, 'homeostat: gateway.db sensors unavailable (fail-open)');
    return { usdDay: null, tokensDay: null, errorRate: null };
  }
}

/**
 * Read the full essential-variables vector. Sensing only — no side effects
 * beyond read-only queries. Each sensor fails open to `available: false`.
 */
export function readEssentialVariables(): EssentialVariable[] {
  const vars: EssentialVariable[] = [];

  // disk_pct — canonical thresholds from checks.ts.
  try {
    const v = readDiskUsedPct();
    vars.push({ name: 'disk_pct', value: v, unit: '%', setpoint: DISK_DEGRADED_PCT, bounds: [0, DISK_CRITICAL_PCT], urgency: computeUrgency(v, DISK_DEGRADED_PCT, DISK_CRITICAL_PCT), available: true });
  } catch (e) {
    log.warn({ err: String(e) }, 'homeostat: disk sensor unavailable');
    vars.push({ name: 'disk_pct', value: null, unit: '%', setpoint: DISK_DEGRADED_PCT, bounds: [0, DISK_CRITICAL_PCT], urgency: 0, available: false });
  }

  // ram_mb — value in MB; setpoint/bounds derived from the canonical MEM_ pcts.
  {
    const totalMb = Math.round(os.totalmem() / 1048576);
    const usedMb = Math.round((os.totalmem() - os.freemem()) / 1048576);
    const setMb = Math.round((MEM_DEGRADED_PCT / 100) * totalMb);
    const upperMb = Math.round((MEM_CRITICAL_PCT / 100) * totalMb);
    vars.push({ name: 'ram_mb', value: usedMb, unit: 'MB', setpoint: setMb, bounds: [0, upperMb], urgency: computeUrgency(usedMb, setMb, upperMb), available: true });
  }

  const gw = readGatewaySensors();

  // usd_day — canonical setpoint = billing daily budget; viability bound 2x.
  {
    const budget = dailyBudgetUsd();
    vars.push({ name: 'usd_day', value: gw.usdDay, unit: 'USD', setpoint: budget, bounds: [0, budget * 2], urgency: gw.usdDay === null ? 0 : computeUrgency(gw.usdDay, budget, budget * 2), available: gw.usdDay !== null });
  }

  // tokens_day — no prior canonical cap; env-tunable, default from measured baseline
  // (~10M/day observed 2026-07: setpoint 15M, bound 30M). ASSUMPTION (ledger).
  {
    const set = numEnv('SUDO_HOMEOSTAT_TOKENS_DAY', 15_000_000);
    vars.push({ name: 'tokens_day', value: gw.tokensDay, unit: 'tokens', setpoint: set, bounds: [0, set * 2], urgency: gw.tokensDay === null ? 0 : computeUrgency(gw.tokensDay, set, set * 2), available: gw.tokensDay !== null });
  }

  // error_rate — 1h errored/total; default setpoint 0.25 / bound 0.6 from the
  // measured chronic baseline (~22%/24h). ASSUMPTION (ledger).
  {
    const set = numEnv('SUDO_HOMEOSTAT_ERROR_RATE', 0.25);
    const upper = Math.min(1, set * 2.4);
    vars.push({ name: 'error_rate', value: gw.errorRate, unit: 'ratio', setpoint: set, bounds: [0, upper], urgency: gw.errorRate === null ? 0 : computeUrgency(gw.errorRate, set, upper), available: gw.errorRate !== null });
  }

  // queue_depth — no cheap accessor exists yet (message-router queue is
  // in-process, offline queue is per-channel). Honest: unavailable, not invented.
  vars.push({ name: 'queue_depth', value: null, unit: 'items', setpoint: 100, bounds: [0, 1000], urgency: 0, available: false });

  return vars;
}
