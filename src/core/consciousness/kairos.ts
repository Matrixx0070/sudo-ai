/**
 * Kairos — SUDO-AI's always-on autonomous background daemon.
 *
 * Named after the Greek concept of the "right moment" — Kairos watches
 * everything and acts when the moment demands it.
 *
 * Watches (every 5 minutes):
 *   1. Codebase health     — TypeScript error count + trending
 *   2. Large file growth   — files > 750 lines (complexity debt; raised to reduce noise post-refactors + Phase 3 strict intra dedups/comments)
 *   3. Stale tasks         — pending tasks > 2 hours old
 *   4. Memory overflow     — MEMORY.md > 20KB → flag for consolidation
 *   5. Service health      — RAM > 1GB, disk > 500MB
 *   6. Self-update check   — no update check in 24h
 *   7. Dead code           — unused exports accumulating (every 30 min)
 *
 * Autonomous actions:
 *   - Auto-restarts service when RAM critical
 *   - Cleans old backups when disk critical
 *   - Sends Telegram alert for CRITICAL findings
 *   - Writes all findings to workspace/KAIROS_ALERTS.md
 */

import { execSync, execFile as execFileCb } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync, statSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import type { GoalTracker } from './goal-tracker.js';
import { triggerKAIROSRepair } from '../tools/builtin/coder/arsenal.js';

const execFile = promisify(execFileCb);
const log = createLogger('consciousness:kairos');

const PROJECT_ROOT = '/root/sudo-ai-v4';
const TSC = path.join(PROJECT_ROOT, 'node_modules/.bin/tsc');
const ALERTS_FILE = path.join(PROJECT_ROOT, 'workspace', 'KAIROS_ALERTS.md');
const ERROR_TREND_FILE = path.join(PROJECT_ROOT, 'data', 'kairos-error-trend.json');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KairosObservationType =
  | 'task_idle'
  | 'memory_full'
  | 'error_spike'
  | 'opportunity'
  | 'health_warning'
  | 'codebase_degraded'
  | 'large_file'
  | 'disk_pressure'
  | 'dead_code'
  | 'action_taken'
  | 'goal_at_risk'
  | 'momentum_loss'
  | 'revenue_gap'
  | 'learning_plateau';

export type KairosSeverity = 'INFO' | 'WARN' | 'CRITICAL';

export interface KairosObservation {
  timestamp: string;
  type: KairosObservationType;
  severity: KairosSeverity;
  message: string;
  action?: string;
  acted?: boolean;
  actionResult?: string;
}

export interface KairosConfig {
  refreshIntervalMs?: number;
  enabled?: boolean;
  dbPath?: string;
  logPath?: string;
  autonomousActions?: boolean;
  telegramBotToken?: string;
  telegramChatId?: string;
  /** Optional callback invoked for every CRITICAL observation (alongside Telegram fallback). */
  onCritical?: (obs: KairosObservation) => void;
  /**
   * Overrides the internal notifyTelegram function.
   * Injected in tests so the module-local free function is patchable.
   */
  notifyFn?: (msg: string, botToken: string, chatId: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Alert cooldown (per obs.type + obs.severity key, persisted to disk)
// ---------------------------------------------------------------------------

const COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours
const COOLDOWN_FILE = path.join(PROJECT_ROOT, 'data', 'kairos-cooldown.json');

function loadCooldownState(): Map<string, number> {
  try {
    if (existsSync(COOLDOWN_FILE)) {
      const raw = readFileSync(COOLDOWN_FILE, 'utf-8');
      const obj = JSON.parse(raw) as Record<string, number>;
      return new Map(Object.entries(obj));
    }
  } catch { /* ignore corrupt file */ }
  return new Map<string, number>();
}

function saveCooldownState(map: Map<string, number>): void {
  try {
    const obj = Object.fromEntries(map.entries());
    writeFileSync(COOLDOWN_FILE, JSON.stringify(obj), 'utf-8');
  } catch { /* ignore */ }
}

const lastNotifiedAt = loadCooldownState();

/** Exported for test teardown — resets all cooldown state. */
export function __resetCooldownForTest(): void {
  lastNotifiedAt.clear();
  saveCooldownState(lastNotifiedAt);
}

// ---------------------------------------------------------------------------
// Error trend tracking
// ---------------------------------------------------------------------------

interface ErrorTrend {
  samples: Array<{ timestamp: string; count: number }>;
}

function loadErrorTrend(): ErrorTrend {
  try {
    if (existsSync(ERROR_TREND_FILE)) {
      return JSON.parse(readFileSync(ERROR_TREND_FILE, 'utf-8')) as ErrorTrend;
    }
  } catch { /* ignore */ }
  return { samples: [] };
}

function saveErrorTrend(trend: ErrorTrend): void {
  try {
    trend.samples = trend.samples.slice(-24); // Keep last 24 samples (2h at 5min intervals)
    const dir = path.dirname(ERROR_TREND_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(ERROR_TREND_FILE, JSON.stringify(trend, null, 2), 'utf-8');
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Alert writer
// ---------------------------------------------------------------------------

function initAlertsFile(): void {
  if (!existsSync(ALERTS_FILE)) {
    writeFileSync(ALERTS_FILE,
      `# KAIROS ALERTS\n\nAutonomous daemon — real-time codebase and system monitoring.\n\n`,
      'utf-8',
    );
  }
}

function writeAlert(obs: KairosObservation): void {
  try {
    const icon = obs.severity === 'CRITICAL' ? '🚨' : obs.severity === 'WARN' ? '⚠️' : 'ℹ️';
    const actedNote = obs.acted
      ? `\n  **Auto-fixed:** ${obs.actionResult}`
      : obs.action ? `\n  **Action:** ${obs.action}` : '';
    appendFileSync(
      ALERTS_FILE,
      `\n### ${icon} ${obs.type.toUpperCase()} — ${obs.timestamp}\n${obs.message}${actedNote}\n`,
      'utf-8',
    );
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Telegram notifier
// ---------------------------------------------------------------------------

async function notifyTelegram(message: string, botToken: string, chatId: string): Promise<void> {
  if (!botToken || !chatId) return;
  // Let send failures (network/auth) reject so callers can avoid committing the
  // alert cooldown for a notification that was never actually delivered.
  await execFile('curl', [
    '-s', '-X', 'POST',
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    '-d', `chat_id=${chatId}&text=${encodeURIComponent(message)}&parse_mode=Markdown`,
  ], { timeout: 10_000 });
}

// ---------------------------------------------------------------------------
// Health checks
// ---------------------------------------------------------------------------

async function checkCodebaseHealth(): Promise<KairosObservation[]> {
  const obs: KairosObservation[] = [];
  if (!existsSync(TSC)) return obs;
  try {
    let errorCount = 0;
    try {
      execSync(`"${TSC}" --noEmit`, {
        cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 60_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string };
      const raw = ((e.stdout ?? '') + '\n' + (e.stderr ?? '')).trim();
      errorCount = (raw.match(/error TS\d+/g) ?? []).length;
    }

    const trend = loadErrorTrend();
    trend.samples.push({ timestamp: new Date().toISOString(), count: errorCount });
    saveErrorTrend(trend);

    if (errorCount > 0) {
      const recent = trend.samples.slice(-3);
      const trending = recent.length >= 3 &&
        (recent[2]?.count ?? 0) > (recent[1]?.count ?? 0) &&
        (recent[1]?.count ?? 0) > (recent[0]?.count ?? 0);
      obs.push({
        timestamp: new Date().toISOString(),
        type: 'codebase_degraded',
        severity: errorCount > 20 ? 'CRITICAL' : errorCount > 5 ? 'WARN' : 'INFO',
        message: `TypeScript: ${errorCount} error(s)${trending ? ' — TRENDING UP ↑' : ''}`,
        action: 'Run coder.arsenal mode:"fix" to resolve TypeScript errors',
      });
    }
  } catch { /* tsc unavailable */ }
  return obs;
}

async function checkLargeFiles(): Promise<KairosObservation[]> {
  const obs: KairosObservation[] = [];
  const THRESHOLD = 750;
  try {
    const files = execSync(
      `find "${path.join(PROJECT_ROOT, 'src')}" -name "*.ts" -not -path "*/node_modules/*" -not -path "*/dist/*"`,
      { encoding: 'utf-8', timeout: 15_000 }
    ).trim().split('\n').filter(Boolean);

    const large: string[] = [];
    for (const file of files) {
      try {
        const lines = readFileSync(file, 'utf-8').split('\n').length;
        if (lines > THRESHOLD) large.push(`${path.relative(PROJECT_ROOT, file)} (${lines} lines)`);
      } catch { /* skip */ }
    }

    if (large.length > 0) {
      obs.push({
        timestamp: new Date().toISOString(),
        type: 'large_file',
        severity: large.length > 5 ? 'WARN' : 'INFO',
        message: `${large.length} file(s) exceed ${THRESHOLD} lines:\n${large.slice(0, 5).join('\n')}`,
        action: 'Use coder.arsenal mode:"refactor" to split into focused modules',
      });
    }
  } catch { /* ignore */ }
  return obs;
}

async function checkStaleTasks(dbPath: string): Promise<KairosObservation[]> {
  const obs: KairosObservation[] = [];
  try {
    if (!existsSync(dbPath)) return obs;
    const db = new Database(dbPath, { readonly: true });
    const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const stale = db.prepare(
      `SELECT COUNT(*) as cnt FROM tasks WHERE status='pending' AND created_at < ? LIMIT 1`
    ).get(cutoff) as { cnt: number } | undefined;
    db.close();
    if (stale && stale.cnt > 0) {
      obs.push({
        timestamp: new Date().toISOString(),
        type: 'task_idle',
        severity: stale.cnt > 10 ? 'WARN' : 'INFO',
        message: `${stale.cnt} pending task(s) older than 2 hours`,
        action: 'Run meta.task-manager to review and resolve stale tasks',
      });
    }
  } catch { /* table may not exist */ }
  return obs;
}

async function checkMemoryOverflow(): Promise<KairosObservation[]> {
  const obs: KairosObservation[] = [];
  const THRESHOLD = 200 * 1024; // 200KB — MEMORY.md is an index, not raw memory
  try {
    const memPath = path.join(PROJECT_ROOT, 'workspace', 'MEMORY.md');
    if (existsSync(memPath)) {
      const size = statSync(memPath).size;
      if (size > THRESHOLD) {
        obs.push({
          timestamp: new Date().toISOString(),
          type: 'memory_full',
          severity: size > THRESHOLD * 2 ? 'CRITICAL' : 'WARN',
          message: `MEMORY.md is ${Math.round(size / 1024)}KB — exceeds ${Math.round(THRESHOLD / 1024)}KB threshold`,
          action: 'Trigger meta.auto-optimizer to consolidate and prune memory',
        });
      }
    }
  } catch { /* ignore */ }
  return obs;
}

async function checkServiceHealth(): Promise<KairosObservation[]> {
  const obs: KairosObservation[] = [];
  try {
    const status = execSync('systemctl show sudo-ai --property=MemoryCurrent 2>/dev/null', {
      encoding: 'utf8', timeout: 5000,
    }).trim();
    const match = status.match(/MemoryCurrent=(\d+)/);
    if (match) {
      const bytes = parseInt(match[1]!, 10);
      const mb = Math.round(bytes / 1024 / 1024);
      if (bytes > 1024 * 1024 * 1024) {
        obs.push({ timestamp: new Date().toISOString(), type: 'health_warning', severity: 'CRITICAL', message: `Service RAM at ${mb}MB — exceeds 1GB`, action: 'Auto-restart triggered' });
      } else if (bytes > 512 * 1024 * 1024) {
        obs.push({ timestamp: new Date().toISOString(), type: 'health_warning', severity: 'WARN', message: `Service RAM at ${mb}MB — approaching limit`, action: 'Monitor closely' });
      }
    }
  } catch { /* ignore */ }

  try {
    const dataDir = path.join(PROJECT_ROOT, 'data');
    if (existsSync(dataDir)) {
      const du = execSync(`du -sb "${dataDir}" 2>/dev/null`, { encoding: 'utf8', timeout: 10_000 }).trim();
      const bytes = parseInt((du.split('\t')[0] ?? '0'), 10);
      const mb = Math.round(bytes / 1024 / 1024);
      if (mb > 20_000) { // 20GB threshold — pm2 logs can legitimately grow large
        obs.push({ timestamp: new Date().toISOString(), type: 'disk_pressure', severity: mb > 30_000 ? 'CRITICAL' : 'WARN', message: `data/ directory is ${mb}MB`, action: 'Auto-cleanup of old backups triggered' });
      }
    }
  } catch { /* ignore */ }
  return obs;
}

async function checkSelfUpdate(): Promise<KairosObservation[]> {
  const obs: KairosObservation[] = [];
  try {
    const updateLog = path.join(PROJECT_ROOT, 'data', 'self-update.log');
    if (existsSync(updateLog)) {
      const lines = readFileSync(updateLog, 'utf8').trim().split('\n');
      const lastLine = lines[lines.length - 1] ?? '';
      const match = lastLine.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/);
      if (match && Date.now() - new Date(match[1]!).getTime() > 24 * 60 * 60 * 1000) {
        obs.push({ timestamp: new Date().toISOString(), type: 'opportunity', severity: 'INFO', message: 'No self-update check in 24+ hours', action: 'Run meta.self-update action:"check"' });
      }
    }
  } catch { /* ignore */ }
  return obs;
}

async function checkDeadCode(): Promise<KairosObservation[]> {
  const obs: KairosObservation[] = [];
  try {
    const cacheFile = path.join(PROJECT_ROOT, 'data', 'coder-cache.json');
    if (!existsSync(cacheFile)) return obs;
    const cache = JSON.parse(readFileSync(cacheFile, 'utf-8')) as {
      symbols: Record<string, string[]>;
      imports: Record<string, string[]>;
    };
    const allImported = new Set(Object.values(cache.imports ?? {}).flat());
    let deadCount = 0;
    for (const sym of Object.keys(cache.symbols ?? {})) {
      if (!allImported.has(sym) && sym.length > 3) deadCount++;
    }
    if (deadCount > 20) {
      obs.push({
        timestamp: new Date().toISOString(),
        type: 'dead_code',
        severity: deadCount > 50 ? 'WARN' : 'INFO',
        message: `~${deadCount} potentially unused exports detected`,
        action: 'Run coder.analyze mode:"complexity" to identify dead code',
      });
    }
  } catch { /* ignore */ }
  return obs;
}

// ---------------------------------------------------------------------------
// Autonomous actions
// ---------------------------------------------------------------------------

/**
 * Check if any agent session is actively processing right now.
 * We look at the sessions DB for any session updated in the last 10 minutes
 * that has messages — a proxy for "task in progress".
 * Kairos must NEVER restart the service while a task is running.
 */
function isAgentBusy(dbPath: string): boolean {
  try {
    const db = new Database(dbPath, { readonly: true });
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const row = db.prepare(
      `SELECT COUNT(*) as cnt FROM sessions WHERE updated_at > ? AND archived = 0`
    ).get(tenMinutesAgo) as { cnt: number } | undefined;
    db.close();
    return (row?.cnt ?? 0) > 0;
  } catch {
    // If we can't check, assume busy to be safe
    return true;
  }
}

async function actOnObservation(obs: KairosObservation, config: Required<KairosConfig>): Promise<KairosObservation> {
  if (!config.autonomousActions) return obs;
  try {
    if (obs.type === 'health_warning' && obs.severity === 'CRITICAL' && obs.message.includes('RAM')) {
      // NEVER restart while a task session is actively running — it kills mid-build work.
      if (isAgentBusy(config.dbPath)) {
        log.warn('Kairos: RAM critical but agent is busy — skipping restart, will retry next cycle');
        return { ...obs, acted: false, actionResult: 'Skipped restart: agent session active — will retry when idle' };
      }
      execSync('systemctl restart sudo-ai', { timeout: 30_000 });
      return { ...obs, acted: true, actionResult: 'Service restarted to reclaim RAM' };
    }
    if (obs.type === 'disk_pressure' && obs.severity === 'CRITICAL') {
      // Each entry specifies a target dir and the find predicate to apply.
      const cleanupTargets: Array<{ dir: string; findArgs: string }> = [
        // Gzipped rotated pm2 logs — only keep the last 3 days
        {
          dir: path.join(PROJECT_ROOT, 'data', 'logs'),
          findArgs: '-name "*.gz" -mtime +3 -delete',
        },
        // Generic backup dirs — keep last 7 days
        {
          dir: path.join(PROJECT_ROOT, 'data', 'backups'),
          findArgs: '-type f -mtime +7 -delete',
        },
        {
          dir: path.join(PROJECT_ROOT, 'data', 'arsenal-backups'),
          findArgs: '-type f -mtime +7 -delete',
        },
        {
          dir: path.join(PROJECT_ROOT, 'data', 'file-backups'),
          findArgs: '-type f -mtime +7 -delete',
        },
      ];
      for (const { dir, findArgs } of cleanupTargets) {
        if (existsSync(dir)) {
          execSync(`find "${dir}" ${findArgs} 2>/dev/null || true`, { timeout: 15_000 });
        }
      }
      return { ...obs, acted: true, actionResult: 'Cleaned old rotated logs (>3d) and backup files (>7d)' };
    }
    if ((obs.type === 'large_file' || obs.type === 'codebase_degraded') && process.env['SUDO_KAIROS_ARSENAL_TRIGGER_DISABLE'] !== '1') {
      const task = `KAIROS: ${obs.message}. Use coder.arsenal to ${obs.type === 'large_file' ? 'refactor (dedup/naming/comments inside files only; no new files/splits per strict)' : 'fix TS errors'}.`;
      const res = await triggerKAIROSRepair(task, obs.type === 'large_file' ? 'refactor' : 'fix');
      return { ...obs, acted: res.success, actionResult: (res.output || '').slice(0, 200) };
    }
  } catch (err) {
    log.warn({ err: String(err), type: obs.type }, 'Kairos autonomous action failed');
  }
  return obs;
}

// ---------------------------------------------------------------------------
// Main Kairos class
// ---------------------------------------------------------------------------

export class Kairos {
  private interval: NodeJS.Timeout | null = null;
  private observations: KairosObservation[] = [];
  private config: Required<KairosConfig>;
  private cycleCount = 0;
  private goalTracker: GoalTracker | null = null;

  constructor(config: KairosConfig = {}) {
    this.config = {
      refreshIntervalMs: config.refreshIntervalMs ?? 5 * 60 * 1000,
      enabled: config.enabled ?? true,
      dbPath: config.dbPath ?? path.join(PROJECT_ROOT, 'data', 'mind.db'),
      logPath: config.logPath ?? path.join(PROJECT_ROOT, 'data', 'kairos.log'),
      autonomousActions: config.autonomousActions ?? true,
      telegramBotToken: config.telegramBotToken ?? process.env['TELEGRAM_BOT_TOKEN'] ?? '',
      telegramChatId: config.telegramChatId ?? process.env['TELEGRAM_CHAT_ID'] ?? '',
      onCritical: config.onCritical ?? ((_obs: KairosObservation): void => { /* no-op default */ }),
      notifyFn: config.notifyFn ?? notifyTelegram,
    };
  }

  attachGoalTracker(tracker: GoalTracker): void {
    this.goalTracker = tracker;
  }

  start(): void {
    if (!this.config.enabled || this.interval) return;
    initAlertsFile();
    log.info({ autonomousActions: this.config.autonomousActions }, 'KAIROS daemon starting');
    this.interval = setInterval(() => {
      this.observe().catch(e => log.error({ err: String(e) }, 'KAIROS observe cycle error'));
    }, this.config.refreshIntervalMs);
    this.observe().catch(e => log.error({ err: String(e) }, 'KAIROS initial observe error'));
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      log.info('KAIROS stopped');
    }
  }

  private async observe(): Promise<void> {
    this.cycleCount++;
    const t0 = Date.now();

    const [codebaseR, largeFileR, staleTaskR, memoryR, serviceR, updateR, deadCodeR] =
      await Promise.allSettled([
        checkCodebaseHealth(),
        checkLargeFiles(),
        checkStaleTasks(this.config.dbPath),
        checkMemoryOverflow(),
        checkServiceHealth(),
        checkSelfUpdate(),
        this.cycleCount % 6 === 0 ? checkDeadCode() : Promise.resolve([]),
      ]);

    const allObs: KairosObservation[] = [
      ...(codebaseR.status === 'fulfilled' ? codebaseR.value : []),
      ...(largeFileR.status === 'fulfilled' ? largeFileR.value : []),
      ...(staleTaskR.status === 'fulfilled' ? staleTaskR.value : []),
      ...(memoryR.status === 'fulfilled' ? memoryR.value : []),
      ...(serviceR.status === 'fulfilled' ? serviceR.value : []),
      ...(updateR.status === 'fulfilled' ? updateR.value : []),
      ...(deadCodeR.status === 'fulfilled' ? deadCodeR.value : []),
    ];

    // Goal evaluation every 6th cycle (~30 min at 5min intervals)
    if (this.goalTracker && this.cycleCount % 6 === 0) {
      try {
        const goalObs = await this.goalTracker.evaluate(allObs);
        allObs.push(...goalObs);
      } catch (err) {
        // non-fatal
      }
    }

    for (let obs of allObs) {
      obs = await actOnObservation(obs, this.config);
      writeAlert(obs);
      try { appendFileSync(this.config.logPath, JSON.stringify(obs) + '\n'); } catch { /* ignore */ }
      this.observations.push(obs);

      if (obs.severity === 'CRITICAL' && this.config.telegramBotToken && this.config.telegramChatId) {
        const cooldownKey = `${obs.type}:${obs.severity}`;
        const lastSent = lastNotifiedAt.get(cooldownKey);
        if (lastSent !== undefined && Date.now() - lastSent < COOLDOWN_MS) {
          log.debug({ type: obs.type, cooldownKey }, 'Kairos: CRITICAL alert suppressed within 6h cooldown window');
        } else {
          const msg = `🚨 *KAIROS CRITICAL*\n${obs.type}: ${obs.message}${obs.acted ? `\n✅ Auto-fixed: ${obs.actionResult}` : ''}`;
          // Only commit the cooldown once the notification is confirmed sent —
          // otherwise a transient send failure would suppress CRITICAL alerts
          // for the full 6h window even though the user was never notified.
          this.config.notifyFn(msg, this.config.telegramBotToken, this.config.telegramChatId)
            .then(() => {
              lastNotifiedAt.set(cooldownKey, Date.now());
              saveCooldownState(lastNotifiedAt);
            })
            .catch(() => { /* send failed — leave cooldown unset so next cycle retries */ });
        }
      }
      if (obs.severity === 'CRITICAL') {
        try { this.config.onCritical?.(obs); } catch { /* callback failure must not disrupt the Kairos cycle */ }
      }

      log.info({ type: obs.type, severity: obs.severity, acted: obs.acted ?? false }, `KAIROS: ${obs.message}`);
    }

    if (this.observations.length > 500) this.observations = this.observations.slice(-500);
    log.debug({ cycle: this.cycleCount, findings: allObs.length, ms: Date.now() - t0 }, 'KAIROS cycle complete');
  }

  getObservations(limit = 50): KairosObservation[] {
    return this.observations.slice(-limit);
  }

  getCritical(): KairosObservation[] {
    return this.observations.filter(o => o.severity === 'CRITICAL').slice(-20);
  }

  getStatus(): {
    running: boolean;
    cycleCount: number;
    observationCount: number;
    criticalCount: number;
    lastCheck: string | null;
    autonomousActions: boolean;
  } {
    const last = this.observations[this.observations.length - 1];
    return {
      running: this.interval !== null,
      cycleCount: this.cycleCount,
      observationCount: this.observations.length,
      criticalCount: this.observations.filter(o => o.severity === 'CRITICAL').length,
      lastCheck: last?.timestamp ?? null,
      autonomousActions: this.config.autonomousActions,
    };
  }
}
