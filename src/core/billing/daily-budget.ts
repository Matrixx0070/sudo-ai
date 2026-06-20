/**
 * Daily API-spend budget (USD) consulted by the cost self-report surfaces —
 * system.self-diagnostic (warn at >80%, fail at >100%) and intelligence.daily-brief
 * (the "API costs high" action item at >80%). Kept here, beside the cost-tracker
 * that owns api_call_log, so both surfaces share one source of truth.
 *
 * Read at call time (not module load) so an operator override via the
 * SUDO_DAILY_BUDGET_USD env takes effect without a restart. An unset or
 * non-numeric value falls back to the historical default, so the threshold
 * behaviour is preserved unless the budget is deliberately changed.
 *
 * Disable sentinel: a value of 0, a negative number, or one of
 * off/none/unlimited/inf/infinity (case-insensitive) returns Infinity, which
 * makes the cost health surfaces always-pass / never-nag and silences the
 * daemon quota-warning detector (see dailyBudgetDisabled). Operators who want a
 * guardrail set a positive dollar figure instead.
 */
export const DEFAULT_DAILY_BUDGET_USD = 5.0;

const DISABLE_TOKENS = new Set(['off', 'none', 'unlimited', 'inf', 'infinity']);

export function dailyBudgetUsd(): number {
  const raw = process.env['SUDO_DAILY_BUDGET_USD'];
  if (raw === undefined) return DEFAULT_DAILY_BUDGET_USD;
  const trimmed = raw.trim();
  if (DISABLE_TOKENS.has(trimmed.toLowerCase())) return Infinity;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return DEFAULT_DAILY_BUDGET_USD;
  // 0 or negative ⇒ budget disabled (unlimited). Previously these fell back to
  // the default; an explicit non-positive figure now reads as "no cap".
  if (parsed <= 0) return Infinity;
  return parsed;
}

/** True when the daily-budget cost surfaces are disabled (unlimited). */
export function dailyBudgetDisabled(): boolean {
  return !Number.isFinite(dailyBudgetUsd());
}
