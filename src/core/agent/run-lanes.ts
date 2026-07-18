/**
 * @file run-lanes.ts
 * @description GW-11 — session lanes + global concurrency lanes for agent runs.
 *
 * policy.ts priority lanes govern LLM CALLS; nothing caps concurrent agent RUNS.
 * Background work (dream engine, cognitive stream, standing orders, cron) each
 * self-throttle ad hoc. This adds:
 *
 *  - A per-session mutex: at most one active run per session key (mid-run arrivals
 *    are handled by the GW-5 steer buffer, not by starting a second run).
 *  - Named global counting semaphores per lane, capping parallelism by class:
 *    user (4), subagent (4), background (2), cron (1). Env-tunable via
 *    SUDO_RUN_LANES="user=4,background=2,…".
 *  - Admission: acquire a slot before a turn starts; the user lane NEVER drops
 *    (unbounded FIFO wait); background/cron lanes queue FIFO with a cap (default
 *    50) and overflow drops the OLDEST waiter (+ telemetry count), never the newest.
 *  - drainAndSuspend(): stop admitting + wait for active runs (pairs with GW-9's
 *    verified restart handoff), so a restart hands off cleanly.
 *
 * In-memory, single-process. Every acquire returns a release fn; ALWAYS release in
 * a finally.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:run-lanes');

export type RunLane = 'user' | 'subagent' | 'background' | 'cron';
const LANES: readonly RunLane[] = ['user', 'subagent', 'background', 'cron'];

export const DEFAULT_LANE_CAPS: Record<RunLane, number> = {
  user: 4,
  subagent: 4,
  background: 2,
  cron: 1,
};

/** Waiter queue cap for droppable (background/cron) lanes. */
export const DEFAULT_QUEUE_CAP = 50;
/** Lanes whose overflow may be dropped (oldest first). The user lane never drops. */
const DROPPABLE: ReadonlySet<RunLane> = new Set<RunLane>(['background', 'cron']);

export type ReleaseFn = () => void;

/** Parse SUDO_RUN_LANES="user=4,background=2" over the defaults. */
export function parseLaneCaps(raw: string | undefined, base = DEFAULT_LANE_CAPS): Record<RunLane, number> {
  const caps = { ...base };
  if (!raw) return caps;
  for (const part of raw.split(',')) {
    const [k, v] = part.split('=').map((x) => x.trim());
    if (k && v && (LANES as readonly string[]).includes(k)) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 1) caps[k as RunLane] = Math.floor(n);
    }
  }
  return caps;
}

interface Waiter {
  resolve: (r: ReleaseFn) => void;
  reject: (e: Error) => void;
  enqueuedAt: number;
}

/** A counting semaphore with a bounded, optionally-droppable FIFO wait queue. */
class LaneSemaphore {
  private inUse = 0;
  private readonly waiters: Waiter[] = [];
  private droppedOverflow = 0;

  constructor(
    private readonly cap: number,
    private readonly queueCap: number,
    private readonly droppable: boolean,
    private readonly name: string,
    private readonly now: () => number,
  ) {}

  get active(): number { return this.inUse; }
  get queued(): number { return this.waiters.length; }
  get dropped(): number { return this.droppedOverflow; }

  acquire(): Promise<ReleaseFn> {
    if (this.inUse < this.cap) {
      this.inUse++;
      return Promise.resolve(this.makeRelease());
    }
    // Full → queue. Droppable lanes evict the OLDEST waiter on overflow.
    if (this.droppable && this.waiters.length >= this.queueCap) {
      const oldest = this.waiters.shift();
      if (oldest) {
        this.droppedOverflow++;
        oldest.reject(new Error(`run-lane '${this.name}' overflow — oldest waiter dropped`));
        log.warn({ lane: this.name, dropped: this.droppedOverflow }, 'GW-11: background lane overflow — dropped oldest waiter');
      }
    }
    return new Promise<ReleaseFn>((resolve, reject) => {
      this.waiters.push({ resolve, reject, enqueuedAt: this.now() });
    });
  }

  private makeRelease(): ReleaseFn {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        // Hand the slot directly to the next waiter (inUse stays constant).
        next.resolve(this.makeRelease());
      } else {
        this.inUse--;
      }
    };
  }
}

export interface RunLanesOptions {
  caps?: Record<RunLane, number>;
  queueCap?: number;
  now?: () => number;
}

export class RunLanes {
  private readonly semaphores: Record<RunLane, LaneSemaphore>;
  /** Session keys with an active run (per-session mutex). */
  private readonly activeSessions = new Set<string>();
  /** Waiters for a busy session, FIFO per session key. */
  private readonly sessionWaiters = new Map<string, Array<() => void>>();
  private suspending = false;

  constructor(opts: RunLanesOptions = {}) {
    const caps = opts.caps ?? parseLaneCaps(process.env['SUDO_RUN_LANES']);
    const queueCap = opts.queueCap ?? DEFAULT_QUEUE_CAP;
    const now = opts.now ?? Date.now;
    this.semaphores = {
      user: new LaneSemaphore(caps.user, Number.MAX_SAFE_INTEGER, false, 'user', now),
      subagent: new LaneSemaphore(caps.subagent, queueCap, false, 'subagent', now),
      background: new LaneSemaphore(caps.background, queueCap, true, 'background', now),
      cron: new LaneSemaphore(caps.cron, queueCap, true, 'cron', now),
    };
  }

  /** Snapshot of lane occupancy — for telemetry/tests. */
  stats(): Record<RunLane, { active: number; queued: number; dropped: number }> {
    const out = {} as Record<RunLane, { active: number; queued: number; dropped: number }>;
    for (const lane of LANES) {
      out[lane] = { active: this.semaphores[lane].active, queued: this.semaphores[lane].queued, dropped: this.semaphores[lane].dropped };
    }
    return out;
  }

  get activeSessionCount(): number { return this.activeSessions.size; }

  /**
   * Acquire a run slot: the per-session mutex FIRST (one active run per session),
   * then the global lane semaphore. Returns a release fn that frees both. ALWAYS
   * release in a finally.
   */
  async acquireRunSlot(sessionKey: string, lane: RunLane): Promise<ReleaseFn> {
    if (this.suspending) throw new Error('run-lanes suspending — not admitting new runs');
    await this.acquireSession(sessionKey);
    let laneRelease: ReleaseFn;
    try {
      laneRelease = await this.semaphores[lane].acquire();
    } catch (err) {
      // Lane overflow dropped us → release the session mutex we took.
      this.releaseSession(sessionKey);
      throw err;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      laneRelease();
      this.releaseSession(sessionKey);
    };
  }

  private acquireSession(sessionKey: string): Promise<void> {
    if (!this.activeSessions.has(sessionKey)) {
      this.activeSessions.add(sessionKey);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const q = this.sessionWaiters.get(sessionKey) ?? [];
      q.push(resolve);
      this.sessionWaiters.set(sessionKey, q);
    });
  }

  private releaseSession(sessionKey: string): void {
    const q = this.sessionWaiters.get(sessionKey);
    if (q && q.length > 0) {
      const next = q.shift()!;
      if (q.length === 0) this.sessionWaiters.delete(sessionKey);
      next(); // the session mutex stays held; handed to the next waiter
      return;
    }
    this.activeSessions.delete(sessionKey);
  }

  /**
   * GW-9 pairing: stop admitting new runs and wait for active ones to finish.
   * Resolves true when all lanes drained, false on timeout.
   */
  async drainAndSuspend(timeoutMs = 60_000, pollMs = 100, now: () => number = Date.now): Promise<boolean> {
    this.suspending = true;
    const deadline = now() + timeoutMs;
    for (;;) {
      const anyActive = LANES.some((l) => this.semaphores[l].active > 0);
      if (!anyActive) { log.info('GW-11: all run lanes drained — safe to suspend'); return true; }
      if (now() >= deadline) { log.warn({ stats: this.stats() }, 'GW-11: drain timeout — runs still active'); return false; }
      await new Promise<void>((r) => setTimeout(r, pollMs));
    }
  }

  /** Resume admitting (undo a drainAndSuspend that timed out / was aborted). */
  resume(): void { this.suspending = false; }
}

let _singleton: RunLanes | null = null;
export function getRunLanes(): RunLanes {
  if (!_singleton) _singleton = new RunLanes();
  return _singleton;
}
export function __resetRunLanesForTest(): void { _singleton = null; }
