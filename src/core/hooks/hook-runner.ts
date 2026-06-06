/**
 * @file hooks/hook-runner.ts
 * @description OpenClaw-inspired 3-type hook runner system for SUDO-AI v4.
 *
 *   1. runVoidHook     — Fire-and-forget (parallel).  Errors swallowed + logged.
 *   2. runModifyingHook — Sequential context mutation.  Each handler receives
 *                         and can modify the context from the previous one.
 *   3. runClaimingHook  — First-claim-wins (priority order).  First handler
 *                         that returns a claim result wins; rest are skipped.
 *
 * Hook lists are sorted by priority (highest first), weight as tiebreaker.
 */

import type { HookEvent, HookContext, Hook } from './index.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('hook-runner');

// --- Types -------------------------------------------------------------------

/** Discriminant for the three hook runner execution strategies. */
export type HookRunnerType = 'void' | 'modifying' | 'claiming';

/** Result envelope — only fields relevant to the hook type are populated. */
export interface HookResult {
  /** True when the hook vetoes or blocks the action. */
  blocked?: boolean;
  /** Approval decision for permission-gate hooks. */
  approval?: 'approved' | 'denied' | 'pending';
  /** Transformed context produced by a modifying hook. */
  transform?: HookContext;
  /** Opaque claim payload — first non-null claim wins. */
  claim?: unknown;
  /** Wall-clock time in ms for this handler. */
  duration?: number;
}

/** A hook enriched with scheduling metadata. */
export interface PrioritizedHook extends Hook {
  /** Execution priority — higher values run first. */
  priority: number;
  /** Secondary sort key within the same priority tier. Higher wins. */
  weight: number;
}

/** Handler for void hooks — fire-and-forget, no return value. */
export type VoidHookHandler = (context: HookContext) => Promise<void>;

/** Handler for modifying hooks — receives context, returns (possibly mutated) context. */
export type ModifyingHookHandler = (context: HookContext) => Promise<HookContext>;

/** Handler for claiming hooks — returns HookResult to claim, or null to pass. */
export type ClaimingHookHandler = (context: HookContext) => Promise<HookResult | null | undefined>;

// --- Config ------------------------------------------------------------------

/** Timeout knobs for the three runner types. */
export interface HookRunnerConfig {
  /** Max wall-clock time (ms) per handler in a void run. Default: 5000 */
  voidTimeout: number;
  /** Max wall-clock time (ms) per handler in a modifying run. Default: 10000 */
  modifyingTimeout: number;
  /** Max wall-clock time (ms) per handler in a claiming run. Default: 3000 */
  claimingTimeout: number;
}

const DEFAULT_CONFIG: HookRunnerConfig = {
  voidTimeout: 5_000,
  modifyingTimeout: 10_000,
  claimingTimeout: 3_000,
};

// --- Helpers -----------------------------------------------------------------

/**
 * Sort hooks by priority (descending), then weight (descending).
 * Returns a new array; the input is not mutated.
 */
export function sortHooksByPriority(hooks: PrioritizedHook[]): PrioritizedHook[] {
  return [...hooks].sort((a, b) => {
    const pa = a.priority ?? 0;
    const pb = b.priority ?? 0;
    if (pb !== pa) return pb - pa;
    const wa = a.weight ?? 0;
    const wb = b.weight ?? 0;
    return wb - wa;
  });
}

/** Race a promise against a timeout.  Resolves undefined on timeout. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T | undefined> {
  if (ms <= 0) return promise;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      log.warn({ label, timeoutMs: ms }, 'Handler timed out');
      resolve(undefined);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}

// --- 1. runVoidHook (parallel, fire-and-forget) ------------------------------

/**
 * Execute all handlers in parallel.  Every handler runs regardless of errors;
 * failures are caught and logged.  The caller receives no results — this is
 * pure side-effect territory.
 *
 * Use for: telemetry, analytics, audit-logging — anything where the hook's
 * return value is irrelevant and must not block the caller.
 *
 * @example
 * ```ts
 * await runVoidHook('after:tool-call', ctx, telemetryHooks);
 * // All telemetryHooks run in parallel; errors are swallowed.
 * ```
 */
export async function runVoidHook(
  event: HookEvent,
  context: HookContext,
  hooks: PrioritizedHook[],
  config?: Partial<HookRunnerConfig>,
): Promise<void> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const sorted = sortHooksByPriority(hooks);
  if (sorted.length === 0) return;

  log.debug({ event, hookCount: sorted.length, runner: 'void' }, 'Running void hooks');

  const settled = await Promise.allSettled(
    sorted.map(async (hook) => {
      const handler = hook.handler as VoidHookHandler;
      try {
        await withTimeout(handler(context), cfg.voidTimeout, `void:${hook.id}`);
      } catch (err) {
        // Swallow — void hooks must never propagate errors.
        log.error({ event, hookId: hook.id, err: String(err) }, 'Void hook threw — swallowed');
      }
    }),
  );

  // Defensive: log any unexpected rejections that slipped through the try/catch.
  for (const r of settled) {
    if (r.status === 'rejected') {
      log.error({ event, reason: String(r.reason) }, 'Void hook unexpected rejection');
    }
  }
}

// --- 2. runModifyingHook (sequential context mutation) -----------------------

/**
 * Execute handlers sequentially, threading context through each one.
 * If a handler throws or times out its changes are discarded and the
 * last known-good context is forwarded to the next handler.
 *
 * Use for: sanitising tool output, injecting context, enriching messages
 * before they reach the model.
 *
 * @example
 * ```ts
 * const enriched = await runModifyingHook('before:brain-call', ctx, transformHooks);
 * // ctx is threaded through each handler in priority order.
 * ```
 *
 * @returns The final (possibly modified) context.
 */
export async function runModifyingHook(
  event: HookEvent,
  context: HookContext,
  hooks: PrioritizedHook[],
  config?: Partial<HookRunnerConfig>,
): Promise<HookContext> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const sorted = sortHooksByPriority(hooks);
  if (sorted.length === 0) return context;

  log.debug({ event, hookCount: sorted.length, runner: 'modifying' }, 'Running modifying hooks');

  let current = context;

  for (const hook of sorted) {
    const handler = hook.handler as unknown as ModifyingHookHandler;
    const start = Date.now();

    try {
      const result = await withTimeout(handler(current), cfg.modifyingTimeout, `modifying:${hook.id}`);
      if (result !== undefined) {
        // Handler returned a valid context — adopt it.
        current = result;
        log.debug({ event, hookId: hook.id, durationMs: Date.now() - start }, 'Modifying hook applied');
      } else {
        // Timed out — keep current context unchanged.
        log.warn({ event, hookId: hook.id }, 'Modifying hook timed out — context unchanged');
      }
    } catch (err) {
      // Handler threw — keep current context, continue.
      log.error({ event, hookId: hook.id, err: String(err) }, 'Modifying hook threw — context unchanged');
    }
  }

  return current;
}

// --- 3. runClaimingHook (first-claim-wins) ----------------------------------

/**
 * Execute handlers in priority order.  The first handler that returns a
 * non-null HookResult claims the event; subsequent handlers are skipped.
 * Returns null if no handler claims.
 *
 * Use for: security vetoes, permission gates, policy enforcement — anywhere
 * a single authoritative decision must be made early.
 *
 * @example
 * ```ts
 * const veto = await runClaimingHook('before:tool-call', ctx, securityHooks);
 * if (veto?.blocked) throw new Error('Tool call blocked by security hook');
 * ```
 *
 * @returns The winning HookResult, or null if nobody claimed.
 */
export async function runClaimingHook(
  event: HookEvent,
  context: HookContext,
  hooks: PrioritizedHook[],
  config?: Partial<HookRunnerConfig>,
): Promise<HookResult | null> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const sorted = sortHooksByPriority(hooks);
  if (sorted.length === 0) return null;

  log.debug({ event, hookCount: sorted.length, runner: 'claiming' }, 'Running claiming hooks');

  for (const hook of sorted) {
    const handler = hook.handler as unknown as ClaimingHookHandler;
    const start = Date.now();

    try {
      const result = await withTimeout(handler(context), cfg.claimingTimeout, `claiming:${hook.id}`);

      if (result !== undefined && result !== null) {
        // Claimed — attach duration and return immediately.
        const claimed: HookResult = { ...result, duration: Date.now() - start };
        log.info(
          { event, hookId: hook.id, durationMs: claimed.duration },
          'Claiming hook claimed event — skipping remaining',
        );
        return claimed;
      }

      // No claim — handler passed; continue to next.
      log.debug({ event, hookId: hook.id, durationMs: Date.now() - start }, 'Claiming hook passed');
    } catch (err) {
      // Handler threw — treat as no-claim and continue.
      log.error({ event, hookId: hook.id, err: String(err) }, 'Claiming hook threw — no-claim, continuing');
    }
  }

  log.debug({ event }, 'No handler claimed the event');
  return null;
}