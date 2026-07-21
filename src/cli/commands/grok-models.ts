/**
 * @file grok-models.ts
 * @description `sudo-ai grok models` — the seat's model catalog + tier
 * defaults, and `--limits <model>` for remaining/total query windows. FREE on
 * the $30 subscription (cookie lane, statsig-free), never the metered dev API.
 * All provider URLs live in the llm module + python bridge, never here.
 */

export interface GrokModelsCliOptions {
  limits?: string;
}

/** Run `sudo-ai grok models`. Returns a process exit code. */
export async function runGrokModels(opts: GrokModelsCliOptions): Promise<number> {
  if (opts.limits) {
    const { getGrokRateLimits } = await import('../../llm/grok-models.js');
    try {
      const r = await getGrokRateLimits(opts.limits);
      const windowH = r.windowSizeSeconds ? `${Math.round(r.windowSizeSeconds / 3600)}h` : '?';
      console.log(`Rate limits for ${r.modelName} (${r.requestKind}):`);
      console.log(`  ${r.remainingQueries}/${r.totalQueries} queries remaining in a ${windowH} window`);
      return 0;
    } catch (err) {
      console.error(`Rate-limit lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  const { getGrokModelCatalog } = await import('../../llm/grok-models.js');
  try {
    const c = await getGrokModelCatalog();
    console.log(`Grok seat model catalog (${c.models.length} available):`);
    for (const m of c.models) {
      const name = m.name?.trim() ? ` — ${m.name.trim()}` : '';
      const tags = m.tags?.length ? ` [${m.tags.join(', ')}]` : '';
      console.log(`  ${m.modelId}${name} (${m.modelMode})${tags}`);
    }
    if (c.unavailableModels.length) {
      console.log(`Unavailable (${c.unavailableModels.length}):`);
      for (const m of c.unavailableModels) console.log(`  ${m.modelId}`);
    }
    const d = c.defaults;
    console.log('Tier defaults:');
    console.log(`  free:  ${d.free ?? '?'} (${d.freeMode ?? '?'})`);
    console.log(`  pro:   ${d.pro ?? '?'} (${d.proMode ?? '?'})`);
    console.log(`  heavy: ${d.heavy ?? '?'} (${d.heavyMode ?? '?'})`);
    console.log(`  anon:  ${d.anon ?? '?'} (${d.anonMode ?? '?'})`);
    return 0;
  } catch (err) {
    console.error(`Model catalog failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
