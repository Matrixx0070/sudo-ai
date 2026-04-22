/**
 * Type definitions for the Standing Orders automation system.
 *
 * Standing orders are permanent autonomous rules the agent follows without
 * being explicitly prompted. Each order has a trigger that determines when
 * it executes and a natural-language action for the agent to carry out.
 */

// ---------------------------------------------------------------------------
// Trigger variants
// ---------------------------------------------------------------------------

/** Time-based trigger using a cron expression. */
export interface ScheduleTrigger {
  kind: 'schedule';
  /** Standard cron expression (5 or 6 field). */
  cron: string;
  /** IANA timezone string, e.g. "UTC". */
  tz: string;
}

/** Event-based trigger that fires when a named system event occurs. */
export interface EventTrigger {
  kind: 'event';
  /** Event name: "message" | "boot" | "shutdown" | "error" */
  event: string;
}

/** Periodic condition check — evaluates a condition string every N ms. */
export interface ConditionTrigger {
  kind: 'condition';
  /** Natural-language or structured condition description. */
  check: string;
  /** Evaluation interval in milliseconds. */
  intervalMs: number;
}

/** Discriminated union of all trigger kinds. */
export type OrderTrigger = ScheduleTrigger | EventTrigger | ConditionTrigger;

// ---------------------------------------------------------------------------
// StandingOrder
// ---------------------------------------------------------------------------

/**
 * A permanent autonomous rule followed by the agent.
 */
export interface StandingOrder {
  /** Unique slug identifier, e.g. "morning-briefing". */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Explanation of what this order does. */
  description: string;
  /** When/how the order fires. */
  trigger: OrderTrigger;
  /** Natural-language instruction forwarded to the agent loop. */
  action: string;
  /** Whether this order is currently active. */
  enabled: boolean;
  /** ISO-8601 datetime of the last execution, if any. */
  lastExecuted?: string;
  /** Total number of times this order has been executed. */
  executionCount: number;
  /** ISO-8601 datetime when this order was created. */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Persistence schema
// ---------------------------------------------------------------------------

/** Shape of data/standing-orders.json on disk. */
export interface StandingOrdersFile {
  version: 1;
  orders: StandingOrder[];
}
