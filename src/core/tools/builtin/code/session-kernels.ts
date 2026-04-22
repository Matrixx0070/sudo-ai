/**
 * session-kernels.ts — Per-session kernel state manager for the code execution sandbox.
 *
 * Maintains a module-level map of sessionId → KernelEntry, which tracks:
 *   - JS: the vm.Context object (provides variable persistence across calls)
 *   - Python: the Docker container ID (sudo-ai-py-<sessionId>)
 *   - lastUsedAt: epoch ms for idle eviction
 *
 * Background sweeper: every 30 seconds kills containers idle > 10 minutes
 * and removes the entry from the map.
 *
 * The sweeper interval is unref()'d so it does not prevent process exit.
 * Call stopSweeper() for explicit cleanup in tests.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../../../shared/logger.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('code.session-kernels');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KernelEntry {
  /** vm.Context object for JS persistence; null if no JS session started. */
  jsContext: Record<string, unknown> | null;
  /** Docker container ID for the Python sandbox; null if not started. */
  pyContainerId: string | null;
  /** Last use timestamp (epoch ms) for idle eviction. */
  lastUsedAt: number;
}

export interface KernelStats {
  totalSessions: number;
  jsActiveSessions: number;
  pyActiveSessions: number;
  sessions: Array<{
    sessionId: string;
    hasJs: boolean;
    hasPy: boolean;
    idleMs: number;
  }>;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

const kernelMap = new Map<string, KernelEntry>();

/** Idle threshold: 10 minutes in milliseconds. */
const IDLE_THRESHOLD_MS = 10 * 60 * 1000;

/** Sweeper interval reference — unref'd so it doesn't block process exit. */
let sweeperTimer: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Validate sessionId to prevent injection into docker container names. */
export function isValidSessionId(sessionId: string): boolean {
  return /^[a-zA-Z0-9_.-]{1,128}$/.test(sessionId);
}

/** Sanitize sessionId for Docker container names (docker allows [a-zA-Z0-9_.-]). */
export function sanitizeForDocker(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64);
}

/** Kill a Docker container by ID silently (fail-open). */
async function killDockerContainer(containerId: string): Promise<void> {
  try {
    await execFileAsync('docker', ['rm', '-f', containerId]);
    logger.info({ containerId }, 'Python container killed');
  } catch (err) {
    logger.warn({ containerId, err: String(err) }, 'Failed to kill Python container (may already be gone)');
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get or create a KernelEntry for the given sessionId.
 * Throws if sessionId is invalid.
 */
export function getOrCreateEntry(sessionId: string): KernelEntry {
  if (!isValidSessionId(sessionId)) {
    throw new Error(`Invalid sessionId: "${sessionId}". Must match /^[a-zA-Z0-9_.-]{1,128}$/`);
  }

  let entry = kernelMap.get(sessionId);
  if (!entry) {
    entry = { jsContext: null, pyContainerId: null, lastUsedAt: Date.now() };
    kernelMap.set(sessionId, entry);
  } else {
    entry.lastUsedAt = Date.now();
  }
  return entry;
}

/**
 * Touch the lastUsedAt timestamp without modifying the entry.
 */
export function touchEntry(sessionId: string): void {
  const entry = kernelMap.get(sessionId);
  if (entry) {
    entry.lastUsedAt = Date.now();
  }
}

/**
 * Kill all resources for a single session and remove from map.
 */
export async function killSession(sessionId: string): Promise<void> {
  const entry = kernelMap.get(sessionId);
  if (!entry) return;

  kernelMap.delete(sessionId);

  if (entry.pyContainerId) {
    await killDockerContainer(entry.pyContainerId);
  }
  logger.info({ sessionId }, 'Session killed');
}

/**
 * Kill all sessions and their resources.
 */
export async function killAllSessions(): Promise<void> {
  const ids = [...kernelMap.keys()];
  await Promise.allSettled(ids.map(killSession));
  logger.info({ count: ids.length }, 'All sessions killed');
}

/**
 * Return stats about current kernel state.
 */
export function getStats(): KernelStats {
  const now = Date.now();
  const sessions: KernelStats['sessions'] = [];
  let jsActiveSessions = 0;
  let pyActiveSessions = 0;

  for (const [sessionId, entry] of kernelMap.entries()) {
    if (entry.jsContext) jsActiveSessions++;
    if (entry.pyContainerId) pyActiveSessions++;
    sessions.push({
      sessionId,
      hasJs: entry.jsContext !== null,
      hasPy: entry.pyContainerId !== null,
      idleMs: now - entry.lastUsedAt,
    });
  }

  return {
    totalSessions: kernelMap.size,
    jsActiveSessions,
    pyActiveSessions,
    sessions,
  };
}

// ---------------------------------------------------------------------------
// Background sweeper
// ---------------------------------------------------------------------------

async function runSweep(): Promise<void> {
  const now = Date.now();
  const toKill: string[] = [];

  for (const [sessionId, entry] of kernelMap.entries()) {
    if (now - entry.lastUsedAt > IDLE_THRESHOLD_MS) {
      toKill.push(sessionId);
    }
  }

  if (toKill.length > 0) {
    logger.info({ count: toKill.length }, 'Sweeping idle sessions');
    await Promise.allSettled(toKill.map(killSession));
  }
}

/**
 * Start the background sweeper. Called once at module init.
 * The timer is unref()'d so it does not prevent process exit.
 */
function startSweeper(): void {
  if (sweeperTimer !== null) return;

  sweeperTimer = setInterval(() => {
    runSweep().catch((err) => {
      logger.error({ err: String(err) }, 'Sweeper error');
    });
  }, 30_000);

  // Do not block process exit
  if (typeof sweeperTimer.unref === 'function') {
    sweeperTimer.unref();
  }
}

/**
 * Stop the background sweeper explicitly (useful for test cleanup).
 */
export function stopSweeper(): void {
  if (sweeperTimer !== null) {
    clearInterval(sweeperTimer);
    sweeperTimer = null;
  }
}

// Start sweeper on module load
startSweeper();
