/**
 * Eval-sandbox replay CLI (ADR-0007 Phase 3).
 *
 *   pnpm eval:replay <runDir> [--scenario <path>]   # L2: re-grade from journal (no agent, no LLM)
 *   pnpm eval:replay <runDir> --l1 [--keep-data]    # L1: re-run the turn against recorded LLM responses
 *
 * L2 exit 0 on new-scores success, 1 otherwise. L1 exit 0 on pass, 1 on fail.
 * L2 file-based checks need the run's persisted workspace/; if it was deleted
 * they are reported as skipped, not failed.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2).filter((a) => a !== '--');
const l1 = args.includes('--l1');
const keepData = args.includes('--keep-data');
const scenarioIdx = args.indexOf('--scenario');
const scenarioPath = scenarioIdx >= 0 ? args[scenarioIdx + 1] : undefined;
const runDirArg = args.find((a, i) => !a.startsWith('--') && (scenarioIdx < 0 || i !== scenarioIdx + 1));

if (!runDirArg) {
  console.error('usage: pnpm eval:replay <runDir> [--scenario <path>] [--l1] [--keep-data]');
  process.exit(2);
}
const runDir = path.resolve(runDirArg);
if (!existsSync(runDir)) {
  console.error(`run dir not found: ${runDir}`);
  process.exit(2);
}

const { replayL1, replayL2 } = await import('../src/core/eval/sandbox/replay.js');

if (l1) {
  const report = await replayL1(runDir, {
    ...(scenarioPath !== undefined ? { scenarioPath } : {}),
    keepData,
  });
  console.log(`L1 replay of ${runDir}`);
  console.log(`replay run: ${report.runId}`);
  console.log(`checks:     ${report.scores.checksPassed}/${report.scores.checksTotal}`);
  for (const o of report.scores.checkOutcomes) {
    console.log(`  ${o.held ? 'HELD' : o.passed ? 'PASS' : 'FAIL'} ${o.check.type} — ${o.detail}`);
  }
  if (report.turn.error) console.log(`turn error: ${report.turn.error}`);
  console.log(report.passed ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.exit(report.passed ? 0 : 1);
} else {
  const report = await replayL2(runDir, scenarioPath !== undefined ? { scenarioPath } : {});
  console.log(report.summary);
  for (const o of report.scores.checkOutcomes) {
    console.log(`  ${o.skipped ? 'SKIP' : o.passed ? 'PASS' : 'FAIL'} ${o.check.type} — ${o.detail}`);
  }
  process.exit(report.scores.success ? 0 : 1);
}
