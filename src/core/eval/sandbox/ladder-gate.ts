/**
 * @file ladder-gate.ts
 * @description ADR-0002 admission gate (invariant-8 shape): config load WARNs
 * when a brain-chain entry lacks a passing cached rung-1 verdict;
 * SUDO_EVAL_LADDER_ENFORCE=1 upgrades WARN → refuse-to-route for tool turns.
 *
 * DEFAULT OFF, deliberately: until the ladder has graded the incumbent chain,
 * enforcing would brick the brain on a fresh deploy. That is the ADR's own
 * requirement — "a fresh deploy can never brick the brain" — and the reason
 * this ships as a warning first and a gate second.
 *
 * The cached verdict artifact IS the attestation (invariant 8: gates are
 * harness-enforced even when human-mediated — the operator runs
 * `pnpm eval:ladder <rung> --route R`, and the row it writes is what this
 * checks). Nothing here calls a model; it only reads verdicts.
 */

import { createLogger } from '../../shared/logger.js';
import { loadGoldenSet, readCachedVerdict } from './ladder.js';

const log = createLogger('eval:ladder-gate');

/** Is refuse-to-route enforcement on? (SUDO_EVAL_LADDER_ENFORCE=1) */
export function ladderEnforceEnabled(): boolean {
  return process.env['SUDO_EVAL_LADDER_ENFORCE'] === '1';
}

export interface GateVerdict {
  route: string;
  rung: number;
  /** No cached verdict at the current golden-set version. */
  missing: boolean;
  admitted: boolean;
  /** True when the route may serve: admitted, or not enforcing. */
  allowed: boolean;
  reason: string;
}

/**
 * Check one route against a rung's cached verdict.
 *
 * Fail-OPEN when not enforcing (WARN only) and fail-CLOSED when enforcing —
 * including when the verdict is MISSING. An ungraded route is not a passing
 * route; under enforcement "we never checked" must not be indistinguishable
 * from "we checked and it passed".
 */
export function checkRouteAdmission(route: string, rung = 1, dbPath?: string): GateVerdict {
  let version: string;
  try {
    version = loadGoldenSet(rung).version;
  } catch (err) {
    // No golden set = nothing to attest against. Never block on our own gap.
    const reason = `no golden set for rung ${rung} (${String(err).slice(0, 80)}) — gate inert`;
    log.warn({ route, rung }, reason);
    return { route, rung, missing: true, admitted: false, allowed: true, reason };
  }

  const cached = readCachedVerdict(route, rung, version, dbPath);
  if (cached === null) {
    const reason =
      `route '${route}' has no cached rung-${rung} verdict at golden-set v${version} — ` +
      `run: pnpm eval:ladder ${rung} --route ${route} --repeats <n>`;
    return {
      route, rung, missing: true, admitted: false,
      allowed: !ladderEnforceEnabled(), reason,
    };
  }
  if (!cached.admitted) {
    const reason =
      `route '${route}' FAILED rung ${rung} (passRate ${(cached.passRate * 100).toFixed(1)}%, ` +
      `n=${cached.n})${cached.reason !== undefined ? ` — ${cached.reason}` : ''}`;
    return { route, rung, missing: false, admitted: false, allowed: !ladderEnforceEnabled(), reason };
  }
  return {
    route, rung, missing: false, admitted: true, allowed: true,
    reason: `route '${route}' admitted at rung ${rung} (${(cached.passRate * 100).toFixed(1)}%, n=${cached.n})`,
  };
}

/**
 * Validate every brain-chain entry at config load. Returns the non-admitted
 * verdicts and logs them: WARN by default, ERROR when enforcing. NEVER throws
 * and never crashes config load — per ADR-0002 this is a WARN-shaped gate.
 */
export function validateBrainChainAdmission(routes: string[], dbPath?: string): GateVerdict[] {
  const problems: GateVerdict[] = [];
  for (const route of routes) {
    let v: GateVerdict;
    try {
      v = checkRouteAdmission(route, 1, dbPath);
    } catch (err) {
      log.warn({ route, err: String(err) }, 'ladder gate: check failed — treating as inert');
      continue;
    }
    if (v.admitted) continue;
    problems.push(v);
    if (ladderEnforceEnabled()) log.error({ route }, `ladder gate (ENFORCING): ${v.reason}`);
    else log.warn({ route }, `ladder gate (advisory): ${v.reason}`);
  }
  return problems;
}
