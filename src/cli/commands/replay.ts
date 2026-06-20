/**
 * @file cli/commands/replay.ts
 * @description `sudo-ai replay <sessionId>` — inspect a captured session's
 * execution trace through the ReplayEngine.
 *
 * Traces are recorded to traces.db (DATA_DIR) only under SUDO_TRACE_CAPTURE=1.
 * This command is a READ-ONLY consumer: it builds a ReplayEngine from a
 * session's captured traces and summarizes what was recorded — tool/brain step
 * counts, whether the session is re-feedable (`replayable`), the ordered tool
 * sequence, and the pinned sampling of the first brain call — so a run can be
 * debugged or handed to the regression / eval harness. It never writes and
 * never boots the daemon.
 *
 * Full deterministic re-execution (driving the agent loop through
 * `makeReplayToolExecutor`) is a deliberate follow-up; this slice exposes the
 * inspection half of the engine that was otherwise orphaned (no production
 * caller).
 */

import { TraceStore } from '../../core/learning/trace-store.js';
import { ReplayEngine, type ReplaySampling } from '../../core/learning/replay-engine.js';

/** Structured summary of a captured session's replayable trace. */
export interface ReplayReport {
  sessionId: string;
  /** True when the session has any re-feedable captured payloads. */
  replayable: boolean;
  toolStepCount: number;
  brainStepCount: number;
  /** Ordered captured tool calls. `hasResult=false` ⇒ fact-of-call only (capture was off). */
  toolSequence: Array<{ toolName: string; success: boolean; hasResult: boolean }>;
  /** Pinned sampling of the first captured brain call, if any. */
  sampling?: ReplaySampling;
}

/** Build a structured replay report for a captured session. Pure + unit-testable. */
export function buildReplayReport(store: TraceStore, sessionId: string): ReplayReport {
  const engine = ReplayEngine.fromSession(store, sessionId);
  const tools = engine.toolSteps();
  return {
    sessionId,
    replayable: engine.isReplayable,
    toolStepCount: tools.length,
    brainStepCount: engine.brainSteps().length,
    toolSequence: tools.map((t) => ({
      toolName: t.toolName,
      success: t.success,
      hasResult: t.result !== undefined,
    })),
    sampling: engine.sampling(0),
  };
}

/**
 * `sudo-ai replay <sessionId> [--json] [--db <path>]`.
 * Returns a process exit code (0 ok, 2 usage error).
 */
export async function runReplay(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const dbIdx = args.indexOf('--db');
  // --db must be followed by a real path — reject a trailing --db or a flag-like
  // value, else we'd silently fall back to the default DB (or have init() mkdir a
  // junk directory named after the next flag).
  if (dbIdx >= 0 && (dbIdx + 1 >= args.length || (args[dbIdx + 1] ?? '').startsWith('--'))) {
    console.error('usage: sudo-ai replay <sessionId> [--json] [--db <path>]');
    console.error('  --db requires a path argument.');
    return 2;
  }
  const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : undefined; // undefined → DATA_DIR/traces.db
  // First positional that is not the value following --db.
  const sessionId = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--db');

  if (!sessionId) {
    console.error('usage: sudo-ai replay <sessionId> [--json] [--db <path>]');
    console.error('  Inspects a captured session trace (recorded under SUDO_TRACE_CAPTURE=1).');
    return 2;
  }

  const store = new TraceStore(dbPath);
  try {
    await store.init();
    const report = buildReplayReport(store, sessionId);

    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return 0;
    }

    console.log(`Replay report — session ${report.sessionId}`);
    console.log(`  replayable:  ${report.replayable}`);
    console.log(`  tool steps:  ${report.toolStepCount}`);
    console.log(`  brain steps: ${report.brainStepCount}`);
    if (report.sampling) console.log(`  pinned sampling: ${JSON.stringify(report.sampling)}`);

    if (report.toolStepCount === 0 && report.brainStepCount === 0) {
      console.log('\n  No captured traces for this session.');
      console.log('  (Trace capture requires SUDO_TRACE_CAPTURE=1 at runtime.)');
    } else if (report.toolStepCount > 0) {
      console.log('\n  Tool sequence:');
      report.toolSequence.forEach((t, i) => {
        const flags = `${t.success ? 'ok' : 'FAIL'}${t.hasResult ? '' : ', no captured output'}`;
        console.log(`    ${i + 1}. ${t.toolName} (${flags})`);
      });
    }
    return 0;
  } finally {
    store.close();
  }
}
