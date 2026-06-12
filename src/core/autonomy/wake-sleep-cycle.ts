/**
 * @file wake-sleep-cycle.ts
 * @description WakeSleepCycle — orchestrates the autonomous work loop.
 *
 * On each tick the cycle asks GoalEngineV2 for goals that are ready to work
 * on, dispatches work to a caller-supplied work handler, and then decides
 * whether to sleep until the next wake-up time or stay awake.
 *
 * The cycle emits 'goal:created' and 'goal:completed' hook events via an
 * optional HookManager so the rest of the system can observe autonomous
 * activity.
 */

import { createLogger } from '../shared/logger.js';
import type { GoalEngineV2, GoalV2 } from './goal-engine-v2.js';
import type { HookManager } from '../hooks/index.js';

const log = createLogger('autonomy:wake-sleep-cycle');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Overall state of the wake/sleep cycle. */
export type CycleState = 'idle' | 'awake' | 'working' | 'sleeping';

/** Handler that does the actual work for a goal. */
export type WorkHandler = (goal: GoalV2) => Promise<void>;

/** Options for constructing a WakeSleepCycle. */
export interface WakeSleepCycleOptions {
  /**
   * How often the cycle checks for ready goals when awake (ms).
   * Default: 60 000 ms (1 minute).
   */
  tickIntervalMs?: number;
  /**
   * Maximum number of goals to dispatch concurrently per tick.
   * Default: 1 (sequential work).
   */
  maxConcurrentGoals?: number;
  /**
   * Optional hook called once on stop() to capture a termination legacy snapshot.
   * Non-blocking — errors are logged and do not prevent shutdown.
   */
  terminationLegacyFn?: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// WakeSleepCycle
// ---------------------------------------------------------------------------

/**
 * Manages the autonomous work loop for goal pursuit.
 *
 * The cycle is intentionally simple: on each tick it fetches eligible goals
 * and calls the work handler for each.  Sleeping, waking, pausing, and
 * completing goals is handled by GoalEngineV2 — this class only orchestrates.
 *
 * @example
 * ```ts
 * const cycle = new WakeSleepCycle(engine, hookManager, async (goal) => {
 *   await doWork(goal);
 *   engine.completeGoal(goal.id);
 * });
 * cycle.start();
 * ```
 */
export class WakeSleepCycle {
  private state: CycleState = 'idle';
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private readonly tickIntervalMs: number;
  private readonly maxConcurrentGoals: number;
  private readonly terminationLegacyFn: (() => Promise<void>) | null;
  private activeWorkCount = 0;

  /**
   * @param goalEngine    - GoalEngineV2 instance that persists goals.
   * @param hookManager   - Optional HookManager for emitting lifecycle events.
   * @param workHandler   - Async function that performs work for a single goal.
   * @param opts          - Tuning options.
   */
  constructor(
    private readonly goalEngine: GoalEngineV2,
    private readonly hookManager: HookManager | null,
    private readonly workHandler: WorkHandler,
    opts: WakeSleepCycleOptions = {},
  ) {
    if (!goalEngine || typeof (goalEngine as { getGoalsReadyToWork?: unknown }).getGoalsReadyToWork !== 'function') {
      throw new TypeError('WakeSleepCycle: goalEngine must be a GoalEngineV2 instance');
    }
    if (typeof workHandler !== 'function') {
      throw new TypeError('WakeSleepCycle: workHandler must be a function');
    }

    this.tickIntervalMs       = opts.tickIntervalMs     ?? 60_000;
    this.maxConcurrentGoals   = opts.maxConcurrentGoals ?? 1;
    this.terminationLegacyFn  = opts.terminationLegacyFn ?? null;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start the autonomous work loop.
   * Idempotent — calling start() on a running cycle is a no-op.
   */
  start(): void {
    if (this.intervalId !== null) {
      log.debug({}, 'WakeSleepCycle already running');
      return;
    }

    this.state = 'awake';
    log.info({ tickIntervalMs: this.tickIntervalMs }, 'WakeSleepCycle started');

    // Run an immediate first tick, then on the interval.
    void this.tick();
    this.intervalId = setInterval(() => void this.tick(), this.tickIntervalMs);
  }

  /**
   * Stop the autonomous work loop.
   * In-flight work handlers are allowed to finish naturally.
   */
  stop(): void {
    if (this.intervalId === null) return;

    clearInterval(this.intervalId);
    this.intervalId = null;
    this.state = 'idle';

    if (this.terminationLegacyFn) {
      void this.terminationLegacyFn().catch((err: unknown) => {
        log.warn({ err: String(err) }, 'Termination legacy hook error — non-fatal');
      });
    }

    log.info({}, 'WakeSleepCycle stopped');
  }

  // -------------------------------------------------------------------------
  // Core tick
  // -------------------------------------------------------------------------

  /**
   * Check for goals that are ready to work on and dispatch the work handler.
   * This is called automatically on the tick interval but can also be called
   * manually to force an immediate check.
   */
  async tick(): Promise<void> {
    if (this.state === 'idle') return;

    let readyGoals: GoalV2[];
    try {
      readyGoals = this.goalEngine.getGoalsReadyToWork();
    } catch (err) {
      log.error({ err: String(err) }, 'getGoalsReadyToWork() threw — skipping tick');
      return;
    }

    if (readyGoals.length === 0) {
      log.debug({}, 'No goals ready to work — sleeping until next tick');
      this.state = 'sleeping';
      return;
    }

    this.state = 'working';
    log.info({ goalCount: readyGoals.length }, 'Dispatching ready goals');

    // Cap to maxConcurrentGoals.
    const batch = readyGoals.slice(0, this.maxConcurrentGoals);

    const dispatches = batch.map((goal) => this.dispatchGoal(goal));
    await Promise.allSettled(dispatches);

    if (this.intervalId !== null) this.state = 'awake';
  }

  // -------------------------------------------------------------------------
  // Sleep / wake helpers (public for external callers)
  // -------------------------------------------------------------------------

  /**
   * Put a goal to sleep with an explicit wake time.
   * Delegates to GoalEngineV2.scheduleWake() and logs appropriately.
   *
   * @param goalId - Goal to put to sleep.
   * @param wakeAt - ISO-8601 timestamp for when to wake the goal.
   */
  sleep(goalId: string, wakeAt: string): void {
    if (!goalId) throw new TypeError('WakeSleepCycle.sleep: goalId is required');
    if (!wakeAt)  throw new TypeError('WakeSleepCycle.sleep: wakeAt is required');

    this.goalEngine.scheduleWake(goalId, wakeAt);
    log.info({ goalId, wakeAt }, 'Goal put to sleep');
  }

  /**
   * Current operational state of the cycle.
   */
  getStatus(): CycleState {
    return this.state;
  }

  // -------------------------------------------------------------------------
  // Internal dispatch
  // -------------------------------------------------------------------------

  private async dispatchGoal(goal: GoalV2): Promise<void> {
    this.activeWorkCount++;
    log.info({ goalId: goal.id, title: goal.title }, 'Dispatching goal work');

    try {
      await this.workHandler(goal);

      // Only emit goal:completed when the goal is actually completed.
      // The work handler may make partial progress, schedule a wake, or pause
      // the goal without finishing it — returning without throwing does not
      // imply completion. Re-read the persisted goal and check its status.
      if (this.hookManager && this.goalEngine.getGoal(goal.id)?.status === 'completed') {
        await this.hookManager.emit('goal:completed', {
          event: 'goal:completed',
          meta: { goalId: goal.id, title: goal.title },
        });
      }
    } catch (err) {
      log.error({ goalId: goal.id, err: String(err) }, 'Work handler threw for goal');
    } finally {
      this.activeWorkCount--;
    }
  }

  // -------------------------------------------------------------------------
  // Goal creation helper (emits hook)
  // -------------------------------------------------------------------------

  /**
   * Helper to create a goal via GoalEngineV2 and emit the 'goal:created' event.
   * This is a convenience wrapper — callers may also use GoalEngineV2 directly.
   */
  async createGoal(
    opts: Parameters<GoalEngineV2['setGoal']>[0],
  ): Promise<GoalV2> {
    const goal = this.goalEngine.setGoal(opts);

    if (this.hookManager) {
      await this.hookManager.emit('goal:created', {
        event: 'goal:created',
        meta: { goalId: goal.id, title: goal.title, priority: goal.priority },
      });
    }

    log.info({ goalId: goal.id, title: goal.title }, 'Goal created via WakeSleepCycle');
    return goal;
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  /** Number of goals currently being processed by work handlers. */
  get activeCount(): number {
    return this.activeWorkCount;
  }
}
