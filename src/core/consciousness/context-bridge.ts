/**
 * @file context-bridge.ts
 * @description Bridges consciousness context into the LLM prompt for SUDO-AI v4.
 *
 * This is the key connection that makes consciousness *functional* rather than
 * decorative.  While ContextSelector picks the right modules, the bridge decides
 * *how much* of their content to inject and *where* it lands in the system prompt.
 *
 * Architecture:
 *  - Takes a ContextSelection from ContextSelector.
 *  - Adjusts detail level based on current context-window occupancy (budget-aware).
 *  - Injects structured context into the system prompt at a configurable position.
 *  - Tracks every injection for traceability and debugging.
 *
 * Budget tiers (driven by currentContextPercent):
 *  < 50%  → full detail for all primary modules         (~2000 tokens)
 *  50-70% → full detail for top 2 primary, summary rest (~1200 tokens)
 *  70-85% → summary for all primary, 1-line secondary    (~600 tokens)
 *  > 85%  → compressed 3-line summary only               (~200 tokens)
 */

import { ContextSelector, type ContextSelection } from './context-selector.js';
import { createLogger } from '../shared/logger.js';
import { estimateTokens } from '../shared/utils.js';

const log = createLogger('consciousness:context-bridge');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Record of a single bridge injection — what was inserted, how large, and
 * which modules contributed.  Stored in the bridge history for traceability.
 */
export interface BridgeInjection {
  /** The formatted context string that was (or will be) injected. */
  context: string;
  /** Estimated token count for the injected context. */
  tokenEstimate: number;
  /** Module names that contributed to the injection. */
  modules: string[];
  /** Category that drove the selection (e.g. 'coding', 'analysis'). */
  category: string;
  /** ISO-8601 timestamp of when this injection was computed. */
  injectedAt: string;
}

/**
 * Configuration knobs for the bridge.
 * Controls where context is inserted and how aggressively the budget is managed.
 */
export interface BridgeConfig {
  /** Position in the system prompt to insert context. */
  injectionPosition: 'after_system' | 'before_tools' | 'end';
  /** Maximum tokens the bridge may inject in a single call. */
  maxTokens: number;
  /** Context-window occupancy (%) at which we switch from full to mild compression. */
  contextThresholdMild: number;
  /** Context-window occupancy (%) at which we switch to aggressive compression. */
  contextThresholdAggressive: number;
}

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: BridgeConfig = {
  injectionPosition: 'after_system',
  maxTokens: 2000,
  contextThresholdMild: 50,
  contextThresholdAggressive: 85,
};

// ---------------------------------------------------------------------------
// Position markers — the bridge looks for these in the system prompt
// ---------------------------------------------------------------------------

/**
 * Markers that the bridge searches for when deciding where to splice in the
 * consciousness context.  Each marker corresponds to a BridgeConfig position.
 */
const POSITION_MARKERS: Record<BridgeConfig['injectionPosition'], RegExp> = {
  after_system: /\n*\[SYSTEM_END\]\n*/m,
  before_tools: /\n*\[TOOLS_BEGIN\]\n*/m,
  end: /\n*\[PROMPT_END\]\n*/m,
};

// ---------------------------------------------------------------------------
// ConsciousnessBridge class
// ---------------------------------------------------------------------------

/**
 * Bridges consciousness module output into the LLM system prompt.
 *
 * Workflow:
 *  1. Call ContextSelector.select() to get relevant modules.
 *  2. Adjust detail level based on current context-window occupancy.
 *  3. Format the context string at the appropriate fidelity.
 *  4. Return a BridgeInjection for the caller to splice into the prompt.
 */
export class ConsciousnessBridge {
  private readonly contextSelector: ContextSelector;
  private readonly config: BridgeConfig;

  // Running history of injections for traceability
  private readonly _history: BridgeInjection[] = [];

  // Aggregate statistics
  private _totalBridges = 0;
  private _totalTokensInjected = 0;
  private readonly _byCategory: Record<string, number> = {};
  private _contextSaved = 0; // tokens saved by compression

  constructor(contextSelector: ContextSelector, config?: Partial<BridgeConfig>) {
    if (!contextSelector) {
      throw new TypeError('ConsciousnessBridge: contextSelector is required');
    }
    this.contextSelector = contextSelector;
    this.config = { ...DEFAULT_CONFIG, ...config };
    log.debug({ config: this.config }, 'ConsciousnessBridge initialised');
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Build a context injection for the given category and intent.
   *
   * @param category            - Routing category from NegativeRouter.
   * @param intent              - Free-text intent string forwarded to ContextSelector.
   * @param currentContextPercent - Current context window usage (0-100).
   * @returns A BridgeInjection ready to be spliced into the system prompt.
   */
  bridge(category: string, intent: string, currentContextPercent: number): BridgeInjection {
    // Step 1: Select relevant modules via ContextSelector
    const selection: ContextSelection = this.contextSelector.select(category, intent);

    // Step 2: Determine detail tier based on context window pressure
    const detailTier = this.resolveDetailTier(currentContextPercent);

    // Step 3: Format the context string at the appropriate fidelity
    const context = this.formatInjection(selection, detailTier);

    // Step 4: Estimate token cost
    const tokenEstimate = estimateTokens(context);

    // Step 5: Cap to configured max, truncating if necessary
    const cappedContext = this.capToBudget(context, tokenEstimate);
    const finalTokenEstimate = cappedContext === context
      ? tokenEstimate
      : estimateTokens(cappedContext);

    // Step 6: Collect all contributing module names
    const modules = [
      ...selection.primaryModules.map((m) => m.moduleName),
      ...selection.secondaryModules.map((m) => m.moduleName),
    ];

    // Build the injection record
    const injection: BridgeInjection = {
      context: cappedContext,
      tokenEstimate: finalTokenEstimate,
      modules,
      category,
      injectedAt: new Date().toISOString(),
    };

    // Track for history and stats
    this._history.push(injection);
    this._totalBridges++;
    this._totalTokensInjected += finalTokenEstimate;
    this._byCategory[category] = (this._byCategory[category] ?? 0) + 1;

    // Calculate tokens saved by compression vs. full-detail baseline
    const fullDetailEstimate = estimateTokens(
      this.formatInjection(selection, 'full'),
    );
    this._contextSaved += Math.max(0, fullDetailEstimate - finalTokenEstimate);

    log.debug(
      {
        category,
        detailTier,
        contextPercent: currentContextPercent,
        tokenEstimate: finalTokenEstimate,
        moduleCount: modules.length,
      },
      'Bridge injection computed',
    );

    return injection;
  }

  /**
   * Insert a previously computed BridgeInjection into a system prompt string.
   *
   * The insertion position is controlled by BridgeConfig.injectionPosition.
   * If the corresponding marker is not found, the context is appended to the
   * end of the prompt as a safe fallback.
   *
   * @param systemPrompt - The original system prompt string.
   * @param injection    - A BridgeInjection produced by bridge().
   * @returns The modified system prompt with consciousness context inserted.
   */
  injectIntoPrompt(systemPrompt: string, injection: BridgeInjection): string {
    if (!systemPrompt || typeof systemPrompt !== 'string') {
      log.warn('injectIntoPrompt: systemPrompt is empty or not a string, returning injection only');
      return injection.context;
    }

    const marker = POSITION_MARKERS[this.config.injectionPosition];
    const match = marker.exec(systemPrompt);

    if (match) {
      // Insert right before the marker, preserving it
      const insertPoint = match.index;
      const prefix = systemPrompt.slice(0, insertPoint);
      const suffix = systemPrompt.slice(insertPoint);
      // Blank lines around the injection for readability
      const wrapped = `\n\n${injection.context}\n\n`;
      log.debug(
        { position: this.config.injectionPosition, index: insertPoint },
        'Context injected at marker position',
      );
      return prefix + wrapped + suffix;
    }

    // Fallback: append to end if marker not found
    log.debug(
      { position: this.config.injectionPosition },
      'Marker not found in system prompt, appending context to end',
    );
    return `${systemPrompt}\n\n${injection.context}\n`;
  }

  /**
   * Return recent bridge injection history, newest first.
   *
   * @param limit - Maximum number of records to return (default 20).
   */
  getBridgeHistory(limit: number = 20): BridgeInjection[] {
    return this._history.slice(-limit).reverse();
  }

  /**
   * Return aggregate statistics for observability dashboards.
   */
  getStats(): {
    totalBridges: number;
    avgTokensInjected: number;
    byCategory: Record<string, number>;
    contextSaved: number;
  } {
    return {
      totalBridges: this._totalBridges,
      avgTokensInjected: this._totalBridges > 0
        ? Math.round(this._totalTokensInjected / this._totalBridges)
        : 0,
      byCategory: { ...this._byCategory },
      contextSaved: this._contextSaved,
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Determine the detail tier based on current context-window occupancy.
   *
   * Tiers:
   *  - full:       < 50%  — all primary modules at full detail
   *  - moderate:  50-70% — top 2 primary at full detail, rest summarized
   *  - concise:    70-85% — all primary summarized, 1-line for secondary
   *  - compressed: > 85%  — 3-line ultra-compact summary only
   */
  private resolveDetailTier(
    currentContextPercent: number,
  ): 'full' | 'moderate' | 'concise' | 'compressed' {
    const pct = Math.max(0, Math.min(100, currentContextPercent));

    if (pct >= this.config.contextThresholdAggressive) {
      return 'compressed';
    }
    if (pct >= 70) {
      return 'concise';
    }
    if (pct >= this.config.contextThresholdMild) {
      return 'moderate';
    }
    return 'full';
  }

  /**
   * Format a ContextSelection into a context string at the given detail tier.
   */
  private formatInjection(
    selection: ContextSelection,
    tier: 'full' | 'moderate' | 'concise' | 'compressed',
  ): string {
    switch (tier) {
      case 'full':
        return this.formatFull(selection);
      case 'moderate':
        return this.formatModerate(selection);
      case 'concise':
        return this.formatConcise(selection);
      case 'compressed':
        return this.formatCompressed(selection);
    }
  }

  /**
   * Full detail: all primary modules expanded, secondary as 1-line summaries.
   * Target: ~2000 tokens.
   */
  private formatFull(selection: ContextSelection): string {
    const header = '[Consciousness Context]';
    const primaryLines = selection.primaryModules.map(
      (m) => `  ${m.moduleName}: ${m.reason}`,
    );
    const secondaryLines = selection.secondaryModules.map(
      (m) => `  ${m.moduleName}: ${m.reason} (summary)`,
    );

    return [
      header,
      'Primary modules (full detail):',
      ...primaryLines,
      ...(secondaryLines.length > 0
        ? ['Secondary modules (1-line):', ...secondaryLines]
        : []),
    ].join('\n');
  }

  /**
   * Moderate detail: top 2 primary modules at full detail, rest summarized.
   * Target: ~1200 tokens.
   */
  private formatModerate(selection: ContextSelection): string {
    const header = '[Consciousness Context — moderate]';
    const topPrimary = selection.primaryModules.slice(0, 2).map(
      (m) => `  ${m.moduleName}: ${m.reason}`,
    );
    const restPrimary = selection.primaryModules.slice(2).map(
      (m) => `  ${m.moduleName}: ${m.reason} (summary)`,
    );
    const secondaryLine = selection.secondaryModules.length > 0
      ? `  Secondary: ${selection.secondaryModules.map((m) => m.moduleName).join(', ')}`
      : '';

    return [
      header,
      ...topPrimary,
      ...(restPrimary.length > 0 ? restPrimary : []),
      ...(secondaryLine ? [secondaryLine] : []),
    ].join('\n');
  }

  /**
   * Concise detail: all primary summarized, 1-line for secondary.
   * Target: ~600 tokens.
   */
  private formatConcise(selection: ContextSelection): string {
    const header = '[Consciousness Context — concise]';
    const primaryLine = `  Primary: ${selection.primaryModules
      .map((m) => `${m.moduleName} (${m.reason})`)
      .join(' | ')}`;
    const secondaryLine = selection.secondaryModules.length > 0
      ? `  Secondary: ${selection.secondaryModules.map((m) => m.moduleName).join(', ')}`
      : '';

    return [
      header,
      primaryLine,
      ...(secondaryLine ? [secondaryLine] : []),
    ].join('\n');
  }

  /**
   * Compressed: ultra-compact 3-line summary only.
   * Target: ~200 tokens.
   */
  private formatCompressed(selection: ContextSelection): string {
    const primaryNames = selection.primaryModules.map((m) => m.moduleName).join(', ');
    const secondaryNames = selection.secondaryModules.map((m) => m.moduleName).join(', ');
    const secondaryPart = secondaryNames ? ` | Sec: ${secondaryNames}` : '';

    return [
      '[Consciousness Context — compressed]',
      `  Pri: ${primaryNames}${secondaryPart}`,
      `  Budget: high pressure — minimal context`,
    ].join('\n');
  }

  /**
   * Cap the context string to the configured maximum token budget.
   * If the estimated tokens exceed maxTokens, the string is truncated at
   * a word boundary with an ellipsis indicator appended.
   */
  private capToBudget(context: string, tokenEstimate: number): string {
    if (tokenEstimate <= this.config.maxTokens) {
      return context;
    }

    // Rough character limit from token budget (4 chars per token)
    const maxChars = this.config.maxTokens * 4;
    if (context.length <= maxChars) {
      return context;
    }

    // Truncate at last word boundary within budget
    const truncated = context.slice(0, maxChars);
    const lastSpace = truncated.lastIndexOf(' ');
    const cut = lastSpace > maxChars * 0.5
      ? truncated.slice(0, lastSpace)
      : truncated;

    log.debug(
      { originalTokens: tokenEstimate, maxTokens: this.config.maxTokens },
      'Context truncated to fit budget',
    );

    return `${cut}… [truncated]`;
  }
}