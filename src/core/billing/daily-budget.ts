/**
 * Daily API-spend budget (USD) consulted by the cost self-report surfaces —
 * system.self-diagnostic (warn at >80%, fail at >100%) and intelligence.daily-brief
 * (the "API costs high" action item at >80%). Kept here, beside the cost-tracker
 * that owns api_call_log, so both surfaces share one source of truth.
 *
 * Read at call time (not module load) so an operator override via the
 * SUDO_DAILY_BUDGET_USD env takes effect without a restart. An unset,
 * non-numeric, zero, or negative value falls back to the historical default, so
 * the threshold behaviour is preserved unless the budget is deliberately raised.
 * There is intentionally no "disable" sentinel: a health check with no budget is
 * not a useful health check.
 */
export const DEFAULT_DAILY_BUDGET_USD = 5.0;

export function dailyBudgetUsd(): number {
  const raw = process.env['SUDO_DAILY_BUDGET_USD'];
  if (raw === undefined) return DEFAULT_DAILY_BUDGET_USD;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_BUDGET_USD;
}
