/**
 * StandingOrderManager — persists and evaluates permanent autonomous rules.
 * Orders stored in data/standing-orders.json (atomic writes).
 * Evaluates triggers every 60 s. Builtins seeded on first boot.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import path from 'path';
import { Cron } from 'croner';
import { createLogger } from '../shared/logger.js';
import { genId } from '../shared/utils.js';
import type { StandingOrder, StandingOrdersFile, OrderTrigger } from './types.js';

const log = createLogger('automation:standing-orders');

const DATA_DIR = path.resolve('data');
const ORDERS_FILE = path.join(DATA_DIR, 'standing-orders.json');
const ORDERS_BAK = path.join(DATA_DIR, 'standing-orders.json.bak');
const EVAL_INTERVAL_MS = 60_000 as const;
const TICK_WINDOW_MS = EVAL_INTERVAL_MS + 500;

/** Async callback that executes an order's action string as an agent turn. */
export type OrderRunner = (action: string, orderId: string) => Promise<void>;

// ---------------------------------------------------------------------------
// StandingOrderManager
// ---------------------------------------------------------------------------

export class StandingOrderManager {
  private orders: Map<string, StandingOrder> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly runner: OrderRunner;
  /** Tracks last evaluation time for condition triggers. */
  private conditionLastRun: Map<string, number> = new Map();

  constructor(runner: OrderRunner) {
    if (typeof runner !== 'function') {
      throw new TypeError('StandingOrderManager: runner must be a function');
    }
    this.runner = runner;
    this._ensureDir();
    this.loadOrders();
    this._seedBuiltins();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Start the periodic trigger evaluation loop. */
  start(): void {
    if (this.timer !== null) {
      log.warn('StandingOrderManager already running');
      return;
    }
    this.timer = setInterval(() => {
      this.evaluateTriggers().catch((err) =>
        log.error({ err }, 'Error during trigger evaluation'),
      );
    }, EVAL_INTERVAL_MS);
    log.info({ intervalMs: EVAL_INTERVAL_MS }, 'StandingOrderManager started');
  }

  /** Stop the evaluation loop. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info('StandingOrderManager stopped');
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  loadOrders(): void {
    try {
      const raw = readFileSync(ORDERS_FILE, 'utf8');
      const parsed = JSON.parse(raw) as StandingOrdersFile;
      if (parsed?.version !== 1 || !Array.isArray(parsed.orders)) {
        log.warn({ file: ORDERS_FILE }, 'standing-orders.json has unexpected format — starting empty');
        return;
      }
      this.orders.clear();
      for (const order of parsed.orders) {
        if (order?.id && order?.name) {
          this.orders.set(order.id, order);
        }
      }
      log.info({ count: this.orders.size }, 'Standing orders loaded from disk');
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        log.info('standing-orders.json not found — starting empty');
      } else {
        log.error({ err }, 'Failed to load standing-orders.json');
      }
    }
  }

  addOrder(order: Omit<StandingOrder, 'id' | 'createdAt' | 'executionCount'> & { id?: string }): StandingOrder {
    if (!order.name || typeof order.name !== 'string') {
      throw new TypeError('addOrder: order.name must be a non-empty string');
    }
    if (!order.action || typeof order.action !== 'string') {
      throw new TypeError('addOrder: order.action must be a non-empty string');
    }
    const record: StandingOrder = {
      ...order,
      id: order.id ?? genId(),
      executionCount: 0,
      createdAt: new Date().toISOString(),
    };
    this.orders.set(record.id, record);
    this._save();
    log.info({ orderId: record.id, name: record.name }, 'Standing order added');
    return record;
  }

  removeOrder(id: string): boolean {
    if (!id) return false;
    const existed = this.orders.delete(id);
    if (existed) {
      this.conditionLastRun.delete(id);
      this._save();
      log.info({ orderId: id }, 'Standing order removed');
    } else {
      log.warn({ orderId: id }, 'removeOrder: order not found');
    }
    return existed;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const order = this.orders.get(id);
    if (!order) {
      log.warn({ orderId: id }, 'setEnabled: order not found');
      return false;
    }
    order.enabled = enabled;
    this.orders.set(id, order);
    this._save();
    log.info({ orderId: id, enabled }, 'Standing order enabled state changed');
    return true;
  }

  listOrders(): StandingOrder[] {
    return [...this.orders.values()];
  }

  getOrder(id: string): StandingOrder | undefined {
    return this.orders.get(id);
  }

  // -------------------------------------------------------------------------
  // Trigger evaluation
  // -------------------------------------------------------------------------

  async evaluateTriggers(): Promise<void> {
    const now = new Date();
    const enabled = [...this.orders.values()].filter((o) => o.enabled);

    for (const order of enabled) {
      if (this._isDue(order, now)) {
        await this.executeOrder(order);
      }
    }
  }

  /** Emit a named system event — fires all matching event-trigger orders. */
  async emitEvent(event: string): Promise<void> {
    if (!event) return;
    const matches = [...this.orders.values()].filter(
      (o) => o.enabled && o.trigger.kind === 'event' && (o.trigger as { event: string }).event === event,
    );
    for (const order of matches) {
      await this.executeOrder(order);
    }
  }

  async executeOrder(order: StandingOrder): Promise<void> {
    log.info({ orderId: order.id, name: order.name }, 'Executing standing order');
    try {
      await this.runner(order.action, order.id);
      const updated: StandingOrder = {
        ...order,
        lastExecuted: new Date().toISOString(),
        executionCount: order.executionCount + 1,
      };
      this.orders.set(order.id, updated);
      this._save();
      log.info({ orderId: order.id, executionCount: updated.executionCount }, 'Standing order executed');
    } catch (err) {
      log.error({ orderId: order.id, name: order.name, err }, 'Standing order execution failed');
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _isDue(order: StandingOrder, now: Date): boolean {
    const { trigger } = order;

    if (trigger.kind === 'schedule') {
      try {
        const cron = new Cron(trigger.cron, { timezone: trigger.tz });
        const prev = cron.previousRun();
        if (!prev) return false;
        return Math.abs(now.getTime() - prev.getTime()) < TICK_WINDOW_MS;
      } catch (err) {
        log.warn({ orderId: order.id, err }, 'Invalid cron expression in standing order');
        return false;
      }
    }

    if (trigger.kind === 'condition') {
      const lastRun = this.conditionLastRun.get(order.id) ?? 0;
      const elapsed = now.getTime() - lastRun;
      if (elapsed >= trigger.intervalMs) {
        this.conditionLastRun.set(order.id, now.getTime());
        return true;
      }
      return false;
    }

    // event triggers are fired via emitEvent() not the polling loop
    return false;
  }

  private _seedBuiltins(): void {
    const builtins: Array<Omit<StandingOrder, 'createdAt' | 'executionCount'>> = [
      {
        id: 'morning-briefing',
        name: 'Morning Briefing',
        description: 'Daily at 7:00 AM IST — generate YouTube analytics summary',
        trigger: { kind: 'schedule', cron: '0 7 * * *', tz: 'Asia/Kolkata' } satisfies OrderTrigger,
        action: 'Generate a morning briefing: check YouTube analytics for all channels, summarise views and revenue from yesterday, list top performing videos, and flag any anomalies.',
        enabled: true,
      },
      {
        id: 'weekly-report',
        name: 'Weekly Business Report',
        description: 'Every Monday at 9:00 AM IST — generate weekly business report',
        trigger: { kind: 'schedule', cron: '0 9 * * 1', tz: 'Asia/Kolkata' } satisfies OrderTrigger,
        action: 'Generate the weekly business report: summarise channel performance for all 5 channels, total revenue, subscriber growth, top videos, lessons learned, and action items for next week.',
        enabled: true,
      },
      {
        id: 'error-monitor',
        name: 'Error Monitor',
        description: 'On any error event — check logs and alert if critical',
        trigger: { kind: 'event', event: 'error' } satisfies OrderTrigger,
        action: 'An error event was detected. Read the latest entries from data/logs/sudo-ai.log, identify any critical failures, and send an alert summary via Telegram.',
        enabled: true,
      },
    ];

    let seeded = 0;
    for (const builtin of builtins) {
      if (!this.orders.has(builtin.id)) {
        this.addOrder(builtin);
        seeded++;
      }
    }

    if (seeded > 0) {
      log.info({ seeded }, 'Built-in standing orders seeded');
    }
  }

  private _ensureDir(): void {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
    } catch (err) {
      log.error({ err, dir: DATA_DIR }, 'Failed to create data directory');
      throw err;
    }
  }

  private _save(): void {
    const payload: StandingOrdersFile = {
      version: 1,
      orders: [...this.orders.values()],
    };
    const json = JSON.stringify(payload, null, 2);
    try {
      writeFileSync(ORDERS_BAK, json, 'utf8');
      renameSync(ORDERS_BAK, ORDERS_FILE);
    } catch (err) {
      log.error({ err, file: ORDERS_FILE }, 'Failed to save standing-orders.json');
      throw err;
    }
  }
}
