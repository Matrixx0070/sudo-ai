/**
 * @file eval-ladder.mts
 * @description Verifiability Ladder CLI (ADR-0002 / ADR-0007).
 *
 *   pnpm eval:ladder <rung> --route <route> [--repeats N] [--no-cache]
 *
 * Exit 0 = admitted, 1 = not admitted (thin sample, below threshold, or a
 * rung with no engine yet), 2 = usage error.
 */

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
}

const rungArg = args[0];
const route = flag('route');
if (rungArg === undefined || route === undefined || rungArg.startsWith('--')) {
  console.error('usage: pnpm eval:ladder <rung> --route <route> [--repeats N] [--no-cache]');
  process.exit(2);
}
const rung = Number(rungArg);
if (!Number.isInteger(rung) || rung < 0 || rung > 5) {
  console.error(`invalid rung '${rungArg}' — must be an integer 0-5`);
  process.exit(2);
}
const repeats = Number(flag('repeats') ?? '1');
if (!Number.isFinite(repeats) || repeats < 1) {
  console.error('invalid --repeats — must be >= 1');
  process.exit(2);
}

const { runLadderRung } = await import('../src/core/eval/sandbox/ladder.js');
const report = await runLadderRung(rung, route, {
  repeats,
  noCache: args.includes('--no-cache'),
});

console.log('');
console.log(`rung:       ${report.rung}   route: ${report.route}   goldenSet v${report.goldenSetVersion || '-'}`);
if (report.notImplemented === true) {
  console.log(`NOT IMPLEMENTED — ${report.reason}`);
  process.exit(1);
}
console.log(`n:          ${report.n} (${report.passed} passed / ${report.failed} failed)`);
console.log(`passRate:   ${(report.passRate * 100).toFixed(1)}%   threshold: ${(report.threshold * 100).toFixed(1)}%   minN: ${report.minN}`);
console.log(`spend:      $${report.spentUsd.toFixed(4)}${report.haltedOnBudget === true ? '  [HALTED ON BUDGET]' : ''}`);
for (const r of report.results.filter((x) => !x.passed).slice(0, 10)) {
  console.log(`  FAIL ${r.id} (repeat ${r.repeat}) — ${r.detail}`);
}
console.log(`VERDICT:    ${report.admitted ? 'ADMITTED' : 'NOT ADMITTED'}${report.reason !== undefined ? ` — ${report.reason}` : ''}`);
process.exit(report.admitted ? 0 : 1);
