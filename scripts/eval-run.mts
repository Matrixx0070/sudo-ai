/**
 * Eval-sandbox CLI (ADR-0007 Phase 1).
 *
 *   pnpm eval:run <scenario-id|path> [--keep-data]
 *
 * <scenario-id> resolves to evals/sandbox/scenarios/<id>.yaml; a path with a
 * slash or .yaml/.yml/.json suffix is used as-is. Exit 0 on pass, 1 on fail.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2).filter((a) => a !== '--');
const keepData = args.includes('--keep-data');
const target = args.find((a) => !a.startsWith('--'));

if (!target) {
  console.error('usage: pnpm eval:run <scenario-id|path> [--keep-data]');
  process.exit(2);
}

const { PROJECT_ROOT } = await import('../src/core/shared/paths.js');
const { loadScenarioFile } = await import('../src/core/eval/sandbox/scenario.js');
const { runEval } = await import('../src/core/eval/sandbox/eval-runner.js');

const scenarioPath = /[/\\]|\.(ya?ml|json)$/.test(target)
  ? path.resolve(target)
  : path.join(PROJECT_ROOT, 'evals', 'sandbox', 'scenarios', `${target}.yaml`);

if (!existsSync(scenarioPath)) {
  console.error(`scenario not found: ${scenarioPath}`);
  process.exit(2);
}

const scenario = loadScenarioFile(scenarioPath);
console.log(`eval-sandbox: running ${scenario.id} v${scenario.version} (${scenario.title})`);

const report = await runEval(scenario, { keepData });

console.log('');
console.log(`run:      ${report.runId}`);
console.log(`journal:  ${report.journalPath}`);
console.log(`checks:   ${report.scores.checksPassed}/${report.scores.checksTotal}`);
for (const o of report.scores.checkOutcomes) {
  console.log(`  ${o.passed ? 'PASS' : 'FAIL'} ${o.check.type} — ${o.detail}`);
}
console.log(`policy violations: ${report.scores.policyViolations}`);
console.log(`efficiency: wallMs=${report.scores.efficiency.wallMs} steps=${report.scores.efficiency.steps}` +
  (report.scores.efficiency.usd !== undefined ? ` usd=${report.scores.efficiency.usd.toFixed(4)}` : ''));
if (report.turn.error) console.log(`turn error: ${report.turn.error}`);
console.log(report.passed ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exit(report.passed ? 0 : 1);
