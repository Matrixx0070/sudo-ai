/**
 * @file llm/model-catalog.ts
 * @description One row per model. One answer per question.
 *
 * ADR 0010 / D2. Model facts lived in SIX places with different fallbacks —
 * `limits.ts` MODEL_LIMITS + PRICE_TABLE + ALIAS_LIMITS + SEAT_PROVIDERS,
 * `costs.ts` COST_RATES, and hardcoded assumptions in savings-routes — so the
 * same model could be priced twice, differently, and a model missing from one
 * table fell through to a DIFFERENT default in each ($3/$15 here, $5/$20
 * there, 128K context somewhere else). Every miss was silent.
 *
 * Measured drift this consolidates (all verified before writing this file):
 *   - `ollama/*` had no COST_RATES row at all → $5/$20 per M in that path,
 *     the exact mispricing behind the documented ~$473 phantom-spend outage.
 *   - `sudo/judge` routes to `claude-haiku-4-5-20251001` (dated); PRICE_TABLE
 *     keyed the dated id, COST_RATES keyed the BARE one → the judge was
 *     notionally billed 5x input / 4x output.
 *   - `claude-opus-4-5` ($15/$75 in one table, absent from the other → $3/$15),
 *     `openai/o3`, the gemini rows and the grok-4.20 family each existed in
 *     exactly one table.
 *
 * THE KEY DESIGN POINT — and where we deliberately differ from OpenClaw's
 * catalog (which has no seat concept at all):
 *
 *   **Billing class is a property of the LANE, not of the model.**
 *
 * `anthropic/claude-opus-5` over an API key is metered; the SAME model over
 * `claude-oauth/` rides a flat subscription seat and costs $0 in real money.
 * So the catalog stores ONE row per underlying model (price, limits,
 * capabilities), and lane classification is an orthogonal axis on top. That is
 * what lets both of these be true at once without contradiction:
 *
 *   meteredCostUsd()  — what budgets may spend against. $0 on a seat lane.
 *   notionalCostUsd() — list-price equivalent, for reporting only.
 *
 * Conflating those parked a $0 mission at "$8.80 of $5.00" (#1076 → #1079),
 * and pricing seat calls as dollars caused two outages (limits.ts:288).
 */

/** Where a row came from. Lower number wins on conflict (ADR 0010). */
export const CATALOG_AUTHORITY = {
  config: 0,   // explicit operator config — always wins
  builtin: 1,  // the tables below
  runtime: 2,  // provider /v1/models discovery
} as const;
export type CatalogSource = keyof typeof CATALOG_AUTHORITY;

/** How a lane is billed. Orthogonal to the model row. */
export type BillingClass = 'metered' | 'seat';

/** Per-million-token rates, plus the cache multipliers that were hardcoded. */
export interface CatalogPrice {
  inUsdPerM: number;
  outUsdPerM: number;
  /** Cache-read multiplier vs input rate (Anthropic ~0.1). */
  cacheReadMult?: number;
  /** Cache-write multiplier vs input rate (Anthropic ~1.25). */
  cacheWriteMult?: number;
  /**
   * Volume/context tiers, highest `fromTokens` first at lookup time. We had no
   * concept of these, so any tiered model (Gemini Pro, Anthropic >200K) was
   * silently flat-rated. Field + lookup land together so the schema is not
   * migrated twice.
   */
  tiers?: Array<{ fromTokens: number; inUsdPerM: number; outUsdPerM: number }>;
}

/** One model. Every fact that used to live in a separate table. */
export interface CatalogRow {
  /** Canonical `provider/model` id (the mergeKey). */
  id: string;
  source: CatalogSource;
  contextWindow: number;
  maxOutput: number;
  price: CatalogPrice;
  /** Burns output budget on reasoning tokens (drives the min-output floor). */
  reasoning?: boolean;
  /**
   * Succession metadata. Inert for now BY DESIGN: the F64 succession gate
   * currently runs off a first-token heuristic, and changing when a safety
   * gate fires deserves its own slice, not a ride-along in a data migration.
   */
  status?: 'active' | 'deprecated' | 'retired';
  replaces?: string[];
  replacedBy?: string;
  /**
   * Wire shape + endpoint. Inert until D3: dispatch is decided per PROVIDER
   * today (`Family` in transport.ts), which is why xAI's two surfaces need two
   * provider prefixes. D3 makes this load-bearing.
   */
  api?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Lane classification — orthogonal to the rows
// ---------------------------------------------------------------------------

/**
 * Lanes covered by a flat subscription seat. NEVER price these as dollars:
 * limits.ts:288 records 418 seat calls booked as "$51" blowing a $50 cap, and
 * ollama `:cloud` mispricing booking ~$473 of phantom spend and taking the
 * product down. Seat VOLUME is bounded by policy.ts seatCallLimit instead.
 */
const SEAT_LANE_PREFIXES = ['claude-oauth/', 'claude-oauth:', 'ollama/', 'ollama:'] as const;

/** True when this lane rides a seat (so real spend is $0). */
export function isSeatLane(idOrRoute: string): boolean {
  return SEAT_LANE_PREFIXES.some((p) => idOrRoute.startsWith(p));
}

/** Billing class for a lane. */
export function billingClassOf(idOrRoute: string): BillingClass {
  return isSeatLane(idOrRoute) ? 'seat' : 'metered';
}

/**
 * Map a lane id to the underlying model row key. `claude-oauth/<m>` hits the
 * same upstream model as `anthropic/<m>`, so they share ONE row — the lane
 * difference is billing, handled above. Also strips a dated suffix as a
 * fallback so `claude-haiku-4-5-20251001` finds `claude-haiku-4-5` instead of
 * falling through to a default (the judge-billed-5x bug).
 */
export function canonicalModelId(idOrAlias: string): string {
  let id = idOrAlias.trim();
  if (id.startsWith('claude-oauth/')) id = `anthropic/${id.slice('claude-oauth/'.length)}`;
  return id;
}

/** Dated-suffix fallback: `<model>-YYYYMMDD` → `<model>`. */
function undated(id: string): string | null {
  const m = /^(.*)-\d{8}$/.exec(id);
  return m ? m[1]! : null;
}

// ---------------------------------------------------------------------------
// Built-in rows — the union of what used to be three tables
// ---------------------------------------------------------------------------

const K = 1_000;
const M = 1_000_000;
/** Anthropic's published cache ratios; applied per-row rather than globally. */
const ANTHROPIC_CACHE = { cacheReadMult: 0.1, cacheWriteMult: 1.25 };

function row(
  id: string,
  contextWindow: number,
  maxOutput: number,
  inUsdPerM: number,
  outUsdPerM: number,
  extra: Partial<CatalogRow> = {},
): CatalogRow {
  return { id, source: 'builtin', contextWindow, maxOutput, price: { inUsdPerM, outUsdPerM }, ...extra };
}

const BUILTIN_ROWS: readonly CatalogRow[] = [
  // --- xAI: fast tier (2M context) ---
  row('xai/grok-4-fast', 2 * M, 32_768, 0.2, 0.5),
  row('xai/grok-4-fast-reasoning', 2 * M, 32_768, 0.2, 0.5, { reasoning: true }),
  row('xai/grok-4-fast-non-reasoning', 2 * M, 32_768, 0.2, 0.5),
  row('xai/grok-4-1-fast-reasoning', 2 * M, 32_768, 0.2, 0.5, { reasoning: true }),
  row('xai/grok-4-1-fast-non-reasoning', 2 * M, 32_768, 0.2, 0.5),
  // --- xAI: premium / legacy ---
  row('xai/grok-4-0709', 256 * K, 32_768, 2.0, 6.0),
  row('xai/grok-code-fast-1', 256 * K, 32_768, 0.2, 0.5),
  row('xai/grok-3', 131_072, 16_384, 0.3, 0.5),
  row('xai/grok-3-mini', 131_072, 16_384, 0.3, 0.5),
  row('xai/grok-3-fast', 131_072, 16_384, 5.0, 25.0),
  row('xai/grok-4.5', 256 * K, 32_768, 3.0, 15.0),
  // COST_RATES-only rows — previously absent from PRICE_TABLE (→ $3/$15) AND
  // from MODEL_LIMITS (→ a 128K default).
  row('xai/grok-4.20-0309-reasoning', 256 * K, 32_768, 2.0, 6.0, { reasoning: true }),
  row('xai/grok-4.20-0309-non-reasoning', 256 * K, 32_768, 2.0, 6.0),
  row('xai/grok-4.20-multi-agent-0309', 256 * K, 32_768, 2.0, 6.0),
  // --- xai-oauth proxy: METERED despite the oauth prefix (proven live
  // 2026-07-31; $161.27 invoiced over 30d when it was priced 0). ---
  row('xai-oauth/grok-4.5', 256 * K, 32_768, 3.0, 15.0),
  row('xai-oauth/grok-build', 512 * K, 32_768, 3.0, 15.0),
  row('xai-oauth/grok-composer-2.5-fast', 200 * K, 32_768, 3.0, 15.0),

  // --- Anthropic (also the row for the claude-oauth SEAT lane) ---
  row('anthropic/claude-opus-5', 1 * M, 128_000, 5.0, 25.0, { price: { inUsdPerM: 5.0, outUsdPerM: 25.0, ...ANTHROPIC_CACHE } }),
  row('anthropic/claude-opus-4-8', 200 * K, 32_000, 5.0, 25.0, { price: { inUsdPerM: 5.0, outUsdPerM: 25.0, ...ANTHROPIC_CACHE } }),
  row('anthropic/claude-opus-4-7', 200 * K, 32_000, 5.0, 25.0, { price: { inUsdPerM: 5.0, outUsdPerM: 25.0, ...ANTHROPIC_CACHE } }),
  row('anthropic/claude-opus-4-6', 200 * K, 32_000, 5.0, 25.0, { price: { inUsdPerM: 5.0, outUsdPerM: 25.0, ...ANTHROPIC_CACHE } }),
  // $15/$75 came from COST_RATES; PRICE_TABLE lacked the row entirely, so the
  // budget path had been costing Opus 4.5 at the $3/$15 default — 5x low.
  row('anthropic/claude-opus-4-5', 200 * K, 32_000, 15.0, 75.0, { price: { inUsdPerM: 15.0, outUsdPerM: 75.0, ...ANTHROPIC_CACHE } }),
  row('anthropic/claude-sonnet-5', 200 * K, 32_000, 3.0, 15.0, { price: { inUsdPerM: 3.0, outUsdPerM: 15.0, ...ANTHROPIC_CACHE } }),
  row('anthropic/claude-sonnet-4-6', 200 * K, 32_000, 3.0, 15.0, { price: { inUsdPerM: 3.0, outUsdPerM: 15.0, ...ANTHROPIC_CACHE } }),
  row('anthropic/claude-sonnet-4-5', 200 * K, 32_000, 3.0, 15.0, { price: { inUsdPerM: 3.0, outUsdPerM: 15.0, ...ANTHROPIC_CACHE } }),
  // The judge model. Both spellings resolve here — the dated/bare split is
  // exactly what billed it 5x on one path.
  row('anthropic/claude-haiku-4-5', 200 * K, 32_000, 1.0, 5.0, { price: { inUsdPerM: 1.0, outUsdPerM: 5.0, ...ANTHROPIC_CACHE } }),
  row('anthropic/claude-haiku-3-5', 200 * K, 8_192, 0.8, 4.0, { price: { inUsdPerM: 0.8, outUsdPerM: 4.0, ...ANTHROPIC_CACHE } }),

  // --- OpenAI ---
  row('openai/gpt-4o', 128 * K, 16_384, 2.5, 10.0),
  row('openai/gpt-4o-mini', 128 * K, 16_384, 0.15, 0.6),
  row('openai/o3', 200 * K, 100_000, 10.0, 40.0, { reasoning: true }),
  row('openai/text-embedding-3-small', 8_191, 0, 0.02, 0.0),

  // --- Google (COST_RATES-only before; no limits row, so a 1M-context model
  // was capped at the 128K default). ---
  row('google/gemini-2.0-flash', 1 * M, 8_192, 0.1, 0.4),
  row('google/gemini-2.5-flash', 1 * M, 65_536, 0.3, 2.5),
  row('google/gemini-1.5-pro', 2 * M, 8_192, 3.5, 10.5, {
    // Tiered above 128K — the case we previously could not express at all.
    price: {
      inUsdPerM: 3.5, outUsdPerM: 10.5,
      tiers: [{ fromTokens: 128 * K, inUsdPerM: 7.0, outUsdPerM: 21.0 }],
    },
  }),

  // --- Seat lanes: rows exist for LIMITS and notional reporting. Real spend
  // is $0 via billingClassOf(), never via a $0 price. ---
  row('ollama/llama3.2', 128 * K, 8_192, 0, 0),
  row('ollama/nomic-embed-text', 8_192, 0, 0, 0),
  row('ollama/glm-5.2:cloud', 200 * K, 32_768, 0, 0),
  row('ollama/kimi-k2.7-code:cloud', 256 * K, 32_768, 0, 0),
];

/** Conservative fallbacks — ONE default now, not three that disagreed. */
export const CATALOG_DEFAULTS = {
  contextWindow: 128 * K,
  maxOutput: 8_192,
  price: { inUsdPerM: 3.0, outUsdPerM: 15.0 } as CatalogPrice,
} as const;

// ---------------------------------------------------------------------------
// Merge by authority
// ---------------------------------------------------------------------------

/** A rejected duplicate — surfaced, never silently resolved. */
export interface CatalogConflict {
  id: string;
  sources: CatalogSource[];
  reason: 'same-authority-duplicate';
}

const conflicts: CatalogConflict[] = [];

function buildCatalog(rows: readonly CatalogRow[]): Map<string, CatalogRow> {
  const byId = new Map<string, CatalogRow>();
  for (const r of rows) {
    const existing = byId.get(r.id);
    if (!existing) { byId.set(r.id, r); continue; }
    const a = CATALOG_AUTHORITY[existing.source];
    const b = CATALOG_AUTHORITY[r.source];
    if (b < a) { byId.set(r.id, r); continue; }
    if (b === a) {
      // Same tier: neither silently wins. Keep the first, record the clash.
      conflicts.push({ id: r.id, sources: [existing.source, r.source], reason: 'same-authority-duplicate' });
    }
  }
  return byId;
}

let catalog = buildCatalog(BUILTIN_ROWS);

/** Duplicate declarations detected at build time. Empty in a healthy catalog. */
export function catalogConflicts(): readonly CatalogConflict[] {
  return conflicts;
}

/** Register higher-authority rows (operator config, runtime discovery). */
export function registerCatalogRows(rows: readonly CatalogRow[]): void {
  catalog = buildCatalog([...BUILTIN_ROWS, ...rows]);
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/** The row for a lane/alias, or null. Resolves seat lanes and dated ids. */
export function lookupModel(idOrAlias: string): CatalogRow | null {
  const canonical = canonicalModelId(idOrAlias);
  const direct = catalog.get(canonical);
  if (direct) return direct;
  const bare = undated(canonical);
  if (bare) {
    const viaBare = catalog.get(bare);
    if (viaBare) return viaBare;
  }
  return null;
}

/** Context window + max output, with the single shared default. */
export function contextLimitsFor(idOrAlias: string): { context_window: number; max_output: number } {
  const r = lookupModel(idOrAlias);
  return {
    context_window: r?.contextWindow ?? CATALOG_DEFAULTS.contextWindow,
    max_output: r?.maxOutput ?? CATALOG_DEFAULTS.maxOutput,
  };
}

/** Effective rate for a call of `inputTokens`, honouring tiers. */
export function rateFor(idOrAlias: string, inputTokens = 0): CatalogPrice {
  const price = lookupModel(idOrAlias)?.price ?? CATALOG_DEFAULTS.price;
  if (!price.tiers || price.tiers.length === 0) return price;
  const tier = [...price.tiers].sort((a, b) => b.fromTokens - a.fromTokens)
    .find((t) => inputTokens >= t.fromTokens);
  return tier ? { ...price, inUsdPerM: tier.inUsdPerM, outUsdPerM: tier.outUsdPerM } : price;
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/** Cost from a rate + token counts, splitting cached input out at its own rate. */
function costFrom(rate: CatalogPrice, t: TokenCounts): number {
  const cacheRead = Math.max(0, t.cacheReadTokens ?? 0);
  const cacheWrite = Math.max(0, t.cacheCreationTokens ?? 0);
  // `inputTokens` is the SDK total and INCLUDES cached tokens on Anthropic.
  const fresh = Math.max(0, t.inputTokens - cacheRead - cacheWrite);
  const readMult = rate.cacheReadMult ?? 1;
  const writeMult = rate.cacheWriteMult ?? 1;
  return (
    (fresh / M) * rate.inUsdPerM +
    (cacheRead / M) * rate.inUsdPerM * readMult +
    (cacheWrite / M) * rate.inUsdPerM * writeMult +
    (Math.max(0, t.outputTokens) / M) * rate.outUsdPerM
  );
}

/**
 * REAL money for this call — what a budget may spend against.
 * $0 on a seat lane, always, by classification rather than by a $0 price.
 */
export function meteredCostUsd(idOrLane: string, t: TokenCounts): number {
  if (isSeatLane(idOrLane)) return 0;
  return costFrom(rateFor(idOrLane, t.inputTokens), t);
}

/**
 * List-price equivalent — REPORTING ONLY. Never gate a budget on this: a seat
 * lane returns a real number here and $0 from meteredCostUsd, and confusing
 * the two parked a $0 mission at "$8.80 of $5.00".
 */
export function notionalCostUsd(idOrLane: string, t: TokenCounts): number {
  return costFrom(rateFor(idOrLane, t.inputTokens), t);
}
