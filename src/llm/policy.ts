/**
 * @file policy.ts
 * @description ONE file owns all cross-cutting LLM call policy (gw-refactor
 * Phase 4): retry, per-route circuit breaker, priority lanes with per-caller
 * concurrency caps, and asymmetric budgets. Transports wrap their attempt in
 * `runWithPolicy`; nothing else in src/llm re-implements any of this.
 *
 * Asymmetry rule (the spine of every decision here):
 * - priority 'user'      → NEVER blocked by policy. Open breaker → pass
 *   through (logged). Over budget → run anyway but return a 'degrade'
 *   decision so the caller can downgrade the alias one tier.
 * - priority 'background'→ FAIL-CLOSED. Open breaker / over budget /
 *   SUDO_LLM_BACKGROUND_HALT=1 → LLMPolicyError with `.skipped = true`.
 *
 * Fail-open on POLICY-INTERNAL bugs: if the breaker/lane/budget machinery
 * itself throws unexpectedly, the error is logged and the attempt runs bare —
 * a user must never be blocked by a bug in the policy layer itself.
 *
 * Spend tracking is in-memory only (day-keyed Map fed by `recordSpend`);
 * Phase 5 wires actual per-call costs. cost-tracker's getCostBySource is an
 * instance method on CostTracker (needs a live DB handle), so historical
 * spend is deliberately NOT consulted here — keeping src/llm dependency-light.
 *
 * Env levers:
 * - SUDO_LLM_RETRY_DISABLE=1        → single attempt, no retry.
 * - SUDO_LLM_LANE_CAPS='{"swarm":3}'→ per-caller concurrency cap overrides.
 * - SUDO_LLM_BUDGETS='{"swarm":2.5}'→ per-caller daily USD budgets.
 * - SUDO_LLM_GLOBAL_BUDGET_USD=10   → global daily cap (everything but
 *   'agent-loop' halts once exceeded).
 * - SUDO_LLM_BACKGROUND_HALT=1      → emergency: skip ALL background calls.
 */

import { createLogger } from '../core/shared/logger.js';
import { classifyThrown, isRetryable, LLMPolicyError, type LLMErrorClass } from './errors.js';
import { isSeatKey } from './limits.js';

const log = createLogger('llm-policy');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** What the caller should do about a blown per-caller budget. */
export type BudgetDecision = 'ok' | 'degrade';

/** Handed to every attempt. */
export interface AttemptContext {
  /**
   * The attempt MUST call this the moment the first streamed token reaches
   * the consumer. After that, policy NEVER retries — a partial answer has
   * been seen and a silent re-run would duplicate it; the stream layer owns
   * surfacing the failure as stop_reason 'error'.
   */
  markFirstToken(): void;
  /**
   * 'degrade' when the caller's daily budget is exceeded on a USER call: run
   * anyway, but the caller should downgrade its alias one tier (degradeAlias).
   */
  budgetDecision: BudgetDecision;
  signal?: AbortSignal;
}

export interface RunWithPolicyOptions<T> {
  /** Breaker/lane key, e.g. 'gateway:chat', 'anthropic:messages'. */
  route: string;
  /** Who is calling ('agent-loop', 'swarm:<role>', 'cognitive-stream', …). */
  caller: string;
  priority: 'user' | 'background';
  /** Estimated cost of this call, counted against budgets pre-flight. */
  estimateCostUsd?: number;
  /** The actual transport call. */
  attempt: (ctx: AttemptContext) => Promise<T>;
  /** Optional hook fired when the first token is marked. */
  onFirstToken?: () => void;
  /** Error → taxonomy class (defaults to classifyThrown). */
  classify?: (err: unknown) => LLMErrorClass;
  /** Test seams — injectable jitter RNG ([0,1)) and sleep. */
  rng?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Per-call attempt cap (clamped to 1..MAX_ATTEMPTS). Used by callers that
   * OWN retry themselves (Brain's failover loop passes 1 via the transport's
   * `noRetry` so policy retries never multiply under failover attempts).
   * Unset → MAX_ATTEMPTS (or 1 under SUDO_LLM_RETRY_DISABLE=1).
   */
  maxAttempts?: number;
}

export interface PolicyOutcome<T> {
  value: T;
  /** 'degrade' → caller was over budget (user lane); downgrade the alias. */
  budgetDecision: BudgetDecision;
}

// ---------------------------------------------------------------------------
// Retry constants
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 250;
const JITTER = 0.2;

// ---------------------------------------------------------------------------
// Circuit breaker (per route)
// ---------------------------------------------------------------------------

const BREAKER_FAILURE_THRESHOLD = 5;
const BREAKER_WINDOW_MS = 60_000;
const BREAKER_OPEN_MS = 30_000;

interface BreakerState {
  /** Timestamps of recent failures (pruned to the 60s window). */
  failures: number[];
  /** When > now the breaker is OPEN. 0 = closed. */
  openUntil: number;
  /** True once the open period has elapsed and a single probe is in flight. */
  probeInFlight: boolean;
}

const breakers = new Map<string, BreakerState>();

function breakerFor(route: string): BreakerState {
  let s = breakers.get(route);
  if (s === undefined) {
    s = { failures: [], openUntil: 0, probeInFlight: false };
    breakers.set(route, s);
  }
  return s;
}

type BreakerGate = 'closed' | 'open' | 'probe';

/** Evaluate the breaker for a new call NOW. Mutates probe bookkeeping. */
function breakerGate(route: string, now: number): BreakerGate {
  const s = breakerFor(route);
  if (s.openUntil === 0) return 'closed';
  if (now < s.openUntil) return 'open';
  // Open period elapsed → half-open: exactly one probe runs.
  if (s.probeInFlight) return 'open';
  s.probeInFlight = true;
  return 'probe';
}

function breakerRecordFailure(route: string, now: number, wasProbe: boolean): void {
  const s = breakerFor(route);
  if (wasProbe) {
    // Failed probe → re-open for another full period.
    s.probeInFlight = false;
    s.openUntil = now + BREAKER_OPEN_MS;
    return;
  }
  s.failures = s.failures.filter((t) => now - t < BREAKER_WINDOW_MS);
  s.failures.push(now);
  if (s.openUntil === 0 && s.failures.length >= BREAKER_FAILURE_THRESHOLD) {
    s.openUntil = now + BREAKER_OPEN_MS;
    log.warn({ route, failures: s.failures.length }, 'circuit opened');
  }
}

function breakerRecordSuccess(route: string, wasProbe: boolean): void {
  const s = breakerFor(route);
  if (wasProbe) s.probeInFlight = false;
  s.failures = [];
  s.openUntil = 0;
}

// ---------------------------------------------------------------------------
// Priority lanes + per-caller concurrency caps (hand-rolled, no deps)
// ---------------------------------------------------------------------------

/** Default per-caller caps: key is the caller or its prefix before ':'. */
const DEFAULT_LANE_CAPS: Record<string, number> = {
  swarm: 3,
  'cognitive-stream': 1,
};

/** 'swarm:researcher' → 'swarm'; 'agent-loop' → 'agent-loop'. */
function callerKey(caller: string): string {
  const idx = caller.indexOf(':');
  return idx === -1 ? caller : caller.slice(0, idx);
}

function laneCaps(): Record<string, number> {
  const raw = process.env['SUDO_LLM_LANE_CAPS'];
  if (raw !== undefined && raw.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return { ...DEFAULT_LANE_CAPS, ...(parsed as Record<string, number>) };
      }
    } catch {
      log.warn({ raw }, 'SUDO_LLM_LANE_CAPS is not valid JSON — using defaults');
    }
  }
  return DEFAULT_LANE_CAPS;
}

function capFor(caller: string): number {
  const cap = laneCaps()[callerKey(caller)];
  return typeof cap === 'number' && cap > 0 ? cap : Infinity;
}

interface Waiter {
  caller: string;
  resolve: (release: () => void) => void;
}

interface RouteLane {
  userQueue: Waiter[];
  bgQueue: Waiter[];
}

const lanes = new Map<string, RouteLane>();
/** Active in-flight calls per caller key (global across routes). */
const activeByCaller = new Map<string, number>();

function laneFor(route: string): RouteLane {
  let l = lanes.get(route);
  if (l === undefined) {
    l = { userQueue: [], bgQueue: [] };
    lanes.set(route, l);
  }
  return l;
}

function startWaiter(route: string, w: Waiter): void {
  const key = callerKey(w.caller);
  activeByCaller.set(key, (activeByCaller.get(key) ?? 0) + 1);
  let released = false;
  w.resolve(() => {
    if (released) return;
    released = true;
    activeByCaller.set(key, (activeByCaller.get(key) ?? 1) - 1);
    dispatch(route);
  });
}

/** Dispatch as many queued waiters as caps allow. Users first; background
 * only while NO user is waiting on the route (users preempt + starve bg). */
function dispatch(route: string): void {
  const lane = laneFor(route);
  for (const queue of [lane.userQueue, lane.bgQueue]) {
    if (queue === lane.bgQueue && lane.userQueue.length > 0) return;
    for (let i = 0; i < queue.length; ) {
      const w = queue[i]!;
      if ((activeByCaller.get(callerKey(w.caller)) ?? 0) < capFor(w.caller)) {
        queue.splice(i, 1);
        startWaiter(route, w);
      } else {
        i += 1;
      }
    }
    // Cap-blocked USER waiters must not unblock background behind them.
    if (queue === lane.userQueue && queue.length > 0) return;
  }
}

/** Acquire a slot on `route` for `caller`. Resolves with a release fn. */
function acquire(route: string, caller: string, priority: 'user' | 'background'): Promise<() => void> {
  return new Promise<() => void>((resolve) => {
    const lane = laneFor(route);
    (priority === 'user' ? lane.userQueue : lane.bgQueue).push({ caller, resolve });
    dispatch(route);
  });
}

// ---------------------------------------------------------------------------
// Budgets (asymmetric)
// ---------------------------------------------------------------------------

interface SpendState {
  day: string;
  byCaller: Map<string, number>;
  total: number;
  /** Calls on flat-subscription seat routes today (see seatCallLimit). */
  seatCalls: number;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

const spend: SpendState = { day: todayKey(), byCaller: new Map(), total: 0, seatCalls: 0 };

function rolloverSpend(): void {
  const today = todayKey();
  if (spend.day !== today) {
    spend.day = today;
    spend.byCaller.clear();
    spend.total = 0;
    spend.seatCalls = 0;
    _budgetAlertedKeys.clear();
  }
}

/**
 * Daily call-count ceiling for seat routes (claude-oauth). Seat calls are
 * priced $0 (limits.ts), so the USD budget no longer bounds them — this is the
 * runaway-loop backstop: it caps CALLS, not dollars. Generous by design
 * (2026-07-22 peak was 418 calls/day). `SUDO_SEAT_DAILY_CALL_LIMIT` overrides;
 * `0`/`off` disables. In-memory — a restart resets the count (acceptable for
 * a backstop with 5x headroom).
 */
const SEAT_CALL_LIMIT_DEFAULT = 2000;

function seatCallLimit(): number {
  const raw = process.env['SUDO_SEAT_DAILY_CALL_LIMIT'];
  if (raw === undefined) return SEAT_CALL_LIMIT_DEFAULT;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '' || trimmed === 'off' || trimmed === '0') return Infinity;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : SEAT_CALL_LIMIT_DEFAULT;
}

// ---------------------------------------------------------------------------
// GW-1: budget-exhaustion alert seam
// ---------------------------------------------------------------------------

/** One exhaustion alert. Boot wires a sink (telemetry + owner notice). */
export interface BudgetAlert {
  verdict: 'caller_exceeded' | 'global_exceeded' | 'seat_calls_exceeded';
  lane: 'user' | 'background';
  caller: string;
  route: string;
  /** UTC day the exhaustion happened on. */
  day: string;
}

type BudgetAlertSink = (alert: BudgetAlert) => void;
let _budgetAlertSink: BudgetAlertSink | null = null;

/**
 * Register a sink for budget-exhaustion alerts (invariant #10: exhaustion must
 * alert + report on Telemetry). Pass null to clear. Until a sink is wired the
 * alert is a loud log only.
 */
export function setBudgetAlertSink(sink: BudgetAlertSink | null): void {
  _budgetAlertSink = sink;
}

/** Dedupe key set — one alert per (day, verdict, lane); cleared on day rollover. */
const _budgetAlertedKeys = new Set<string>();

function emitBudgetAlert(
  verdict: BudgetAlert['verdict'],
  lane: 'user' | 'background',
  caller: string,
  route: string,
): void {
  rolloverSpend();
  const key = `${spend.day}:${verdict}:${lane}`;
  if (_budgetAlertedKeys.has(key)) return;
  _budgetAlertedKeys.add(key);
  const alert: BudgetAlert = { verdict, lane, caller, route, day: spend.day };
  log.error(
    { ...alert },
    `LLM budget exhausted (${verdict}, ${lane} lane) — ${lane === 'user' ? 'degrading' : 'skipping'} ${caller}`,
  );
  try {
    _budgetAlertSink?.(alert);
  } catch (err) {
    log.error({ route, err: String(err) }, 'budget alert sink threw — ignored');
  }
}

// ---------------------------------------------------------------------------
// GW-1: seed today's spend from durable history at boot
// ---------------------------------------------------------------------------

/**
 * Seed today's in-memory spend from the durable gateway.db ledger at boot so
 * budget enforcement SURVIVES restarts instead of resetting to zero. `logging.ts`
 * owns the DB and derives the numbers (`GatewayCallLog.daySpend()`); policy stays
 * dependency-light and just accepts them here. Idempotent + safe:
 *  - a stale/next-day seed is ignored (day must equal today),
 *  - never clobbers spend already accrued this process (total>0 → no-op).
 */
export function initDaySpendFromHistory(seed: {
  day: string;
  total: number;
  byCaller: Map<string, number>;
}): void {
  rolloverSpend();
  if (seed.day !== spend.day) return;
  if (spend.total > 0) return;
  spend.total = Number.isFinite(seed.total) && seed.total > 0 ? seed.total : 0;
  spend.byCaller.clear();
  for (const [k, v] of seed.byCaller) {
    if (Number.isFinite(v) && v > 0) spend.byCaller.set(k, v);
  }
  log.info(
    { day: spend.day, total: spend.total, callers: spend.byCaller.size },
    'GW-1: seeded day-spend from ledger history',
  );
}

/**
 * Record actual USD spend for a caller (Phase 5 wires real per-call costs;
 * until then transports call this with whatever estimate they have).
 */
export function recordSpend(caller: string, usd: number): void {
  if (!Number.isFinite(usd) || usd <= 0) return;
  rolloverSpend();
  const key = callerKey(caller);
  spend.byCaller.set(key, (spend.byCaller.get(key) ?? 0) + usd);
  spend.total += usd;
}

/** Current recorded spend for a caller today (test/observability helper). */
export function getSpend(caller: string): number {
  rolloverSpend();
  return spend.byCaller.get(callerKey(caller)) ?? 0;
}

function budgetsFromEnv(): Record<string, number> {
  const raw = process.env['SUDO_LLM_BUDGETS'];
  if (raw === undefined || raw.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, number>;
    }
  } catch {
    log.warn({ raw }, 'SUDO_LLM_BUDGETS is not valid JSON — budgets disabled');
  }
  return {};
}

/**
 * GW-1: the global daily USD cap. `SUDO_DAILY_LLM_BUDGET_USD` (prod-facing
 * name, shared with self-build + tenancy) wins; `SUDO_LLM_GLOBAL_BUDGET_USD`
 * is the legacy alias. `off`/`0`/empty/invalid → Infinity (enforcement OFF).
 */
function globalBudget(): number {
  for (const key of ['SUDO_DAILY_LLM_BUDGET_USD', 'SUDO_LLM_GLOBAL_BUDGET_USD']) {
    const raw = process.env[key];
    if (raw === undefined) continue;
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === '' || trimmed === 'off') continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return Infinity;
}

/** GW-1: true when a global daily USD cap is configured (enforcement ON). */
export function isGlobalBudgetEnforced(): boolean {
  return globalBudget() !== Infinity;
}

type BudgetVerdict = 'ok' | 'caller_exceeded' | 'global_exceeded';

function budgetVerdict(caller: string, estimate: number): BudgetVerdict {
  rolloverSpend();
  const key = callerKey(caller);
  if (spend.total + estimate > globalBudget() && key !== 'agent-loop') {
    return 'global_exceeded';
  }
  const cap = budgetsFromEnv()[key];
  if (typeof cap === 'number' && cap >= 0 && (spend.byCaller.get(key) ?? 0) + estimate > cap) {
    return 'caller_exceeded';
  }
  return 'ok';
}

// ---------------------------------------------------------------------------
// degradeAlias — one tier down per blown-budget decision
// ---------------------------------------------------------------------------

const DEGRADE_CHAIN: Record<string, string> = {
  'sudo/frontier': 'sudo/mid',
  'sudo/mid': 'sudo/cheap',
  'sudo/cheap': 'sudo/local',
  'sudo/local': 'sudo/local',
};

/** frontier → mid → cheap → local (stays at local). Non-aliases pass through. */
export function degradeAlias(alias: string): string {
  return DEGRADE_CHAIN[alias] ?? alias;
}

// ---------------------------------------------------------------------------
// runWithPolicy
// ---------------------------------------------------------------------------

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pre-flight policy decisions. Throws LLMPolicyError for intentional skips. */
function preflight(
  opts: RunWithPolicyOptions<unknown>,
  now: number,
): { budgetDecision: BudgetDecision; wasProbe: boolean } {
  const { route, caller, priority } = opts;

  // Emergency lever: all background calls skipped immediately.
  if (priority === 'background' && process.env['SUDO_LLM_BACKGROUND_HALT'] === '1') {
    throw new LLMPolicyError(`[llm-policy] background halt: ${caller} → ${route} skipped`, {
      class: 'overloaded',
      route,
      retryable: false,
      skipped: true,
    });
  }

  // Budgets. Asymmetry (GW-1): a USER call is NEVER blocked by budget — it runs
  // and returns 'degrade' so the caller drops the alias one tier. A BACKGROUND
  // call fails closed. Either way, exhaustion emits ONE throttled alert.
  let budgetDecision: BudgetDecision = 'ok';
  const verdict = budgetVerdict(caller, opts.estimateCostUsd ?? 0);
  if (verdict !== 'ok') {
    if (priority === 'user') {
      budgetDecision = 'degrade';
      emitBudgetAlert(verdict, 'user', caller, route);
      log.warn({ route, caller, verdict }, 'budget exceeded — user call allowed, degrade alias one tier');
    } else {
      emitBudgetAlert(verdict, 'background', caller, route);
      throw new LLMPolicyError(
        `[llm-policy] ${verdict === 'global_exceeded' ? 'global' : 'caller'} budget exceeded: ${caller} → ${route} skipped`,
        { class: 'billing', route, retryable: false, skipped: true },
      );
    }
  }

  // Seat call-count ceiling: seat routes are priced $0, so the USD budget
  // cannot bound them — cap raw calls/day instead. Same asymmetry as budgets:
  // user lane degrades (never blocked), background lane fails closed.
  if (isSeatKey(route)) {
    rolloverSpend();
    spend.seatCalls += 1;
    if (spend.seatCalls > seatCallLimit()) {
      if (priority === 'user') {
        budgetDecision = 'degrade';
        emitBudgetAlert('seat_calls_exceeded', 'user', caller, route);
        log.warn({ route, caller, seatCalls: spend.seatCalls }, 'seat call ceiling exceeded — user call allowed, degrade alias one tier');
      } else {
        emitBudgetAlert('seat_calls_exceeded', 'background', caller, route);
        throw new LLMPolicyError(
          `[llm-policy] seat call ceiling exceeded (${spend.seatCalls}/day): ${caller} → ${route} skipped`,
          { class: 'billing', route, retryable: false, skipped: true },
        );
      }
    }
  }

  // Circuit breaker.
  const gate = breakerGate(route, now);
  let wasProbe = gate === 'probe';
  if (gate === 'open') {
    if (priority === 'user') {
      // Fail-open nuance: user requests are never blocked by policy.
      log.warn({ route, caller }, 'circuit open — user call allowed through');
    } else {
      throw new LLMPolicyError(`[llm-policy] circuit open: ${caller} → ${route} skipped`, {
        class: 'overloaded',
        route,
        retryable: false,
        skipped: true,
      });
    }
  }
  return { budgetDecision, wasProbe };
}

/**
 * The policy wrapper every transport uses. Retry (pre-first-token only),
 * breaker, lanes, budgets — see file header for the full semantics.
 */
export async function runWithPolicy<T>(opts: RunWithPolicyOptions<T>): Promise<PolicyOutcome<T>> {
  const classify = opts.classify ?? classifyThrown;
  const sleep = opts.sleep ?? defaultSleep;
  const rng = opts.rng ?? Math.random;

  // -- Policy pre-flight (fail-open on internal bugs, throw on decisions) ----
  let budgetDecision: BudgetDecision = 'ok';
  let wasProbe = false;
  let policyBroken = false;
  try {
    ({ budgetDecision, wasProbe } = preflight(opts as RunWithPolicyOptions<unknown>, Date.now()));
  } catch (err) {
    if (err instanceof LLMPolicyError) throw err; // intentional skip
    policyBroken = true;
    log.error({ route: opts.route, err: String(err) }, 'policy internals threw — running attempt bare');
  }

  // -- Lane acquisition (fail-open) ------------------------------------------
  let release: (() => void) | undefined;
  if (!policyBroken) {
    try {
      release = await acquire(opts.route, opts.caller, opts.priority);
    } catch (err) {
      log.error({ route: opts.route, err: String(err) }, 'lane scheduler threw — running attempt bare');
    }
  }

  // -- Attempt loop -----------------------------------------------------------
  let firstTokenSeen = false;
  const ctx: AttemptContext = {
    markFirstToken: () => {
      if (firstTokenSeen) return;
      firstTokenSeen = true;
      try {
        opts.onFirstToken?.();
      } catch (err) {
        log.error({ route: opts.route, err: String(err) }, 'onFirstToken hook threw — ignored');
      }
    },
    budgetDecision,
  };

  const maxAttempts =
    opts.maxAttempts !== undefined
      ? Math.min(Math.max(1, Math.floor(opts.maxAttempts)), MAX_ATTEMPTS)
      : process.env['SUDO_LLM_RETRY_DISABLE'] === '1'
        ? 1
        : MAX_ATTEMPTS;

  try {
    for (let attemptNo = 0; ; attemptNo++) {
      try {
        const value = await opts.attempt(ctx);
        try {
          breakerRecordSuccess(opts.route, wasProbe);
        } catch (err) {
          log.error({ route: opts.route, err: String(err) }, 'breaker bookkeeping threw — ignored');
        }
        return { value, budgetDecision };
      } catch (err) {
        let cls: LLMErrorClass = 'unknown';
        try {
          cls = classify(err);
          breakerRecordFailure(opts.route, Date.now(), wasProbe);
          wasProbe = false; // the probe was consumed by this failure
        } catch (inner) {
          log.error({ route: opts.route, err: String(inner) }, 'classify/breaker threw — treating as unknown');
        }
        // After the first streamed token, a retry would duplicate partial
        // output — the error is terminal; the stream layer surfaces it.
        if (firstTokenSeen || !isRetryable(cls) || attemptNo >= maxAttempts - 1) {
          throw err;
        }
        const backoff = BACKOFF_BASE_MS * 2 ** attemptNo;
        const jittered = backoff * (1 + (rng() * 2 - 1) * JITTER);
        await sleep(jittered);
      }
    }
  } finally {
    try {
      release?.();
    } catch (err) {
      log.error({ route: opts.route, err: String(err) }, 'lane release threw — ignored');
    }
  }
}

// ---------------------------------------------------------------------------
// Test reset
// ---------------------------------------------------------------------------

/** Test-only: wipe breaker, lane, and spend state between cases. */
export function __resetPolicyState(): void {
  breakers.clear();
  lanes.clear();
  activeByCaller.clear();
  spend.day = todayKey();
  spend.byCaller.clear();
  spend.total = 0;
  spend.seatCalls = 0;
  _budgetAlertedKeys.clear();
  _budgetAlertSink = null;
}
