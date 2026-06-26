/**
 * @file thinking-inject.ts
 * @description Pure helper for the claude-oauth fetch interceptor's extended-
 * thinking injection (providers.ts). Extracted so the budget/max_tokens math is
 * unit-testable.
 *
 * The Anthropic Max plan unlocks high thinking budgets on opus-4-8+. We inject
 * `thinking` on those models. The constraint that previously bit us: the total
 * (budget_tokens + visible output) must stay within the model's max_tokens
 * ceiling, OR the SDK/API caps the total and warns
 * ("(maxOutputTokens + thinkingBudget) > N max — capped") — which truncated the
 * reply and risked a 400 "max_tokens must be greater than thinking.budget_tokens".
 * So we clamp budget to leave OUTPUT_HEADROOM under the ceiling.
 */

/** Tokens reserved for the visible answer on top of the thinking budget. */
const OUTPUT_HEADROOM = 4096;
/** Opus-4-8 standard output ceiling (no 128k-output beta). Override via env. */
const DEFAULT_MODEL_MAX = 32000;
/** Default thinking budget (matches the max effort preset) before clamping. */
const DEFAULT_BUDGET = 32768;

/** opus-4-8 and later opus-4-x (the models that unlock high thinking budgets). */
const OPUS_THINKING_RE = /^claude-opus-4-(8|9|[1-9][0-9]+)/;

export interface ThinkingEnv {
  /** SUDO_THINKING_DISABLE — "1" disables injection entirely. */
  disable?: string | undefined;
  /** SUDO_THINKING_BUDGET — desired budget tokens (clamped 1024..65536). */
  budget?: string | undefined;
  /** SUDO_THINKING_MODEL_MAX — override the model's max_tokens ceiling. */
  modelMax?: string | undefined;
}

export interface ThinkingParams {
  budgetTokens: number;
  maxTokens: number;
}

/**
 * Resolve the thinking params for a request, or null when thinking should NOT
 * be injected (non-opus model or disabled). Guarantees the returned values
 * satisfy `budgetTokens < maxTokens <= modelMax`.
 */
export function resolveThinkingBudget(
  model: string,
  currentMaxTokens: number,
  env: ThinkingEnv = {},
): ThinkingParams | null {
  if (typeof model !== 'string' || !OPUS_THINKING_RE.test(model)) return null;
  if (env.disable === '1') return null;

  const envMax = parseInt(env.modelMax ?? '', 10);
  const modelMax = Number.isFinite(envMax) ? Math.max(8192, envMax) : DEFAULT_MODEL_MAX;

  const envBudget = parseInt(env.budget ?? '', 10);
  let budgetTokens = Number.isFinite(envBudget)
    ? Math.min(65536, Math.max(1024, envBudget))
    : DEFAULT_BUDGET;

  // Clamp budget so budget + output headroom fits under the model ceiling.
  const budgetCeiling = Math.max(1024, modelMax - OUTPUT_HEADROOM);
  if (budgetTokens > budgetCeiling) budgetTokens = budgetCeiling;

  // max_tokens must exceed budget_tokens (Anthropic rule) and not exceed the
  // ceiling. Respect a caller's larger max_tokens when it already satisfies both.
  const desired = Math.min(budgetTokens + OUTPUT_HEADROOM, modelMax);
  const maxTokens =
    currentMaxTokens > budgetTokens && currentMaxTokens <= modelMax ? currentMaxTokens : desired;

  return { budgetTokens, maxTokens };
}
