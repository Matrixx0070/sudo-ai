/**
 * @file shutdown.ts
 * @description Graceful-shutdown registry, extracted verbatim from cli.ts.
 *
 * Teardown functions are collected here and drained in reverse-registration
 * order (LIFO — last-started stops first) when a SIGINT/SIGTERM arrives. This
 * is a pure mechanical move out of cli.ts: the logic is byte-identical and the
 * logger name is deliberately kept as 'cli' so the emitted log output does not
 * change.
 */

import { createLogger } from '../shared/logger.js';

// Logger name kept as 'cli' (NOT 'cli:shutdown') so log output stays identical
// to when this lived inline in cli.ts.
const log = createLogger('cli');

// ---------------------------------------------------------------------------
// Shutdown registry — all teardown functions collected here
// ---------------------------------------------------------------------------

const shutdownHandlers: Array<() => Promise<void> | void> = [];

let isShuttingDown = false;

export function registerShutdown(fn: () => Promise<void> | void): void {
  shutdownHandlers.push(fn);
}

export async function runShutdown(signal: string): Promise<void> {
  // Re-entrancy guard: SIGINT and SIGTERM are independent one-shot handlers,
  // so a second signal arriving during async teardown would otherwise re-run
  // every handler (double db.close(), double adapter stop, etc.).
  if (isShuttingDown) return;
  isShuttingDown = true;

  log.info({ signal }, 'Graceful shutdown initiated');

  // Run in reverse-registration order (LIFO — last-started stops first).
  // Iterate over a copy so the source array is not mutated in place.
  for (const handler of [...shutdownHandlers].reverse()) {
    try {
      await handler();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'Shutdown handler error — continuing teardown');
    }
  }

  log.info('SUDO-AI v5 shutdown complete');
  process.exit(0);
}
