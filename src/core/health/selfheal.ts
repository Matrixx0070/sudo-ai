/**
 * @file selfheal.ts
 * @description Self-heal engine (ADR-0004): disclosed, category-gated auto-repair.
 *
 * Wraps the watchdog's existing in-process fix callbacks. Behavior is governed
 * by ADR-0004 ("pull-only, artifact-out"):
 *
 *  - Kill switch: SUDO_SELF_HEAL=1 enables the engine. When OFF (default), a
 *    guarded fix runs exactly as it always has (legacy passthrough) — no
 *    ledger, no notify, zero behavior change.
 *  - Category allowlist: SUDO_SELF_HEAL_CATEGORIES (csv) — only pre-approved
 *    categories may heal. Defaults to the three legacy watchdog fixes.
 *  - Disclosure: every engine-mediated heal appends a JSONL record to the
 *    ledger and notifies the owner. Silent healing is forbidden.
 *  - Budget (invariant 10): SUDO_SELF_HEAL_MAX_PER_DAY caps heals per UTC day;
 *    exhaustion halts gracefully and alerts once per day.
 *  - Frozen surfaces (invariant 4): file-touching heals must target paths
 *    under DATA_DIR — assertHealTargetAllowed rejects everything else, which
 *    mechanically excludes identity/constitution/source.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import { DATA_DIR } from '../shared/paths.js';

const log = createLogger('health:selfheal');

export type HealCategory =
  | 'log-rotation'
  | 'disk-gc'
  | 'memory-gc'
  | 'token-refresh'
  | 'process-restart'
  | 'config-revert';

/** Categories the legacy watchdog already fixed silently pre-ADR-0004. */
export const DEFAULT_CATEGORIES: readonly HealCategory[] = [
  'log-rotation',
  'disk-gc',
  'memory-gc',
];

export interface HealRecord {
  ts: string;
  category: HealCategory;
  action: string;
  outcome: 'success' | 'failed' | 'skipped-category' | 'skipped-budget';
  detail: string;
}

export type HealNotifier = (title: string, message: string) => void;

export interface SelfHealOptions {
  /** Ledger file (JSONL, append-only). Tests inject a tmp path. */
  ledgerPath?: string;
  /** Owner-notify seam (proactive notifier in prod). */
  notify?: HealNotifier;
  /** Clock seam for tests. */
  now?: () => Date;
  /** Env seam for tests (defaults to process.env). */
  env?: Record<string, string | undefined>;
}

/** Reject heal targets outside DATA_DIR (frozen surfaces stay untouchable). */
export function assertHealTargetAllowed(target: string, dataDir: string = DATA_DIR): void {
  const resolved = path.resolve(target);
  const root = path.resolve(dataDir) + path.sep;
  if (!resolved.startsWith(root)) {
    throw new Error(`self-heal target outside DATA_DIR is forbidden (ADR-0004): ${resolved}`);
  }
}

export class SelfHealEngine {
  private readonly ledgerPath: string;
  private notifier: HealNotifier | null;
  private readonly now: () => Date;
  private readonly env: Record<string, string | undefined>;
  private healsByDay = new Map<string, number>();
  private budgetAlertedDay: string | null = null;

  constructor(opts: SelfHealOptions = {}) {
    this.ledgerPath = opts.ledgerPath ?? path.join(DATA_DIR, 'selfheal-log.jsonl');
    this.notifier = opts.notify ?? null;
    this.now = opts.now ?? (() => new Date());
    this.env = opts.env ?? process.env;
  }

  setNotifier(fn: HealNotifier): void {
    this.notifier = fn;
  }

  enabled(): boolean {
    return this.env['SUDO_SELF_HEAL'] === '1';
  }

  categoryAllowed(category: HealCategory): boolean {
    const raw = this.env['SUDO_SELF_HEAL_CATEGORIES'];
    const allowed = raw
      ? raw.split(',').map((s) => s.trim()).filter(Boolean)
      : DEFAULT_CATEGORIES;
    return allowed.includes(category);
  }

  private maxPerDay(): number {
    const n = Number.parseInt(this.env['SUDO_SELF_HEAL_MAX_PER_DAY'] ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : 20;
  }

  private dayKey(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private record(category: HealCategory, action: string, outcome: HealRecord['outcome'], detail: string): void {
    const rec: HealRecord = { ts: this.now().toISOString(), category, action, outcome, detail };
    try {
      fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
      fs.appendFileSync(this.ledgerPath, JSON.stringify(rec) + '\n');
    } catch (err) {
      // Disclosure failure must not break the watchdog loop, but is loud.
      log.warn({ err: String(err) }, 'self-heal ledger append failed');
    }
  }

  /**
   * Wrap a fix callback. Flag OFF → the original function, untouched (the
   * pre-ADR silent behavior is a kept capability). Flag ON → category gate,
   * daily budget, disclosure record, owner notify; action errors are recorded
   * and swallowed (watchdog fixes are best-effort, matching legacy semantics
   * where fix errors surface as a still-degraded check next tick).
   */
  guard(category: HealCategory, action: string, fn: () => Promise<void>): () => Promise<void> {
    return async () => {
      if (!this.enabled()) {
        await fn();
        return;
      }
      if (!this.categoryAllowed(category)) {
        this.record(category, action, 'skipped-category', 'category not in SUDO_SELF_HEAL_CATEGORIES');
        log.info({ category, action }, 'self-heal skipped: category not pre-approved');
        return;
      }
      const day = this.dayKey();
      const used = this.healsByDay.get(day) ?? 0;
      if (used >= this.maxPerDay()) {
        this.record(category, action, 'skipped-budget', `daily cap ${this.maxPerDay()} reached`);
        if (this.budgetAlertedDay !== day) {
          this.budgetAlertedDay = day;
          this.notifier?.(
            'SELF-HEAL HALTED: daily budget exhausted',
            `Cap of ${this.maxPerDay()} heals/day reached; further heals skipped until tomorrow (${action} was next).`,
          );
        }
        return;
      }
      this.healsByDay.set(day, used + 1);
      try {
        await fn();
        this.record(category, action, 'success', 'applied');
        this.notifier?.(`SELF-HEAL: ${action}`, `Applied ${category} repair (${action}). Disclosure: ${this.ledgerPath}`);
      } catch (err) {
        this.record(category, action, 'failed', String(err));
        this.notifier?.(`SELF-HEAL FAILED: ${action}`, `${category} repair threw: ${String(err)}`);
      }
    };
  }
}
