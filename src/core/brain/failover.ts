/**
 * Model failover and cooldown management system.
 *
 * Maintains a runtime registry of ModelProfile objects.
 * On error: applies exponential cooldown per error category.
 * On success: resets consecutive error count.
 * getNextProfile() always returns the highest-priority available model.
 */

import { categorizeError, LLMError } from '../shared/errors.js';
import { TRANSIENT_COOLDOWN, BILLING_COOLDOWN } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';
import type { ModelProfile, ErrorCategory } from './types.js';

export type { ErrorCategory };

const log = createLogger('brain:failover');

// ---------------------------------------------------------------------------
// Transient vs billing category sets
// ---------------------------------------------------------------------------

const TRANSIENT_CATEGORIES = new Set<ErrorCategory>([
  'rate_limit',
  'overloaded',
  'timeout',
]);

const BILLING_CATEGORIES = new Set<ErrorCategory>(['billing']);

const PERMANENT_CATEGORIES = new Set<ErrorCategory>(['auth_permanent']);

/**
 * Additive jitter applied to scheduled cooldowns: the final wait is
 * base .. base*(1+JITTER_RATIO). Jitter only ever LENGTHENS the wait, so we
 * never retry sooner than the schedule, while still de-synchronizing retries
 * across profiles to avoid a thundering-herd storm.
 */
const JITTER_RATIO = 0.2;

/**
 * Hard cap on a server-provided Retry-After, so a pathological/huge value can't
 * wedge a model out of rotation indefinitely.
 */
const MAX_RETRY_AFTER_MS = 3_600_000; // 1 hour

/** Structured classification of an ErrorCategory for retry strategy + observability. */
export type ErrorClass = 'transient' | 'billing' | 'permanent' | 'other';

/** Optional inputs to recordError(). */
export interface RecordErrorOptions {
  /** Server-provided Retry-After in ms (parsed from the response header/body), if any. */
  retryAfterMs?: number;
  /** Injectable RNG for deterministic tests. Defaults to Math.random. */
  rng?: () => number;
}

// ---------------------------------------------------------------------------
// ModelFailover class
// ---------------------------------------------------------------------------

/** Manages LLM model selection and per-model cooldown state. */
export class ModelFailover {
  private readonly profiles: Map<string, ModelProfile> = new Map();

  /**
   * Register a list of model strings with explicit priorities.
   *
   * @param models - Ordered array of "provider/model-id" strings.
   *                 Index 0 = highest priority (priority value 0).
   */
  constructor(models: string[]) {
    if (!Array.isArray(models) || models.length === 0) {
      throw new LLMError(
        'ModelFailover requires at least one model string',
        'llm_failover_no_models',
      );
    }

    for (let i = 0; i < models.length; i++) {
      const modelString = models[i];
      if (typeof modelString !== 'string' || !modelString.includes('/')) {
        throw new LLMError(
          `Invalid model string at index ${i}: "${String(modelString)}"`,
          'llm_invalid_model_string',
          { index: i, modelString },
        );
      }

      const slashIndex = modelString.indexOf('/');
      const provider = modelString.slice(0, slashIndex) as ModelProfile['provider'];
      const modelId = modelString.slice(slashIndex + 1);

      const validProviders = ['xai', 'openai', 'anthropic', 'google', 'groq', 'mistral', 'deepseek', 'ollama', 'together'];
      if (!validProviders.includes(provider)) {
        throw new LLMError(
          `Unknown provider "${provider}" in model string "${modelString}"`,
          'llm_unknown_provider',
          { provider, modelString },
        );
      }

      const profile: ModelProfile = {
        id: modelString,
        provider,
        modelId,
        priority: i,
        lastUsed: 0,
        cooldownUntil: 0,
        consecutiveErrors: 0,
        disabled: false,
      };

      this.profiles.set(modelString, profile);
      log.debug({ modelString, priority: i }, 'Registered model profile');
    }
  }

  // ---------------------------------------------------------------------------
  // Error classification
  // ---------------------------------------------------------------------------

  /**
   * Classify an HTTP status code and optional body into an ErrorCategory.
   * Delegates to the shared categorizeError utility.
   *
   * @param status - HTTP status code.
   * @param body   - Optional response body string.
   */
  categorizeError(status: number, body?: string): ErrorCategory {
    return categorizeError(status, body);
  }

  // ---------------------------------------------------------------------------
  // State mutation
  // ---------------------------------------------------------------------------

  /**
   * Record a failure for a profile and apply the appropriate cooldown.
   *
   * @param profileId - The model string, e.g. "xai/grok-3-fast".
   * @param category  - Pre-classified error category.
   */
  recordError(profileId: string, category: ErrorCategory, opts: RecordErrorOptions = {}): void {
    const profile = this.profiles.get(profileId);
    if (!profile) {
      log.warn({ profileId }, 'recordError: unknown profile — ignoring');
      return;
    }

    profile.consecutiveErrors += 1;
    const errorCount = profile.consecutiveErrors;
    const now = Date.now();

    if (PERMANENT_CATEGORIES.has(category)) {
      profile.disabled = true;
      log.error(
        { profileId, category },
        'Profile permanently disabled due to auth_permanent error',
      );
      return;
    }

    if (BILLING_CATEGORIES.has(category)) {
      const cooldownMs = this._cooldownMs(BILLING_COOLDOWN, errorCount, opts);
      profile.cooldownUntil = now + cooldownMs;
      log.warn(
        { profileId, category, errClass: 'billing', errorCount, cooldownMs, retryAfterMs: opts.retryAfterMs, cooldownUntil: profile.cooldownUntil },
        'Billing cooldown applied',
      );
      return;
    }

    if (TRANSIENT_CATEGORIES.has(category)) {
      const cooldownMs = this._cooldownMs(TRANSIENT_COOLDOWN, errorCount, opts);
      profile.cooldownUntil = now + cooldownMs;
      log.warn(
        { profileId, category, errClass: 'transient', errorCount, cooldownMs, retryAfterMs: opts.retryAfterMs },
        'Transient cooldown applied',
      );
      return;
    }

    // format / model_not_found / session_expired / auth (non-permanent):
    // Apply a short transient cooldown (first slot) to avoid hammering.
    const cooldownMs = this._cooldownMs(TRANSIENT_COOLDOWN, 1, opts);
    profile.cooldownUntil = now + cooldownMs;
    log.warn(
      { profileId, category, errClass: 'other', errorCount, cooldownMs, retryAfterMs: opts.retryAfterMs },
      'Non-categorized error — short cooldown applied',
    );
  }

  /**
   * Compute a cooldown for the given schedule + consecutive error count.
   *
   * Applies additive jitter (never shorter than the base schedule) to avoid
   * synchronized retry storms, then honors a server Retry-After when it asks us
   * to wait LONGER than our own schedule (capped at MAX_RETRY_AFTER_MS).
   */
  private _cooldownMs(
    schedule: readonly number[],
    errorCount: number,
    opts: RecordErrorOptions,
  ): number {
    const idx = Math.min(Math.max(errorCount - 1, 0), schedule.length - 1);
    const base = schedule[idx];
    const rng = opts.rng ?? Math.random;
    // Additive jitter: base .. base*(1 + JITTER_RATIO). Never below base.
    let ms = base + base * JITTER_RATIO * Math.max(0, Math.min(1, rng()));
    // Respect a longer server-provided Retry-After (capped).
    if (typeof opts.retryAfterMs === 'number' && opts.retryAfterMs > ms) {
      ms = Math.min(opts.retryAfterMs, MAX_RETRY_AFTER_MS);
    }
    return Math.round(ms);
  }

  /**
   * Classify an ErrorCategory into a coarse retry strategy class. Exposed for
   * callers/observability so the transient-vs-permanent split is explicit.
   */
  classifyCategory(category: ErrorCategory): ErrorClass {
    if (PERMANENT_CATEGORIES.has(category)) return 'permanent';
    if (BILLING_CATEGORIES.has(category)) return 'billing';
    if (TRANSIENT_CATEGORIES.has(category)) return 'transient';
    return 'other';
  }

  /**
   * Record a successful call for a profile, resetting its error counter.
   *
   * @param profileId - The model string.
   */
  recordSuccess(profileId: string): void {
    const profile = this.profiles.get(profileId);
    if (!profile) {
      log.warn({ profileId }, 'recordSuccess: unknown profile — ignoring');
      return;
    }

    const hadErrors = profile.consecutiveErrors > 0;
    profile.consecutiveErrors = 0;
    profile.cooldownUntil = 0;
    profile.lastUsed = Date.now();

    if (hadErrors) {
      log.info({ profileId }, 'Profile recovered — error count reset');
    } else {
      log.debug({ profileId }, 'Success recorded');
    }
  }

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------

  /**
   * Return the next available profile sorted by priority (lowest number first),
   * skipping disabled or cooled-down profiles.
   *
   * When all non-disabled profiles are in cooldown, auto-reset cooldowns on
   * the profile whose cooldown expires soonest, so the system can retry
   * instead of being completely dead until timers elapse.
   *
   * @returns The selected ModelProfile, or null when ALL profiles are permanently disabled.
   */
  getNextProfile(): ModelProfile | null {
    const now = Date.now();

    const available = Array.from(this.profiles.values())
      .filter((p) => !p.disabled && p.cooldownUntil <= now)
      .sort((a, b) => a.priority - b.priority);

    if (available.length === 0) {
      // All profiles are either disabled or in cooldown.
      // Check if any non-disabled profiles exist — if so, force-reset the one
      // with the shortest remaining cooldown so we can attempt a retry.
      const cooledDown = Array.from(this.profiles.values())
        .filter((p) => !p.disabled && p.cooldownUntil > now)
        .sort((a, b) => a.cooldownUntil - b.cooldownUntil);

      if (cooledDown.length > 0) {
        const rescued = cooledDown[0];
        const remainingMs = rescued.cooldownUntil - now;
        log.warn(
          { profileId: rescued.id, remainingMs, consecutiveErrors: rescued.consecutiveErrors },
          'All profiles in cooldown — force-resetting earliest to allow retry',
        );
        rescued.cooldownUntil = 0;
        // Keep consecutiveErrors so the next failure still escalates properly.
        return rescued;
      }

      // Truly no usable profiles — all are permanently disabled.
      log.error('No available model profiles — all are permanently disabled');
      return null;
    }

    const selected = available[0];
    log.debug(
      { profileId: selected.id, priority: selected.priority },
      'Selected model profile',
    );
    return selected;
  }

  /**
   * Force-reset cooldowns on ALL non-disabled profiles.
   * Used when the system needs an emergency recovery (e.g. after a restart
   * or when a provider outage has resolved).
   */
  resetAllCooldowns(): void {
    let count = 0;
    for (const profile of this.profiles.values()) {
      if (!profile.disabled && (profile.cooldownUntil > 0 || profile.consecutiveErrors > 0)) {
        profile.cooldownUntil = 0;
        profile.consecutiveErrors = 0;
        count++;
      }
    }
    log.info({ resetCount: count }, 'All cooldowns force-reset');
  }

  // ---------------------------------------------------------------------------
  // Inspection
  // ---------------------------------------------------------------------------

  /**
   * Whether a given profile is currently in cooldown.
   *
   * @param profileId - The model string.
   */
  isCooledDown(profileId: string): boolean {
    const profile = this.profiles.get(profileId);
    if (!profile) return false;
    return !profile.disabled && profile.cooldownUntil > Date.now();
  }

  /**
   * Remaining cooldown in milliseconds for a profile. Returns 0 if not in cooldown.
   *
   * @param profileId - The model string.
   */
  getCooldownRemaining(profileId: string): number {
    const profile = this.profiles.get(profileId);
    if (!profile || profile.cooldownUntil === 0) return 0;
    return Math.max(0, profile.cooldownUntil - Date.now());
  }

  /**
   * Return a snapshot of all profiles for diagnostic logging.
   */
  getStatus(): ModelProfile[] {
    return Array.from(this.profiles.values()).map((p) => ({ ...p }));
  }

  // ---------------------------------------------------------------------------
  // Cloud vs local splitting (Ollama parallel racing)
  // ---------------------------------------------------------------------------

  /**
   * Return all available cloud-model profiles sorted by priority.
   * Cloud = modelId ends with ':cloud' and is not disabled/cooled-down.
   */
  getCloudProfiles(): ModelProfile[] {
    const now = Date.now();
    return Array.from(this.profiles.values())
      .filter((p) => !p.disabled && p.cooldownUntil <= now && p.modelId.endsWith(':cloud'))
      .sort((a, b) => a.priority - b.priority);
  }

  /**
   * Return all available local-model profiles sorted by priority.
   * Local = modelId does NOT end with ':cloud' and is not disabled/cooled-down.
   */
  getLocalProfiles(): ModelProfile[] {
    const now = Date.now();
    return Array.from(this.profiles.values())
      .filter((p) => !p.disabled && p.cooldownUntil <= now && !p.modelId.endsWith(':cloud'))
      .sort((a, b) => a.priority - b.priority);
  }

  /**
   * Whether a profile is a cloud model (ends with ':cloud').
   */
  isCloudProfile(profileId: string): boolean {
    const profile = this.profiles.get(profileId);
    if (!profile) return false;
    return profile.modelId.endsWith(':cloud');
  }
}
