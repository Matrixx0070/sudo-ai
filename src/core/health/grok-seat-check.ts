/**
 * @file grok-seat-check.ts
 * @description Watchdog check for the $30 Grok seat (ADR 0008).
 *
 * Split out of checks.ts rather than appended to it: this owns its own on-disk
 * cadence latch and a two-tier probe policy, which is a distinct concern from
 * the single-shot checks there — and checks.ts was already at its size ratchet.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { HealthCheck } from './watchdog.js';
import { DATA_DIR as RESOLVED_DATA_DIR } from '../shared/paths.js';

// ---------------------------------------------------------------------------
// Grok seat health (ADR 0008) — makes silent seat failures loud
// ---------------------------------------------------------------------------

/**
 * Deep-tier cadence state, kept ON DISK.
 *
 * An in-memory latch is wiped by every restart: the kairos repair loop learned
 * this the expensive way, re-running ~80k tokens of analysis six times in one
 * morning because six deploys each reset its counter.
 *
 * The path is a parameter (matching checkDepsFreshness above) rather than a
 * module constant, because DATA_DIR resolves at MODULE LOAD — a test that sets
 * process.env.DATA_DIR in beforeEach is already too late.
 */
export const GROK_SEAT_LATCH_DEFAULT = path.join(RESOLVED_DATA_DIR, 'grok-seat-check-latch.json');
const GROK_SEAT_DEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

function grokSeatDeepDue(now: number, latchPath: string): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(latchPath, 'utf8')) as { lastDeep?: number };
    return now - (raw.lastDeep ?? 0) >= GROK_SEAT_DEEP_INTERVAL_MS;
  } catch {
    return true; // no latch yet → run the deep tier once, then record it
  }
}

function recordGrokSeatDeep(now: number, latchPath: string): void {
  try {
    fs.writeFileSync(latchPath, JSON.stringify({ lastDeep: now }), 'utf8');
  } catch {
    /* a latch write failure must never fail the check */
  }
}

/** Bound any probe so a hung network call cannot stall the 60s watchdog tick. */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Grok seat health, two-tier.
 *
 * Every tick (cheap, OFFLINE, no network): do we hold credentials, and does a
 * human need to act? Once per 24h (deep): a live $0 cookie-lane probe plus the
 * statsig drift canary.
 *
 * Why this exists: five separate seat failures in one week were ALL silent — an
 * OAuth token dead for six days, a statsig algorithm drift that killed app-chat,
 * video and RAG, an absent warm browser, an env var that never reached the
 * process, and a revoked free model that quietly turned a free lane metered.
 * Each was individually cheap to detect; none was detected.
 *
 * The drift tier matters most. docs/STATSIG_RERE_2026-07-25.md is explicit that
 * the fingerprint is a MOVING TARGET which will drift again, and that the
 * browser oracle is the reliable path while pure-Node is an optimisation. So the
 * durable win is not re-cracking the algorithm — it is turning the next drift
 * into an early warning instead of silent 403s.
 *
 * NEVER spends money: only cookie-lane, statsig-free, $0 endpoints are probed
 * and the metered OAuth lane is inspected offline. Never throws.
 */
export async function checkGrokSeat(
  now: number = Date.now(),
  latchPath: string = GROK_SEAT_LATCH_DEFAULT,
): Promise<HealthCheck> {
  const ts = new Date(now).toISOString();
  const name = 'grok_seat';

  if (process.env['SUDO_GROK_WEBSESSION'] !== '1' && process.env['SUDO_GROK_WEB_BRAIN'] !== '1') {
    return { name, status: 'healthy', message: 'grok seat lanes disabled — nothing to check', lastCheck: ts };
  }

  try {
    const { getGrokSeat, formatSeatStatus } = await import('../../llm/grok-seat.js');
    const seat = getGrokSeat();

    const deep = grokSeatDeepDue(now, latchPath);
    const status = deep
      ? await withTimeout(seat.doctor(), 45_000, 'grok seat doctor')
      : seat.status();

    let driftNote = '';
    if (deep) {
      recordGrokSeatDeep(now, latchPath);
      driftNote = await grokStatsigDriftNote();
    }

    const summary = `${formatSeatStatus(status)}${driftNote}`;
    if (status.needsLogin) {
      return {
        name,
        status: 'critical',
        message: `grok seat needs a HUMAN re-login — ${summary}. No automatic recovery can fix this.`,
        lastCheck: ts,
      };
    }
    if (status.overall === 'down' || driftNote.includes('DRIFT')) {
      return { name, status: 'critical', message: `grok seat degraded — ${summary}`, lastCheck: ts };
    }
    if (status.overall === 'degraded' || status.overall === 'unknown') {
      return { name, status: 'degraded', message: `grok seat ${summary}`, lastCheck: ts };
    }
    return { name, status: 'healthy', message: `grok seat ${summary}`, lastCheck: ts };
  } catch (err) {
    // A health check that dies tells you nothing — degrade, never throw.
    return { name, status: 'degraded', message: `grok seat check failed: ${String(err)}`, lastCheck: ts };
  }
}

/** Statsig drift probe for the deep tier. Returns '' when it cannot run. */
async function grokStatsigDriftNote(): Promise<string> {
  if (process.env['SUDO_GROK_STATSIG_BROWSERLESS'] !== '1') {
    // Browserless is already off, so a drifted pure-Node minter is not in play.
    return ' | statsig: oracle path (browserless off)';
  }
  try {
    const { runStatsigDriftCanary } = await import('../../llm/grok-statsig-drift-canary.js');
    const r = await withTimeout(runStatsigDriftCanary(), 90_000, 'statsig drift canary');
    if (r.status === 'algorithm_drift') {
      return ' | statsig ALGORITHM DRIFT: pure-Node tokens rejected — set SUDO_GROK_STATSIG_BROWSERLESS=0 and re-run the scope-walk (docs/STATSIG_RERE_2026-07-25.md)';
    }
    return ` | statsig: ${r.status}`;
  } catch (err) {
    return ` | statsig canary unavailable (${String(err).slice(0, 60)})`;
  }
}
