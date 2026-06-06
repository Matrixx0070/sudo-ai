/**
 * EffortDial — adjustable effort-level controller for SUDO-AI agent runs.
 *
 * Provides a "dial" metaphor for scaling agent resource consumption: the
 * caller selects a level (low / medium / high) and the dial returns concrete
 * limits for thinking tokens, tool turns, verification depth, subagent
 * count, and pricing multiplier. Custom overrides let callers tweak
 * individual knobs without changing the entire preset.
 *
 * Persistence: the current level + overrides are stored in session settings
 * so they survive across loop iterations within a session.
 */

import { createLogger } from '../shared/logger.js';
import { genId } from '../shared/utils.js';

const log = createLogger('agent:effort-dial');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Named effort levels on the dial. */
export type EffortDialLevel = 'low' | 'medium' | 'high';

/** How thoroughly results are verified after a tool call. */
export type VerificationDepth = 'none' | 'basic' | 'adversarial';

/** Concrete limits derived from a dial level (with optional overrides). */
export interface EffortDialConfig {
  /** Unique ID for this config snapshot (changes on every setLevel / override). */
  id: string;
  /** The named dial level this config was derived from. */
  level: EffortDialLevel;
  /** Maximum tokens the model may spend on chain-of-thought / thinking. */
  thinkingTokens: number;
  /** Maximum consecutive tool-call turns the loop will execute. */
  maxToolTurns: number;
  /** How thoroughly tool results are verified before accepting. */
  verificationDepth: VerificationDepth;
  /** Maximum concurrent subagents this level may spawn. */
  subagentCount: number;
  /** Pricing multiplier relative to the base rate (1x = normal). */
  pricingMultiplier: number;
}

/** Per-field overrides a caller can pass to customise a preset level. */
export interface EffortDialOverrides {
  thinkingTokens?: number;
  maxToolTurns?: number;
  verificationDepth?: VerificationDepth;
  subagentCount?: number;
  pricingMultiplier?: number;
}

/** Shape stored in session settings for persistence across loop iterations. */
interface PersistedDialState {
  level: EffortDialLevel;
  overrides: EffortDialOverrides;
}

// ---------------------------------------------------------------------------
// Preset table
// ---------------------------------------------------------------------------

const EFFORT_DIAL_PRESETS: Record<EffortDialLevel, Omit<EffortDialConfig, 'id' | 'level'>> = {
  low: {
    thinkingTokens: 1_000,
    maxToolTurns: 5,
    verificationDepth: 'none',
    subagentCount: 1,
    pricingMultiplier: 0.5,
  },
  medium: {
    thinkingTokens: 10_000,
    maxToolTurns: 15,
    verificationDepth: 'basic',
    subagentCount: 3,
    pricingMultiplier: 1.0,
  },
  high: {
    thinkingTokens: 50_000,
    maxToolTurns: 50,
    verificationDepth: 'adversarial',
    subagentCount: 10,
    pricingMultiplier: 2.0,
  },
};

// ---------------------------------------------------------------------------
// Session settings key
// ---------------------------------------------------------------------------

const SESSION_SETTINGS_KEY = 'effort-dial';

// ---------------------------------------------------------------------------
// EffortDial class
// ---------------------------------------------------------------------------

/**
 * Adjustable effort-level controller for an agent session.
 *
 * Usage:
 *   const dial = new EffortDial(sessionSettings);
 *   dial.setLevel('high');
 *   dial.getThinkingTokens(); // 50_000
 *
 * Custom overrides:
 *   dial.setLevel('medium', { thinkingTokens: 20_000 });
 *   dial.getThinkingTokens(); // 20_000 (override)
 *   dial.getMaxToolTurns();   // 15    (from preset)
 */
export class EffortDial {
  /** In-memory session settings bag (shared reference with the session). */
  private readonly settings: Map<string, unknown>;

  /** Cached config computed from level + overrides. Invalidated on change. */
  private cached: EffortDialConfig | null = null;

  /**
   * @param sessionSettings - A Map used by the session to store settings.
   *                          The dial reads/writes the key `effort-dial` in it.
   *                          Defaults to an empty Map when omitted.
   */
  constructor(sessionSettings?: Map<string, unknown>) {
    this.settings = sessionSettings ?? new Map();

    // Restore persisted state if present.
    const persisted = this.settings.get(SESSION_SETTINGS_KEY) as PersistedDialState | undefined;
    if (persisted && isValidLevel(persisted.level)) {
      // State already exists — cache will be built lazily on first get.
      log.debug({ level: persisted.level }, 'EffortDial: restored persisted state');
    } else {
      // Initialise with default level.
      this.writeState({ level: 'medium', overrides: {} });
      log.debug('EffortDial: initialised at default level (medium)');
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Set the effort dial to a named level, optionally with custom overrides.
   *
   * @param level    - One of 'low', 'medium', 'high'.
   * @param overrides - Optional per-field overrides that override preset values.
   */
  setLevel(level: EffortDialLevel, overrides: EffortDialOverrides = {}): void {
    if (!isValidLevel(level)) {
      throw new TypeError(`EffortDial.setLevel: invalid level "${String(level)}". Must be one of: low, medium, high`);
    }
    validateOverrides(overrides);
    this.writeState({ level, overrides });
    this.cached = null; // invalidate cache
    log.info({ level, overrides }, 'EffortDial: level set');
  }

  /** Return the current named dial level. */
  getLevel(): EffortDialLevel {
    return this.readState().level;
  }

  /** Return the maximum thinking-token budget. */
  getThinkingTokens(): number {
    return this.getConfig().thinkingTokens;
  }

  /** Return the maximum number of consecutive tool-call turns. */
  getMaxToolTurns(): number {
    return this.getConfig().maxToolTurns;
  }

  /** Return the verification depth for tool results. */
  getVerificationDepth(): VerificationDepth {
    return this.getConfig().verificationDepth;
  }

  /** Return the maximum number of concurrent subagents. */
  getSubagentCount(): number {
    return this.getConfig().subagentCount;
  }

  /** Return the pricing multiplier (1x = base rate). */
  getPricing(): number {
    return this.getConfig().pricingMultiplier;
  }

  /** Return the full resolved config (useful for bulk reads). */
  getConfig(): EffortDialConfig {
    if (this.cached) return this.cached;

    const { level, overrides } = this.readState();
    const preset = EFFORT_DIAL_PRESETS[level];

    const config: EffortDialConfig = {
      id: genId(),
      level,
      thinkingTokens: overrides.thinkingTokens ?? preset.thinkingTokens,
      maxToolTurns: overrides.maxToolTurns ?? preset.maxToolTurns,
      verificationDepth: overrides.verificationDepth ?? preset.verificationDepth,
      subagentCount: overrides.subagentCount ?? preset.subagentCount,
      pricingMultiplier: overrides.pricingMultiplier ?? preset.pricingMultiplier,
    };

    this.cached = config;
    return config;
  }

  /**
   * Apply custom overrides on top of the current level without changing
   * the level itself. Merges with any existing overrides (new values win).
   */
  override(patch: EffortDialOverrides): void {
    validateOverrides(patch);
    const state = this.readState();
    const merged: EffortDialOverrides = {
      ...state.overrides,
      ...patch,
    };
    this.writeState({ level: state.level, overrides: merged });
    this.cached = null;
    log.info({ level: state.level, merged }, 'EffortDial: overrides applied');
  }

  /**
   * Clear any custom overrides, reverting to the pure preset for the
   * current level.
   */
  resetOverrides(): void {
    const state = this.readState();
    this.writeState({ level: state.level, overrides: {} });
    this.cached = null;
    log.info({ level: state.level }, 'EffortDial: overrides cleared');
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private readState(): PersistedDialState {
    const stored = this.settings.get(SESSION_SETTINGS_KEY);
    if (isPersistedDialState(stored)) return stored;
    // Fallback — should not normally happen.
    const fallback: PersistedDialState = { level: 'medium', overrides: {} };
    this.writeState(fallback);
    return fallback;
  }

  private writeState(state: PersistedDialState): void {
    this.settings.set(SESSION_SETTINGS_KEY, state);
  }
}

// ---------------------------------------------------------------------------
// Standalone convenience functions (operate on a default singleton)
// ---------------------------------------------------------------------------

let defaultDial: EffortDial | null = null;

function getDefaultDial(): EffortDial {
  if (!defaultDial) {
    defaultDial = new EffortDial();
  }
  return defaultDial;
}

/** Set the effort level on the default singleton dial. */
export function setLevel(level: EffortDialLevel, overrides?: EffortDialOverrides): void {
  getDefaultDial().setLevel(level, overrides);
}

/** Get the current effort level from the default singleton dial. */
export function getLevel(): EffortDialLevel {
  return getDefaultDial().getLevel();
}

/** Get thinking-token budget from the default singleton dial. */
export function getThinkingTokens(): number {
  return getDefaultDial().getThinkingTokens();
}

/** Get max tool turns from the default singleton dial. */
export function getMaxToolTurns(): number {
  return getDefaultDial().getMaxToolTurns();
}

/** Get verification depth from the default singleton dial. */
export function getVerificationDepth(): VerificationDepth {
  return getDefaultDial().getVerificationDepth();
}

/** Get subagent count from the default singleton dial. */
export function getSubagentCount(): number {
  return getDefaultDial().getSubagentCount();
}

/** Get pricing multiplier from the default singleton dial. */
export function getPricing(): number {
  return getDefaultDial().getPricing();
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

const VALID_LEVELS: ReadonlySet<string> = new Set(['low', 'medium', 'high']);

function isValidLevel(value: unknown): value is EffortDialLevel {
  return VALID_LEVELS.has(value as string);
}

const VALID_VERIFICATION_DEPTHS: ReadonlySet<string> = new Set(['none', 'basic', 'adversarial']);

function isPersistedDialState(value: unknown): value is PersistedDialState {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.level === 'string' &&
    isValidLevel(obj.level) &&
    typeof obj.overrides === 'object' &&
    obj.overrides !== null
  );
}

function validateOverrides(overrides: EffortDialOverrides): void {
  if (overrides.thinkingTokens !== undefined && overrides.thinkingTokens < 0) {
    throw new RangeError('EffortDial: thinkingTokens must be >= 0');
  }
  if (overrides.maxToolTurns !== undefined && overrides.maxToolTurns < 0) {
    throw new RangeError('EffortDial: maxToolTurns must be >= 0');
  }
  if (overrides.verificationDepth !== undefined && !VALID_VERIFICATION_DEPTHS.has(overrides.verificationDepth)) {
    throw new TypeError(
      `EffortDial: invalid verificationDepth "${String(overrides.verificationDepth)}". Must be one of: none, basic, adversarial`
    );
  }
  if (overrides.subagentCount !== undefined && overrides.subagentCount < 0) {
    throw new RangeError('EffortDial: subagentCount must be >= 0');
  }
  if (overrides.pricingMultiplier !== undefined && overrides.pricingMultiplier < 0) {
    throw new RangeError('EffortDial: pricingMultiplier must be >= 0');
  }
}