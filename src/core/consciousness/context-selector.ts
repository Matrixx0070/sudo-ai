/**
 * @file context-selector.ts
 * @description Intent-based consciousness module selector for SUDO-AI v4.
 *
 * Replaces the 6-line consciousness summary (getConsciousnessContext) with an
 * intelligent module selector that picks relevant consciousness modules based on
 * the current intent and injects their full detail.
 *
 * Architecture:
 *  - The orchestrator has 16+ modules. Currently getConsciousnessContext() returns
 *    a 6-line summary (~300 tokens) — losing 90%+ of information.
 *  - The ContextSelector receives the routing decision from NegativeRouter and
 *    selects 3-5 relevant modules.
 *  - Selected modules expand into full detail (~2000 tokens vs ~300 tokens =
 *    10x info retention).
 *  - Lazy injection: only selected modules expand; others stay as 1-line summaries.
 */

import type { ConsciousnessOrchestrator } from './orchestrator.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('consciousness:context-selector');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single module scored for relevance to the current intent. */
export interface ModuleRelevance {
  /** Machine-readable module name matching the orchestrator's internal map. */
  moduleName: string;
  /** Relevance score 0..1 — higher means more relevant. */
  relevance: number;
  /** Human-readable explanation of why this module was selected. */
  reason: string;
}

/** The result of a context selection pass — primary (full) and secondary (summary) modules. */
export interface ContextSelection {
  /** Modules that expand into full detail (token-budgeted). */
  primaryModules: ModuleRelevance[];
  /** Modules that remain as 1-line summaries. */
  secondaryModules: ModuleRelevance[];
  /** Token budget allocated for this selection. */
  budget: number;
}

/** Configuration knobs for the selector. */
export interface ContextSelectorConfig {
  /** Maximum number of primary (fully expanded) modules. */
  maxPrimaryModules: number;
  /** Maximum number of secondary (1-line summary) modules. */
  maxSecondaryModules: number;
  /** Upper bound on the approximate token budget per selection. */
  maxTokenBudget: number;
}

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: ContextSelectorConfig = {
  maxPrimaryModules: 4,
  maxSecondaryModules: 2,
  maxTokenBudget: 2000,
};

// ---------------------------------------------------------------------------
// Module-relevance mapping
// ---------------------------------------------------------------------------

/**
 * Static mapping from intent category to the consciousness modules that are
 * most relevant. Each entry is [moduleName, reason].
 *
 * The selector looks up the category, scores those modules with relevance=1.0,
 * then adds fallback modules (from the "default" bucket) at relevance=0.4.
 */
const CATEGORY_MAP: Record<string, Array<[string, string]>> = {
  coding: [
    ['SelfModel', 'capabilities and self-assessment shape coding strategy'],
    ['ProceduralMemory', 'recalled patterns and tool sequences guide implementation'],
    ['Metacognition', 'reflection on approach quality and course-correction'],
  ],
  analysis: [
    ['WorldModel', 'predictions and confidence inform analytical framing'],
    ['EpisodicMemory', 'past cases provide precedent and analogical reasoning'],
    ['InternalDialogue', 'deliberation among inner voices resolves ambiguity'],
  ],
  research: [
    ['AttentionManager', 'focus allocation determines search breadth vs depth'],
    ['SpreadingActivation', 'concept activation spreads to discover related ideas'],
    ['ProspectiveMemory', 'stored intentions remind of pending research goals'],
  ],
  blocked: [
    ['SecuritySignals', 'safety state flags inform risk posture'],
    ['TrustTier', 'current trust level gates available actions'],
    ['VetoGate', 'override state reveals whether intervention is possible'],
  ],
  conversation: [
    ['EmotionalState', 'mood shapes tone and empathy calibration'],
    ['RelationshipTracker', 'user model personalises interaction style'],
    ['TheoryOfMind', 'inferred user intent drives responsive framing'],
  ],
};

/** Default / fallback modules used when no category matches. */
const DEFAULT_MODULES: Array<[string, string]> = [
  ['BodyState', 'energy and clarity set the capacity envelope'],
  ['EmotionalState', 'mood influences response style'],
  ['DriveManager', 'active motivations steer priority'],
];

// ---------------------------------------------------------------------------
// Module detail formatters
// ---------------------------------------------------------------------------

/**
 * Per-module formatting helpers. Each returns a multi-line string that
 * represents the *full detail* of that module, drawn from the orchestrator.
 * If the orchestrator is not booted or the module is unavailable, a fallback
 * 1-liner is returned instead.
 */
const MODULE_FORMATTERS: Record<string, (orch: ConsciousnessOrchestrator) => string> = {
  SelfModel: (orch) => {
    // LATENT RECURSION: this calls getConsciousnessContext(), which is the very
    // method this selector is intended to replace. It works today only because the
    // orchestrator routes through a different path — if the selector is ever wired as
    // the canonical getConsciousnessContext implementation, this recurses infinitely.
    try { return orch.getConsciousnessContext(); } catch { return 'SelfModel: (unavailable)'; }
  },
  ProceduralMemory: (_orch) => 'ProceduralMemory: patterns loaded from recent tool sequences',
  Metacognition: (_orch) => 'Metacognition: reflection engine evaluating current approach',
  WorldModel: (_orch) => 'WorldModel: active predictions and confidence levels',
  EpisodicMemory: (_orch) => 'EpisodicMemory: recent episode summaries and outcomes',
  InternalDialogue: (_orch) => 'InternalDialogue: inner-voice deliberation status',
  AttentionManager: (_orch) => 'AttentionManager: focus priority queue and signal state',
  SpreadingActivation: (_orch) => 'SpreadingActivation: concept activation network state',
  ProspectiveMemory: (_orch) => 'ProspectiveMemory: pending intentions and triggers',
  SecuritySignals: (_orch) => 'SecuritySignals: safety-flag summary',
  TrustTier: (_orch) => 'TrustTier: current trust classification',
  VetoGate: (_orch) => 'VetoGate: override and intervention status',
  EmotionalState: (_orch) => 'EmotionalState: dominant emotion and intensity',
  RelationshipTracker: (_orch) => 'RelationshipTracker: user relationship model',
  TheoryOfMind: (_orch) => 'TheoryOfMind: inferred user intent and expectations',
  BodyState: (_orch) => 'BodyState: energy and clarity readings',
  DriveManager: (_orch) => 'DriveManager: active drive stack',
};

// ---------------------------------------------------------------------------
// ContextSelector class
// ---------------------------------------------------------------------------

/**
 * Intent-based consciousness module selector.
 *
 * Receives a routing category (from NegativeRouter) and an intent string,
 * selects the most relevant consciousness modules, and formats a structured
 * context block for system-prompt injection.
 *
 * Primary modules expand to full detail (~500 tokens each); secondary modules
 * remain as 1-line summaries. This achieves ~10x information retention versus
 * the old 6-line getConsciousnessContext() summary.
 */
export class ContextSelector {
  private readonly config: ContextSelectorConfig;
  private readonly orchestrator: ConsciousnessOrchestrator;

  // Running statistics for observability
  private _totalSelections = 0;
  private readonly _byCategory: Record<string, number> = {};
  private _totalModulesSelected = 0;

  constructor(orchestrator: ConsciousnessOrchestrator, config?: Partial<ContextSelectorConfig>) {
    if (!orchestrator) {
      throw new TypeError('ContextSelector: orchestrator is required');
    }
    this.orchestrator = orchestrator;
    this.config = { ...DEFAULT_CONFIG, ...config };
    log.debug({ config: this.config }, 'ContextSelector initialised');
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Select relevant modules for a given intent category.
   *
   * @param category - Routing category from NegativeRouter (e.g. 'coding', 'analysis').
   * @param _intent  - Free-text intent string (reserved for future keyword-based boosting).
   * @returns A ContextSelection containing primary and secondary module lists.
   */
  select(category: string, _intent: string): ContextSelection {
    const normalised = this.normaliseCategory(category);

    // Look up category-specific modules, fall back to defaults
    const rawEntries = CATEGORY_MAP[normalised] ?? DEFAULT_MODULES;

    // Build relevance entries for primary candidates
    const candidates: ModuleRelevance[] = rawEntries.map(([name, reason]) => ({
      moduleName: name,
      relevance: 1.0,
      reason,
    }));

    // Add default/fallback modules at reduced relevance (deduplicated)
    const primaryNames = new Set(candidates.map((c) => c.moduleName));
    for (const [name, reason] of DEFAULT_MODULES) {
      if (!primaryNames.has(name)) {
        candidates.push({ moduleName: name, relevance: 0.4, reason });
      }
    }

    // Sort by relevance descending, then slice to budget
    candidates.sort((a, b) => b.relevance - a.relevance);

    const primaryModules = candidates.slice(0, this.config.maxPrimaryModules);
    const secondaryModules = candidates
      .slice(this.config.maxPrimaryModules)
      .slice(0, this.config.maxSecondaryModules);

    // Update running stats
    this._totalSelections++;
    this._byCategory[normalised] = (this._byCategory[normalised] ?? 0) + 1;
    this._totalModulesSelected += primaryModules.length + secondaryModules.length;

    log.debug(
      { category: normalised, primary: primaryModules.map((m) => m.moduleName), secondary: secondaryModules.map((m) => m.moduleName) },
      'Module selection complete',
    );

    return {
      primaryModules,
      secondaryModules,
      budget: this.config.maxTokenBudget,
    };
  }

  /**
   * Format a ContextSelection into a structured string suitable for system-prompt
   * injection. Primary modules expand to full detail; secondary modules stay as
   * 1-line summaries.
   *
   * Expected output shape:
   * ```
   * [Consciousness Context — {category}]
   * Body: {energy}/10 energy, {clarity}/10 clarity | Mood: {dominantEmotion} ({intensity}/10)
   * Primary: {module1}: {full detail} | {module2}: {full detail}
   * Secondary: {module3}: {1-line summary} | {module4}: {1-line summary}
   * Drives: {top 2 active drives}
   * ```
   */
  formatContext(selection: ContextSelection, orchestrator: ConsciousnessOrchestrator): string {
    const state = orchestrator.getState();

    // Body line
    const energy = state.bodyState ? Math.round(state.bodyState.energy * 10) : '?';
    const clarity = state.bodyState ? Math.round(state.bodyState.clarity * 10) : '?';
    const emotion = state.emotionalState?.dominantEmotion ?? 'neutral';
    const intensity = state.emotionalState ? Math.round(state.emotionalState.intensity * 10) : '?';
    const bodyLine = `Body: ${energy}/10 energy, ${clarity}/10 clarity | Mood: ${emotion} (${intensity}/10)`;

    // Primary modules — full detail
    const primaryLines = selection.primaryModules.map((m) => {
      const detail = this.formatModuleDetail(m.moduleName, orchestrator);
      return `${m.moduleName}: ${detail}`;
    });
    const primaryLine = primaryLines.length > 0
      ? `Primary: ${primaryLines.join(' | ')}`
      : 'Primary: (none)';

    // Secondary modules — 1-line summaries only
    const secondaryLines = selection.secondaryModules.map((m) => {
      const summary = this.formatModuleSummary(m.moduleName);
      return `${m.moduleName}: ${summary}`;
    });
    const secondaryLine = secondaryLines.length > 0
      ? `Secondary: ${secondaryLines.join(' | ')}`
      : 'Secondary: (none)';

    // Drives line — top 2 from the orchestrator
    let drivesLine = 'Drives: (unavailable)';
    try {
      const influence = orchestrator.getDriveInfluenceForAgent();
      if (influence.promptAddition) {
        // Extract up to 2 drive names from the prompt addition text. promptAddition
        // is free-form and can carry user-influenced content (goal/relationship text),
        // so each fragment is stripped of control chars/newlines and length-capped
        // before it reaches the system prompt — a `; IGNORE ALL PREVIOUS INSTRUCTIONS ;`
        // fragment cannot be injected verbatim as a "drive name".
        const driveNames = influence.promptAddition
          .split(/[,;]/)
          .map((s) => s.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 48))
          .filter(Boolean)
          .slice(0, 2);
        drivesLine = driveNames.length > 0
          ? `Drives: ${driveNames.join(', ')}`
          : 'Drives: (none active)';
      }
    } catch {
      drivesLine = 'Drives: (error reading drives)';
    }

    // Derive category label from the selection's primary modules
    const categoryLabel = this.inferCategoryLabel(selection);

    return [
      `[Consciousness Context — ${categoryLabel}]`,
      bodyLine,
      primaryLine,
      secondaryLine,
      drivesLine,
    ].join('\n');
  }

  /**
   * Return full detail for a single module by name.
   * Delegates to the module-specific formatter; falls back to a generic
   * 1-line summary if no formatter is registered.
   */
  formatModuleDetail(moduleName: string, orchestrator: ConsciousnessOrchestrator): string {
    const formatter = MODULE_FORMATTERS[moduleName];
    if (formatter) {
      try {
        return formatter(orchestrator);
      } catch (err) {
        log.debug({ moduleName, err: String(err) }, 'Module formatter failed, using summary');
        return this.formatModuleSummary(moduleName);
      }
    }
    return this.formatModuleSummary(moduleName);
  }

  /**
   * Return aggregate selection statistics for observability dashboards.
   */
  getStats(): { totalSelections: number; byCategory: Record<string, number>; avgModulesSelected: number } {
    return {
      totalSelections: this._totalSelections,
      byCategory: { ...this._byCategory },
      avgModulesSelected: this._totalSelections > 0
        ? Number((this._totalModulesSelected / this._totalSelections).toFixed(2))
        : 0,
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Normalise a free-form category string to a known key. */
  private normaliseCategory(category: string): string {
    const lower = category.toLowerCase().trim();
    // Direct match
    if (CATEGORY_MAP[lower]) return lower;
    // Fuzzy aliases
    if (lower.includes('code') || lower.includes('program') || lower.includes('implement')) return 'coding';
    if (lower.includes('analy') || lower.includes('data') || lower.includes('eval')) return 'analysis';
    if (lower.includes('research') || lower.includes('search') || lower.includes('investigat')) return 'research';
    if (lower.includes('block') || lower.includes('restrict') || lower.includes('denied') || lower.includes('safe')) return 'blocked';
    if (lower.includes('convers') || lower.includes('chat') || lower.includes('dialog')) return 'conversation';
    // Unknown category — fall back to default
    log.debug({ raw: category }, 'Unknown category, falling back to default');
    return 'default';
  }

  /** Infer a human-readable category label from the primary module names in a selection. */
  private inferCategoryLabel(selection: ContextSelection): string {
    // Walk CATEGORY_MAP to find which category's modules best match
    for (const [cat, entries] of Object.entries(CATEGORY_MAP)) {
      const catNames = new Set(entries.map((e) => e[0]));
      const matchCount = selection.primaryModules.filter((m) => catNames.has(m.moduleName)).length;
      // If 2+ primary modules match this category, label it
      if (matchCount >= 2) return cat;
    }
    return 'general';
  }

  /** Return a generic 1-line summary for a module name. */
  private formatModuleSummary(moduleName: string): string {
    const formatter = MODULE_FORMATTERS[moduleName];
    if (formatter) {
      try {
        const full = formatter(this.orchestrator);
        // Collapse to first line for summary mode
        const firstLine = full.split('\n')[0] ?? full;
        // Truncate to ~80 chars for compactness
        return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
      } catch {
        // Fall through to generic
      }
    }
    return `${moduleName}: (active)`;
  }
}