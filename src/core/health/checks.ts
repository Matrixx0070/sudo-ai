/**
 * @file checks.ts
 * @description Individual health check implementations for the SUDO-AI watchdog.
 *
 * Each exported function performs one specific health check and returns a
 * HealthCheck result. Fix callbacks are injected by the Watchdog so this
 * module stays stateless and easily testable.
 *
 * Checks exported:
 *  checkBrain, checkDatabases, checkDiskSpace, checkMemory,
 *  checkApiKeys, checkTelegram, checkLogs, checkConsciousness
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

import Database from 'better-sqlite3';
import type { HealthCheck } from './watchdog.js';
import { PROJECT_ROOT, DATA_DIR as RESOLVED_DATA_DIR } from '../shared/paths.js';

// ---------------------------------------------------------------------------
// Shared path constants (exported for use in fixes.ts and watchdog.ts)
// ---------------------------------------------------------------------------

export const ROOT       = PROJECT_ROOT;
export const DATA_DIR   = RESOLVED_DATA_DIR;
export const LOG_FILE   = path.join(DATA_DIR, 'logs', 'sudo-ai.log');
export const HEARTBEAT_FILE = path.join(DATA_DIR, 'heartbeat-state.json');

export const DB_PATHS: Record<string, string> = {
  mind:          path.join(DATA_DIR, 'mind.db'),
  knowledge:     path.join(DATA_DIR, 'knowledge.db'),
  consciousness: path.join(DATA_DIR, 'consciousness.db'),
};

export const PROVIDER_ENV_KEYS: Record<string, string> = {
  xai:       'XAI_API_KEY',
  openai:    'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google:    'GEMINI_API_KEY',
  groq:      'GROQ_API_KEY',
};

export const LOG_ROTATE_BYTES   = 50 * 1024 * 1024; // 50 MB
const DISK_CRITICAL_PCT         = 90;
const DISK_DEGRADED_PCT         = 80;
const MEM_CRITICAL_PCT          = 90;
const MEM_DEGRADED_PCT          = 80;
const HEARTBEAT_STALE_MS        = 10 * 60 * 1000;   // 10 minutes

// ---------------------------------------------------------------------------
// 1. Brain connectivity
// ---------------------------------------------------------------------------

export async function checkBrain(): Promise<HealthCheck> {
  const ts   = new Date().toISOString();
  const name = 'brain';

  const activeKeys = Object.entries(PROVIDER_ENV_KEYS)
    .filter(([, envVar]) => Boolean(process.env[envVar]));

  if (activeKeys.length === 0) {
    return { name, status: 'critical', message: 'No LLM provider API keys found in environment', lastCheck: ts };
  }

  const providers = activeKeys.map(([p]) => p);
  return { name, status: 'healthy', message: `${providers.length} provider(s) configured: ${providers.join(', ')}`, lastCheck: ts };
}

/**
 * A minimal brain call that returns the reply text. Injected by the Watchdog
 * so this module stays dependency-free.
 */
export type BrainLivenessProbe = () => Promise<string>;

export interface BrainLivenessOptions {
  /** How often to actually spend a probe call; the verdict is cached between. */
  intervalMs?: number;
  /** Abort a probe that hangs longer than this. */
  timeoutMs?: number;
}

/**
 * Build a brain-LIVENESS check that actually drives a real (cheap) brain call
 * and asserts a non-empty reply — unlike checkBrain(), which only verifies
 * keys are *present* in the environment and therefore reported healthy right
 * through a ~30h outage where the present key was invalid.
 *
 * Throttled: it spends at most one probe call per `intervalMs` (default 15min)
 * and returns the cached verdict on the watchdog's intervening 60s ticks, so
 * the safety net costs ~one trivial call per interval, not one per tick.
 */
export function createBrainLivenessCheck(
  probe: BrainLivenessProbe,
  opts: BrainLivenessOptions = {},
): () => Promise<HealthCheck> {
  const intervalMs = opts.intervalMs ?? 15 * 60_000;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const name = 'brain_liveness';
  let lastProbeAt = 0;
  let cached: HealthCheck | null = null;

  return async function checkBrainLiveness(): Promise<HealthCheck> {
    const now = Date.now();
    if (cached && now - lastProbeAt < intervalMs) {
      return { ...cached, lastCheck: new Date().toISOString() };
    }
    lastProbeAt = now;
    const ts = new Date().toISOString();
    try {
      const reply = await Promise.race([
        probe(),
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error(`liveness probe timed out after ${timeoutMs}ms`)), timeoutMs)),
      ]);
      cached = (typeof reply === 'string' && reply.trim().length > 0)
        ? { name, status: 'healthy', message: 'brain answered a live probe', lastCheck: ts }
        : { name, status: 'critical', message: 'brain probe returned an empty reply — no provider is answering', lastCheck: ts };
    } catch (err) {
      cached = { name, status: 'critical', message: `brain probe failed — no provider answering: ${String(err instanceof Error ? err.message : err).slice(0, 140)}`, lastCheck: ts };
    }
    return cached;
  };
}

// ---------------------------------------------------------------------------
// 2. Database integrity
// ---------------------------------------------------------------------------

export async function checkDatabases(): Promise<HealthCheck> {
  const ts       = new Date().toISOString();
  const name     = 'databases';
  const failures: string[] = [];

  for (const [label, dbPath] of Object.entries(DB_PATHS)) {
    if (!fs.existsSync(dbPath)) { failures.push(`${label}: file missing`); continue; }

    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string } | undefined;
      if (!row || row.integrity_check !== 'ok') {
        failures.push(`${label}: integrity_check='${String(row?.integrity_check)}'`);
      }
    } catch (err) {
      failures.push(`${label}: ${String(err)}`);
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  }

  if (failures.length === 0) {
    return { name, status: 'healthy', message: 'All 3 databases readable and intact', lastCheck: ts };
  }

  const status = failures.length >= Object.keys(DB_PATHS).length ? 'critical' : 'degraded';
  return { name, status, message: `DB failures: ${failures.join('; ')}`, lastCheck: ts };
}

// ---------------------------------------------------------------------------
// 3. Disk space
// ---------------------------------------------------------------------------

export async function checkDiskSpace(fixFn: () => Promise<void>): Promise<HealthCheck> {
  const ts   = new Date().toISOString();
  const name = 'disk_space';
  let usedPct: number;

  try {
    const stats = fs.statfsSync(DATA_DIR);
    const total     = stats.blocks * stats.bsize;
    const available = stats.bavail * stats.bsize;
    usedPct = Math.round(((total - available) / total) * 100);
  } catch {
    try {
      const raw   = execSync(`df -P "${DATA_DIR}" 2>/dev/null | tail -1`, { encoding: 'utf8', timeout: 5_000 });
      const parts = raw.trim().split(/\s+/);
      usedPct     = parseInt(parts[4] ?? '0', 10);
    } catch (err) {
      return { name, status: 'degraded', message: `Cannot read disk stats: ${String(err)}`, lastCheck: ts };
    }
  }

  if (usedPct >= DISK_CRITICAL_PCT) {
    await fixFn();
    return { name, status: 'critical', message: `Disk ${usedPct}% full — cleanup attempted`, lastCheck: ts, autoFix: 'Removed old log archives and temp files' };
  }

  if (usedPct >= DISK_DEGRADED_PCT) {
    return { name, status: 'degraded', message: `Disk ${usedPct}% full — approaching limit`, lastCheck: ts };
  }

  return { name, status: 'healthy', message: `Disk ${usedPct}% used`, lastCheck: ts };
}

// ---------------------------------------------------------------------------
// 4. Memory
// ---------------------------------------------------------------------------

export async function checkMemory(fixFn: () => Promise<void>): Promise<HealthCheck> {
  const ts   = new Date().toISOString();
  const name = 'memory';

  const usedPct   = Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100);
  const mu        = process.memoryUsage();
  const heapMB    = `${Math.round(mu.heapUsed / 1048576)}/${Math.round(mu.heapTotal / 1048576)} MB`;
  const msg       = `System RAM ${usedPct}% used; heap ${heapMB}`;

  if (usedPct >= MEM_CRITICAL_PCT) {
    await fixFn();
    return { name, status: 'critical', message: msg, lastCheck: ts, autoFix: 'GC hint sent' };
  }

  return { name, status: usedPct >= MEM_DEGRADED_PCT ? 'degraded' : 'healthy', message: msg, lastCheck: ts };
}

// ---------------------------------------------------------------------------
// 5. API key validity
// ---------------------------------------------------------------------------

export async function checkApiKeys(): Promise<HealthCheck> {
  const ts      = new Date().toISOString();
  const name    = 'api_keys';
  const missing: string[] = [];
  const present: string[] = [];

  for (const [provider, envVar] of Object.entries(PROVIDER_ENV_KEYS)) {
    const val = process.env[envVar];
    (val && val.trim().length >= 8 ? present : missing).push(provider);
  }

  // 2026-07-18: oauth-era awareness. Prod deliberately runs the anthropic and
  // xai lanes on OAuth managers with NO env keys — treating those lanes as
  // "missing" made this check permanently degraded and (with the old re-alert
  // policy) the top Telegram spam source. A live oauth store counts as a
  // present auth source and clears its env-key twin from the missing list.
  try {
    const { getClaudeOAuthManager } = await import('../../llm/claude-oauth-manager.js');
    if (getClaudeOAuthManager().isAvailable()) {
      present.push('claude-oauth');
      const i = missing.indexOf('anthropic');
      if (i >= 0) missing.splice(i, 1);
    }
  } catch { /* manager unavailable — env keys speak for themselves */ }
  try {
    const { getXaiOAuthManager } = await import('../../llm/xai-oauth-manager.js');
    if (getXaiOAuthManager().status().connected) {
      present.push('xai-oauth');
      const i = missing.indexOf('xai');
      if (i >= 0) missing.splice(i, 1);
    }
  } catch { /* manager unavailable */ }

  if (present.length === 0) {
    return { name, status: 'critical', message: `No usable auth source: ${missing.join(', ')} all missing`, lastCheck: ts };
  }
  // 2+ usable sources = failover possible = healthy operation; a single
  // source is worth a (once, per the new alert policy) heads-up.
  if (present.length === 1) {
    return { name, status: 'degraded', message: `Single auth source (${present[0]}); unconfigured: ${missing.join(', ')}`, lastCheck: ts };
  }
  return { name, status: 'healthy', message: `${present.length} auth sources usable (${present.join(', ')})${missing.length > 0 ? `; unconfigured: ${missing.join(', ')}` : ''}`, lastCheck: ts };
}

// ---------------------------------------------------------------------------
// 6. Telegram polling heartbeat
// ---------------------------------------------------------------------------

export async function checkTelegram(): Promise<HealthCheck> {
  const ts   = new Date().toISOString();
  const name = 'telegram_polling';

  if (!fs.existsSync(HEARTBEAT_FILE)) {
    return { name, status: 'degraded', message: 'heartbeat-state.json not found', lastCheck: ts };
  }

  let state: Record<string, unknown>;
  try {
    state = JSON.parse(fs.readFileSync(HEARTBEAT_FILE, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    return { name, status: 'degraded', message: `heartbeat-state.json unreadable: ${String(err)}`, lastCheck: ts };
  }

  const lastBeat = state['lastBeat'] ?? state['lastHeartbeat'] ?? state['updatedAt'];
  if (!lastBeat) {
    return { name, status: 'degraded', message: 'No lastBeat timestamp in heartbeat file', lastCheck: ts };
  }

  const age = Date.now() - new Date(String(lastBeat)).getTime();
  if (isNaN(age)) {
    return { name, status: 'degraded', message: `Cannot parse lastBeat: ${String(lastBeat)}`, lastCheck: ts };
  }

  if (age > HEARTBEAT_STALE_MS) {
    return { name, status: 'critical', message: `Heartbeat stale by ${Math.round(age / 60_000)} min`, lastCheck: ts };
  }

  return { name, status: 'healthy', message: `Heartbeat fresh (${Math.round(age / 1000)}s ago)`, lastCheck: ts };
}

// ---------------------------------------------------------------------------
// 7. Log file size
// ---------------------------------------------------------------------------

export async function checkLogs(fixFn: () => Promise<void>): Promise<HealthCheck> {
  const ts   = new Date().toISOString();
  const name = 'log_file';

  if (!fs.existsSync(LOG_FILE)) {
    return { name, status: 'healthy', message: 'Log file does not exist yet', lastCheck: ts };
  }

  try {
    const stat   = fs.statSync(LOG_FILE);
    const sizeMB = Math.round(stat.size / 1024 / 1024);

    if (stat.size > LOG_ROTATE_BYTES) {
      await fixFn();
      return { name, status: 'degraded', message: `Log was ${sizeMB} MB — rotated`, lastCheck: ts, autoFix: `Rotated (was ${sizeMB} MB)` };
    }

    return { name, status: 'healthy', message: `Log file is ${sizeMB} MB`, lastCheck: ts };
  } catch (err) {
    return { name, status: 'degraded', message: `Cannot stat log file: ${String(err)}`, lastCheck: ts };
  }
}

// ---------------------------------------------------------------------------
// 8. Consciousness stream
// ---------------------------------------------------------------------------

export async function checkConsciousness(lastCount: number): Promise<{ check: HealthCheck; count: number }> {
  const ts   = new Date().toISOString();
  const name = 'consciousness_stream';

  const dbPath = DB_PATHS['consciousness'];
  if (!dbPath || !fs.existsSync(dbPath)) {
    return { check: { name, status: 'degraded', message: 'consciousness.db not found', lastCheck: ts }, count: lastCount };
  }

  let db: Database.Database | null = null;
  let count = 0;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
      .map((r) => r.name);

    const thoughtTable = tables.find((t) => /thought|stream|cognitive/i.test(t));
    if (!thoughtTable) {
      return { check: { name, status: 'degraded', message: 'No thought table in consciousness.db', lastCheck: ts }, count: lastCount };
    }

    const row = db.prepare(`SELECT COUNT(*) AS cnt FROM "${thoughtTable}"`).get() as { cnt: number };
    count = row.cnt;
  } catch (err) {
    return { check: { name, status: 'degraded', message: `Cannot read consciousness.db: ${String(err)}`, lastCheck: ts }, count: lastCount };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }

  if (count === 0) {
    return { check: { name, status: 'degraded', message: 'No thoughts recorded yet', lastCheck: ts }, count };
  }

  const grew = count > lastCount;
  return {
    count,
    check: { name, status: 'healthy', message: `${count} thoughts total${grew ? ' (growing)' : ' (stable)'}`, lastCheck: ts },
  };
}
