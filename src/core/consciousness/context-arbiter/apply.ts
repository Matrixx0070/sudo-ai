/**
 * @file apply.ts
 * @description CW4 — one-call arbiter entry for the intelligence brief:
 * flag check -> collect bids from real state -> budget = min(env, CW2
 * envelope) -> arbitrate (scanner applied) -> persist winners+losers ->
 * return the composed block. Fail-open: any error returns inactive.
 */

import { createLogger } from '../../shared/logger.js';
import { arbitrate, resolveArbiterBudget } from './arbiter.js';
import { collectBids, type BriefContextLike } from './sources.js';
import { recordDecision } from './store.js';
import type { InjectionScanner } from './types.js';

const log = createLogger('consciousness:context-arbiter');

/**
 * Run arbitration for one turn when SUDO_CAS_ARBITER=1.
 * Returns `{ active: false }` when the flag is OFF or arbitration failed —
 * callers keep the legacy composition in that case.
 */
export function runArbiterForBrief(
  ctx: BriefContextLike,
  contextBudgetTokens: number | undefined,
  scanner: InjectionScanner | undefined,
): { active: boolean; block: string } {
  if (process.env['SUDO_CAS_ARBITER'] !== '1') return { active: false, block: '' };
  try {
    const bids = collectBids(ctx);
    const budget = Math.min(
      resolveArbiterBudget(),
      contextBudgetTokens !== undefined && contextBudgetTokens > 0
        ? contextBudgetTokens
        : Number.POSITIVE_INFINITY,
    );
    const decision = arbitrate(bids, budget, scanner);
    recordDecision(decision);
    log.info(
      {
        budget: decision.budgetTokens,
        spent: decision.spentTokens,
        winners: decision.winners.map((b) => ({ s: b.source, v: b.value, c: b.confidence, t: b.tokenCost })),
        losers: decision.losers.map((b) => ({ s: b.source, why: b.rejectReason, v: b.value, c: b.confidence, t: b.tokenCost })),
      },
      'CW4: arbitration decision',
    );
    return { active: true, block: decision.block };
  } catch (err) {
    log.warn({ err: String(err) }, 'CW4: arbitration failed — falling back to legacy composition (fail-open)');
    return { active: false, block: '' };
  }
}
