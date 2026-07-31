/**
 * @file eval-ladder-gate.mts
 * @description ADR-0002 admission gate check (invariant-8 attestation).
 *
 *   pnpm eval:ladder-gate [route ...] [--rung N]
 *
 * With no routes it reads the configured brain chain (models.primary[]) from
 * config/sudo-ai.json5. Reports, per route, whether a passing cached rung-N
 * verdict exists. Advisory by default; SUDO_EVAL_LADDER_ENFORCE=1 makes a
 * missing/failing verdict a refusal (exit 1).
 *
 * This is deliberately a CLI rather than a config-load hook: auto-wiring it
 * into startup would put eval-sandbox imports on the boot path, and ADR-0002
 * wants the gate default-OFF until the incumbent chain is graded. The cached
 * verdict row IS the attestation the operator produces with `pnpm eval:ladder`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const rungIdx = args.indexOf('--rung');
const rung = rungIdx === -1 ? 1 : Number(args[rungIdx + 1]);
if (!Number.isInteger(rung) || rung < 0 || rung > 5) {
  console.error(`invalid --rung '${args[rungIdx + 1]}' — must be an integer 0-5`);
  process.exit(2);
}
const routes = args.filter((a, i) => !a.startsWith('--') && i !== rungIdx + 1);

function configuredChain(): string[] {
  // Deliberately a regex, not the config loader: this CLI must work even when
  // the config fails schema validation (that is when you most want to know).
  try {
    const raw = readFileSync(join(process.cwd(), 'config', 'sudo-ai.json5'), 'utf-8');
    const block = /primary\s*:\s*\[([\s\S]*?)\n\s*\]/.exec(raw);
    if (block === null) return [];
    return [...block[1]!.matchAll(/id\s*:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
  } catch {
    return [];
  }
}

const targets = routes.length > 0 ? routes : configuredChain();
if (targets.length === 0) {
  console.error('no routes given and none found in config/sudo-ai.json5 models.primary[]');
  process.exit(2);
}

const { checkRouteAdmission, ladderEnforceEnabled } = await import('../src/core/eval/sandbox/ladder-gate.js');

console.log('');
console.log(`ladder gate — rung ${rung}, mode: ${ladderEnforceEnabled() ? 'ENFORCING' : 'advisory (WARN only)'}`);
let refused = 0;
for (const route of targets) {
  const v = checkRouteAdmission(route, rung);
  const tag = v.admitted ? 'ADMITTED' : v.missing ? 'NO VERDICT' : 'FAILED';
  if (!v.allowed) refused += 1;
  console.log(`  [${v.allowed ? 'ok ' : 'REFUSED'}] ${tag.padEnd(10)} ${route}`);
  if (!v.admitted) console.log(`             ${v.reason}`);
}
console.log('');
process.exit(refused > 0 ? 1 : 0);
