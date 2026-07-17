/**
 * @file notebooklm/config.ts
 * @description Config + gates for the NotebookLM annex (F39–F80).
 *
 * Master switch SUDO_NOTEBOOKLM=1 (default OFF), and it REQUIRES SUDO_GDRIVE=1 —
 * the annex composes entirely on the Drive substrate (export lane, quarantine,
 * memory API). N0–N4 import ZERO programmatic NotebookLM access (invariant 3);
 * that only appears behind the N5 enterprise gate.
 */

export function isNotebookLmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SUDO_NOTEBOOKLM'] === '1' && env['SUDO_GDRIVE'] === '1';
}

/** Per-job token budgets (invariant 10 / execution-protocol §7). */
export interface NlmBudgets {
  perRunTokens: number;
  perDayTokens: number;
}

function intEnv(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number): number {
  const raw = Number(env[key]);
  return Number.isFinite(raw) && raw >= min ? raw : fallback;
}

export function loadNlmBudgets(env: NodeJS.ProcessEnv = process.env): NlmBudgets {
  return {
    perRunTokens: intEnv(env, 'SUDO_NOTEBOOKLM_PERRUN_TOKENS', 50_000, 1_000),
    perDayTokens: intEnv(env, 'SUDO_NOTEBOOKLM_PERDAY_TOKENS', 500_000, 1_000),
  };
}

/** Default rolling-Doc size budget before rolling to `-part2` (chars). */
export function rollingSizeBudget(env: NodeJS.ProcessEnv = process.env): number {
  return intEnv(env, 'SUDO_NOTEBOOKLM_ROLL_CHARS', 250_000, 10_000);
}
