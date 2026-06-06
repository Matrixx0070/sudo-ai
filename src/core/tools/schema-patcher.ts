/**
 * SchemaPatcher — dynamic schema patcher for SUDO-AI v4.
 *
 * Inspired by Hermes Agent's dynamic schema patching: before sending the tool
 * schema to the LLM, filter and trim based on model capability, tool profile,
 * session context, and cost/latency budget.  Every tool removed from the
 * schema is a few dozen tokens saved — and those savings compound across every
 * message in the conversation.
 *
 * Filter pipeline (applied in order):
 *   1. Remove tools explicitly disabled in the session context.
 *   2. Remove tools whose category is not in `requiredCategories`.
 *   3. Remove tools whose cost exceeds the `costBudget` ceiling.
 *   4. Remove tools not included in the active `profile`.
 *   5. If the resulting set exceeds the model's tool limit, drop the
 *      lowest-priority tools until it fits.
 */

import { ToolRegistry } from './registry.js';
import type { ToolProfile } from './base-tool.js';
import type { ToolCategory } from './types.js';
import { createLogger } from '../shared/logger.js';
import { estimateTokens } from '../shared/utils.js';

const logger = createLogger('schema-patcher');

// ---------------------------------------------------------------------------
// Cost hierarchy — each tier includes the ones above it
// ---------------------------------------------------------------------------

const COST_TIERS: Record<CostBudget, number> = {
  free: 0,
  low: 1,
  medium: 2,
  high: 3,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Cost/latency budget ceiling for tool filtering. */
export type CostBudget = 'free' | 'low' | 'medium' | 'high';

/**
 * Context that drives schema patching decisions.
 * Passed by the agent loop each time schemas are assembled for an LLM call.
 */
export interface PatchContext {
  /** Model identifier, e.g. 'claude-3-5-haiku', 'gpt-4o'. */
  model: string;
  /** Hard cap on the number of tools to include. */
  maxTools: number;
  /** Active tool profile — determines the baseline tool set. */
  profile: ToolProfile;
  /** Tool names the session has explicitly disabled. */
  disabledTools: string[];
  /** Tool categories that MUST be present (others are pruned). */
  requiredCategories: ToolCategory[];
  /** Optional cost ceiling — tools whose cost exceeds this are removed. */
  costBudget?: CostBudget;
}

/**
 * Result of a schema patching pass.  Returned so the caller can log savings
 * and decide whether to warn the user about missing tools.
 */
export interface PatchResult {
  /** Number of schemas before patching. */
  originalCount: number;
  /** Number of schemas after patching. */
  patchedCount: number;
  /** Tool names that were removed. */
  removed: string[];
  /** Tool names that were kept. */
  kept: string[];
  /** Estimated token savings from the removed schemas. */
  savings: { estimatedTokens: number };
}

// ---------------------------------------------------------------------------
// Profile definitions — each tier subsumes the one below it
// ---------------------------------------------------------------------------

/**
 * Tool names included in the 'minimal' profile.
 * Basic tools sufficient for simple read/write/exec/search tasks.
 */
const PROFILE_MINIMAL: string[] = [
  'fs.read',
  'fs.write',
  'exec',
  'search',
];

/**
 * Tool names included in the 'coding' profile.
 * Extends minimal with developer-focused tools: editing, git, npm, testing,
 * linting, and debugging.
 */
const PROFILE_CODING: string[] = [
  ...PROFILE_MINIMAL,
  'fs.edit',
  'fs.multi-edit',
  'git',
  'npm',
  'test',
  'lint',
  'debug',
];

/**
 * 'full' profile — all registered tools.  Represented as null; the patcher
 * treats a null set as "no profile filter", keeping everything that passes
 * the other filter stages.
 */
const PROFILE_FULL: string[] | null = null;

/** Map from profile name to its allowed tool set (null = all). */
const PROFILES: Record<ToolProfile, string[] | null> = {
  minimal: PROFILE_MINIMAL,
  coding: PROFILE_CODING,
  full: PROFILE_FULL,
};

// ---------------------------------------------------------------------------
// Model-specific tool limits
// ---------------------------------------------------------------------------

/**
 * Some models have hard caps on the number of parallel tools they can handle.
 * If the patched set exceeds the model's limit, lowest-priority tools are
 * trimmed until it fits.
 */
const MODEL_TOOL_LIMITS: Record<string, number> = {
  'claude-3-5-haiku': 64,
  'gpt-4o': 128,
};

/** Default tool limit when the model is not in the lookup table. */
const DEFAULT_MODEL_TOOL_LIMIT = 128;

// ---------------------------------------------------------------------------
// SchemaPatcher class
// ---------------------------------------------------------------------------

/**
 * Dynamic schema patcher that filters LLM tool schemas before they are sent.
 *
 * Usage:
 * ```typescript
 * const patcher = new SchemaPatcher(registry);
 * const result  = patcher.patch(schemas, ctx);
 * // Send result.kept schemas to the LLM, log result.savings
 * ```
 */
export class SchemaPatcher {
  /** Reference to the live tool registry for metadata lookups. */
  private readonly registry: ToolRegistry;

  // Accumulated statistics for introspection / dashboards.
  private _totalPatches = 0;
  private _totalReduction = 0;     // sum of (original - patched) across calls
  private _byProfile: Record<string, number> = {};

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  // -----------------------------------------------------------------------
  // Main entry point
  // -----------------------------------------------------------------------

  /**
   * Filter and trim an array of LLM tool schemas based on the given context.
   *
   * The input `schemas` array is the full set produced by
   * `ToolRegistry.getSchemaForLLM()`.  This method returns a `PatchResult`
   * whose `kept` list names the tools that survived all filter stages.
   *
   * @param schemas - Full schema array from the registry.
   * @param context - Patching decisions for this LLM call.
   * @returns A {@link PatchResult} describing what was kept and what was removed.
   */
  patch(schemas: object[], context: PatchContext): PatchResult {
    const originalCount = schemas.length;

    // Build a name→schema index so we can filter by name and reconstruct later.
    const byName = new Map<string, object>();
    for (const schema of schemas) {
      const fn = (schema as { function?: { name?: string } }).function;
      const name = fn?.name;
      if (name) byName.set(name, schema);
    }

    // Collect names of all tools initially available.
    let candidates = [...byName.keys()];

    // --- Stage 1: remove explicitly disabled tools ---
    const disabledSet = new Set(context.disabledTools);
    candidates = candidates.filter((n) => !disabledSet.has(n));

    // --- Stage 2: category filter (only keep required categories) ---
    if (context.requiredCategories.length > 0) {
      const catSet = new Set<ToolCategory>(context.requiredCategories);
      candidates = candidates.filter((n) => {
        const def = this.registry.get(n);
        return def ? catSet.has(def.category) : true; // unknown tools pass through
      });
    }

    // --- Stage 3: cost budget filter ---
    if (context.costBudget) {
      const ceiling = COST_TIERS[context.costBudget];
      candidates = candidates.filter((n) => {
        const def = this.registry.get(n);
        if (!def) return true;
        // Access metadata attached by the @Tool() decorator (if available).
        // ToolDefinition does not carry cost directly, but the registry may
        // expose it via a side channel.  For now we rely on the convention
        // that the registry stores cost in a lookup.  Fall back to 'free'.
        const toolCost: CostBudget = this._costForTool(n) ?? 'free';
        return COST_TIERS[toolCost] <= ceiling;
      });
    }

    // --- Stage 4: profile filter ---
    const profileSet = PROFILES[context.profile];
    if (profileSet !== null) {
      const allowed = new Set(profileSet);
      candidates = candidates.filter((n) => allowed.has(n));
    }

    // --- Stage 5: enforce model tool limit ---
    const modelLimit = this.getModelToolLimit(context.model);
    const effectiveMax = Math.min(context.maxTools, modelLimit);
    if (candidates.length > effectiveMax) {
      // Trim from the tail — tools earlier in the registry are generally
      // higher priority (they were registered first or are core tools).
      candidates = candidates.slice(0, effectiveMax);
    }

    // Build final outputs.
    const keptSet = new Set(candidates);
    const removed: string[] = [];
    for (const name of byName.keys()) {
      if (!keptSet.has(name)) removed.push(name);
    }

    // Estimate token savings: each removed schema's JSON roughly equals its
    // description + parameter definitions serialised as text.
    let savedTokens = 0;
    for (const name of removed) {
      const schema = byName.get(name)!;
      savedTokens += estimateTokens(JSON.stringify(schema));
    }

    // Update running stats.
    this._totalPatches++;
    this._totalReduction += originalCount - candidates.length;
    const profileKey = context.profile;
    this._byProfile[profileKey] = (this._byProfile[profileKey] ?? 0) + 1;

    logger.info(
      {
        model: context.model,
        profile: context.profile,
        original: originalCount,
        patched: candidates.length,
        removed: removed.length,
        savedTokens,
      },
      'Schema patched',
    );

    return {
      originalCount,
      patchedCount: candidates.length,
      removed,
      kept: candidates,
      savings: { estimatedTokens: savedTokens },
    };
  }

  // -----------------------------------------------------------------------
  // Model limits
  // -----------------------------------------------------------------------

  /**
   * Return the maximum number of tools a model can handle in a single request.
   *
   * @param model - Model identifier string.
   * @returns Integer tool limit for the model.
   */
  getModelToolLimit(model: string): number {
    // Exact match first.
    if (model in MODEL_TOOL_LIMITS) {
      return MODEL_TOOL_LIMITS[model];
    }
    // Partial match — model strings sometimes include date suffixes
    // like 'claude-3-5-haiku-20241022'.
    for (const [prefix, limit] of Object.entries(MODEL_TOOL_LIMITS)) {
      if (model.startsWith(prefix)) return limit;
    }
    return DEFAULT_MODEL_TOOL_LIMIT;
  }

  // -----------------------------------------------------------------------
  // Profile lookups
  // -----------------------------------------------------------------------

  /**
   * Return the list of tool names included in a given profile.
   *
   * @param profile - The tool profile to look up.
   * @returns Array of tool names, or null for 'full' (meaning all tools).
   */
  getToolsForProfile(profile: ToolProfile): string[] {
    const set = PROFILES[profile];
    // 'full' returns null — caller should interpret as "all tools".
    return set ?? [];
  }

  // -----------------------------------------------------------------------
  // Statistics
  // -----------------------------------------------------------------------

  /**
   * Cumulative patching statistics for dashboards or debugging.
   *
   * @returns Object with total patch count, average reduction, and
   *          breakdown by profile.
   */
  getStats(): { totalPatches: number; avgReduction: number; byProfile: Record<string, number> } {
    return {
      totalPatches: this._totalPatches,
      avgReduction:
        this._totalPatches > 0
          ? Math.round(this._totalReduction / this._totalPatches)
          : 0,
      byProfile: { ...this._byProfile },
    };
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Look up the cost estimate for a tool by name.
   *
   * The ToolDefinition itself does not carry cost metadata directly, but the
   * @Tool() decorator attaches it to the class constructor.  We use a
   * convention-based lookup: if the registry stores the original BaseTool
   * class somewhere accessible, we can read `metadata.costEstimate`.
   *
   * For now this returns undefined, which the cost filter treats as 'free'.
   * A future wave will wire this to the decorator metadata index.
   */
  private _costForTool(_name: string): CostBudget | undefined {
    // Placeholder — will be wired to @Tool() decorator metadata index.
    return undefined;
  }
}