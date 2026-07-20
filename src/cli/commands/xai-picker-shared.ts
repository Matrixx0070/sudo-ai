/**
 * @file xai-picker-shared.ts
 * @description Shared table/formatting + fetch-and-cache helpers for the two
 * Grok picker CLIs (`xai-oauth` and `xai apikey`). Keeps the cost distinction
 * VISIBLE (subscription-covered vs pay-per-token) per handoff §1b.
 */

import type { XaiAuthMethod, XaiModelEntry } from '../../llm/xai-models.js';

/**
 * Non-blocking advisory for models that fan out internally and bill far more
 * than a single call — e.g. grok-4.20-multi-agent (~50x token burn per the RE
 * report). Returned as a note to print on set-default; never blocks the choice.
 */
export function setDefaultAdvisory(id: string): string | null {
  if (/multi-agent/i.test(id)) {
    return 'Note: this is a multi-agent model — it fans out internally and can burn ~50x the tokens of a single-call model. Fine to pick deliberately; avoid it as an unattended default.';
  }
  return null;
}

/** Human cost label for a model's billing class. */
export function billingLabel(billing: XaiModelEntry['billing']): string {
  return billing === 'subscription' ? 'subscription-covered' : 'pay-per-token';
}

interface ManagerLike {
  listModels(): XaiModelEntry[];
  setModels(models: XaiModelEntry[]): void;
  getDefaultModel(): string | null;
  setDefaultModel(id: string): boolean;
}

/**
 * Return the model list for display: the persisted cache unless `refresh` is
 * set (or the cache is empty), otherwise a live fetch that is then cached.
 * `live` marks whether a network fetch happened. Throws XaiNotConnectedError
 * (via the discovery credential seam) when the method has no credential.
 */
export async function getModelsForDisplay(
  method: XaiAuthMethod,
  mgr: ManagerLike,
  refresh: boolean,
): Promise<{ models: XaiModelEntry[]; live: boolean }> {
  if (!refresh) {
    const cached = mgr.listModels();
    if (cached.length > 0) return { models: cached, live: false };
  }
  const { getXaiModelDiscovery } = await import('../../llm/xai-models.js');
  const models = await getXaiModelDiscovery().refresh(method);
  mgr.setModels(models);
  return { models, live: true };
}

/** Pretty-print the model list with the current default marked (`*`). */
export function printModelsTable(models: XaiModelEntry[], defaultId: string | null, brandPrefix: string): void {
  console.log('');
  console.log(`  Brain model string format: ${brandPrefix}/<id>`);
  console.log(`  Default model: ${defaultId ?? '(none)'}`);
  console.log('');
  const idW = Math.max(...models.map((m) => m.id.length), 'MODEL ID'.length);
  const nameW = Math.max(...models.map((m) => m.name.length), 'NAME'.length);
  const ctxW = Math.max(...models.map((m) => ctxStr(m.contextWindow).length), 'CONTEXT'.length);
  console.log(`  ${''.padEnd(2)} ${'MODEL ID'.padEnd(idW)}  ${'NAME'.padEnd(nameW)}  ${'CONTEXT'.padEnd(ctxW)}  COST`);
  console.log(`  ${''.padEnd(2)} ${'-'.repeat(idW)}  ${'-'.repeat(nameW)}  ${'-'.repeat(ctxW)}  ----`);
  for (const m of models) {
    const marker = m.id === defaultId ? '* ' : '  ';
    console.log(
      `  ${marker}${m.id.padEnd(idW)}  ${m.name.padEnd(nameW)}  ${ctxStr(m.contextWindow).padEnd(ctxW)}  ${billingLabel(m.billing)}`,
    );
  }
  console.log('');
}

function ctxStr(ctx: number | null): string {
  if (ctx === null) return '?';
  if (ctx >= 1000) return `${Math.round(ctx / 1000)}k`;
  return String(ctx);
}
