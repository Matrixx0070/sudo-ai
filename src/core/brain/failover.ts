/**
 * Model failover and cooldown management system.
 *
 * Maintains a runtime registry of ModelProfile objects.
 * On error: applies exponential cooldown per error category.
 * On success: resets consecutive error count.
 * getNextProfile() always returns the highest-priority available model.
 */

import { categorizeError, LLMError } from '../shared/errors.js';
import { TRANSIENT_COOLDOWN, BILLING_COOLDOWN, AUTH_COOLDOWN } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';
import type { ModelProfile, ErrorCategory } from './types.js';

export type { ErrorCategory };

const log = createLogger('brain:failover');

/**
 * Model IDs whose provider endpoint rejects/mishandles multimodal image
 * input. Sending them an image previously wasn't skipped — it was tried,
 * errored with an uncategorized "format" failure, and cooled the profile
 * down, which also degraded its plain-text reliability for unrelated
 * callers. getNextProfile({ requireVision: true }) skips these instead.
 */
const NON_VISION_MODEL_IDS: ReadonlySet<string> = new Set([
  'ollama/glm-5.2:cloud',
  'ollama/deepseek-v4-pro:cloud',
  'ollama/kimi-k2.7-code:cloud',
]);

/**
 * Absolute last-resort profile(s) for the cron heartbeat / background ticks.
 * A 2026-07-25 incident had system.heartbeat report "all profiles exhausted"
 * for 4+ hours because the primary + fallback chain all hit cooldown/disable
 * at once with nothing left to retry sooner than their normal (up to 30min
 * auth / 10min billing) backoff ceilings. This model gets a much shorter,
 * fixed cooldown cap instead of an unlimited exemption — it's a BILLED
 * ollama:cloud model (~$0.057/call, see project history), so a true never-
 * cooldown exemption during a real outage would mean paying for a retry
 * every tick indefinitely. A 60s cap bounds that cost while still giving the
 * heartbeat a provider to retry against within a minute instead of hours.
 */
const LAST_RESORT_MODEL_IDS: ReadonlySet<string> = new Set([
  'ollama/glm-5.2:cloud',
]);
const LAST_RESORT_COOLDOWN_CAP_MS = 60_000;

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
 * Recoverable auth failures (401 — invalid/expired/revoked credential). Unlike
 * 403 (auth_permanent → disable), a 401 can clear once the token is refreshed
 * or re-authenticated, so we park the profile on a long, escalating cooldown
 * rather than disabling it or treating it as a transient blip.
 */
const AUTH_CATEGORIES = new Set<ErrorCategory>(['auth']);

/**
 * Additive jitter applied to scheduled cooldowns: the final wait is
 * base .. base*(1+JITTER_RATIO). Jitter only ever LENGTHENS the wait, so we
 * never retry sooner than the schedule, while still de-synchronizing retries
 * across profiles to avoid a thundering-herd storm.
 */
const JITTER_RATIO = 0.2;

/** Minimum gap between force-rescues of the same profile (thundering-herd guard). */
const MIN_RESCUE_INTERVAL_MS = 30_000;

/**
 * Hard cap on a server-provided Retry-After, so a pathological/huge value can't
 * wedge a model out of rotation indefinitely.
 */
const MAX_RETRY_AFTER_MS = 3_600_000; // 1 hour

/** Structured classification of an ErrorCategory for retry strategy + observability. */
export type ErrorClass = 'transient' | 'billing' | 'permanent' | 'auth' | 'other';

/**
 * ADR 0003: account-scoped error classes propagate cooldowns across the
 * credential failure domain (= provider). Default ON; SUDO_FAILOVER_DOMAINS=0
 * restores strictly per-profile behavior. Read at call time so a runtime env
 * flip (and tests) take effect without restart.
 */
function domainPropagationEnabled(): boolean {
  return process.env['SUDO_FAILOVER_DOMAINS'] !== '0';
}

/** Optional inputs to recordError(). */
export interface RecordErrorOptions {
  /** Server-provided Retry-After in ms (parsed from the response header/body), if any. */
  retryAfterMs?: number;
  /** Injectable RNG for deterministic tests. Defaults to Math.random. */
  rng?: () => number;
  /** Per-profile salt derived from profileId hash to de-sync jitter across simultaneously-failing profiles. */
  profileSeed?: number;
}

// ---------------------------------------------------------------------------
// ModelFailover class
// ---------------------------------------------------------------------------

/** Manages LLM model selection and per-model cooldown state. */
export class ModelFailover {
  private readonly profiles: Map<string, ModelProfile> = new Map();
  /** GW-2: optional sustained-failover notice monitor (observation only). */
  private failoverMonitor: import('./failover-notice.js').SustainedFailoverMonitor | null = null;

  /**
   * GW-2: attach a monitor that fires ONE operator notice on sustained
   * degradation (see failover-notice.ts). Null default → no behavior change.
   */
  setSustainedFailoverMonitor(
    monitor: import('./failover-notice.js').SustainedFailoverMonitor | null,
  ): void {
    this.failoverMonitor = monitor;
  }

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

      // 'xai-oauth' and 'grok-web' are served ONLY by the IR transport
      // (src/llm/transport.ts) — legacy getModel() has no such provider and keeps
      // throwing for them, which is fine: brain routes them through the transport
      // unconditionally (F97: every model is IR-served; grok-web/* short-circuits in
      // callIR before the wire path). Rejecting them HERE crash-looped prod when
      // xai-oauth was added to models.primary (2026-07-14) and grok-web (2026-07-25).
      const validProviders = ['xai', 'openai', 'anthropic', 'claude-oauth', 'xai-oauth', 'grok-web', 'google', 'groq', 'mistral', 'deepseek', 'ollama', 'together'];
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
        // ADR 0003: every credential is per-provider today, so the provider IS
        // the failure domain.
        domain: provider,
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

    // Derive a per-profile phase from profileId to de-sync jitter across concurrent failures
    let _phash = 0;
    for (let i = 0; i < profileId.length; i++) {
      _phash = ((_phash * 31) + profileId.charCodeAt(i)) >>> 0;
    }
    const profileSeed = opts.profileSeed ?? _phash;
    const saltedOpts = { ...opts, profileSeed };

    const isLastResort = LAST_RESORT_MODEL_IDS.has(profileId);
    const capCooldown = (ms: number): number => isLastResort ? Math.min(ms, LAST_RESORT_COOLDOWN_CAP_MS) : ms;

    if (PERMANENT_CATEGORIES.has(category)) {
      // Last-resort never permanently disables — an auth_permanent misfire on
      // the one model the heartbeat is guaranteed to have would otherwise park
      // it until a manual recordSuccess, defeating the point of "last resort".
      if (isLastResort) {
        profile.cooldownUntil = now + LAST_RESORT_COOLDOWN_CAP_MS;
        profile.cooldownClass = 'auth';
        log.warn(
          { profileId, category },
          'Last-resort profile hit a permanent-category error — short cooldown instead of disabling',
        );
        this._propagateToDomain(profile, 'auth', errorCount, saltedOpts, now);
        return;
      }
      profile.disabled = true;
      log.error(
        { profileId, category },
        'Profile permanently disabled due to auth_permanent error',
      );
      // ADR 0003: the credential is shared — park (don't disable) the domain
      // siblings so the chain skips straight to the next domain without
      // burning a wire call each, while staying self-healing if the 403 was
      // model-scoped or the account block lifts.
      this._propagateToDomain(profile, 'auth', errorCount, saltedOpts, now);
      return;
    }

    if (BILLING_CATEGORIES.has(category)) {
      const cooldownMs = capCooldown(this._cooldownMs(BILLING_COOLDOWN, errorCount, saltedOpts));
      profile.cooldownUntil = now + cooldownMs;
      profile.cooldownClass = 'billing';
      log.warn(
        { profileId, category, errClass: 'billing', errorCount, cooldownMs, retryAfterMs: opts.retryAfterMs, cooldownUntil: profile.cooldownUntil },
        'Billing cooldown applied',
      );
      this._propagateToDomain(profile, 'billing', errorCount, saltedOpts, now);
      return;
    }

    if (AUTH_CATEGORIES.has(category)) {
      const cooldownMs = capCooldown(this._cooldownMs(AUTH_COOLDOWN, errorCount, saltedOpts));
      profile.cooldownUntil = now + cooldownMs;
      profile.cooldownClass = 'auth';
      log.warn(
        { profileId, category, errClass: 'auth', errorCount, cooldownMs, retryAfterMs: opts.retryAfterMs },
        'Auth cooldown applied — token invalid/expired; parking profile until re-auth (fallback serves)',
      );
      this._propagateToDomain(profile, 'auth', errorCount, saltedOpts, now);
      return;
    }

    if (TRANSIENT_CATEGORIES.has(category)) {
      const cooldownMs = capCooldown(this._cooldownMs(TRANSIENT_COOLDOWN, errorCount, saltedOpts));
      profile.cooldownUntil = now + cooldownMs;
      profile.cooldownClass = 'transient';
      log.warn(
        { profileId, category, errClass: 'transient', errorCount, cooldownMs, retryAfterMs: opts.retryAfterMs },
        'Transient cooldown applied',
      );
      return;
    }

    // format / model_not_found / session_expired / auth (non-permanent):
    // Apply a short transient cooldown (first slot) to avoid hammering.
    const cooldownMs = capCooldown(this._cooldownMs(TRANSIENT_COOLDOWN, 1, saltedOpts));
    profile.cooldownUntil = now + cooldownMs;
    profile.cooldownClass = 'other';
    log.warn(
      { profileId, category, errClass: 'other', errorCount, cooldownMs, retryAfterMs: opts.retryAfterMs },
      'Non-categorized error — short cooldown applied',
    );
  }

  /**
   * ADR 0003: park every OTHER profile in the erroring profile's credential
   * domain on an account-scoped cooldown. The cooldown escalates with the
   * SOURCE profile's consecutive-error count (the evidence is about the shared
   * credential, not the sibling models — siblings' own error counters are not
   * touched), never shortens an existing cooldown, and respects the
   * last-resort cap. Disabled siblings are left alone.
   */
  private _propagateToDomain(
    source: ModelProfile,
    errClass: 'auth' | 'billing',
    errorCount: number,
    opts: RecordErrorOptions,
    now: number,
  ): void {
    if (!domainPropagationEnabled()) return;
    const schedule = errClass === 'billing' ? BILLING_COOLDOWN : AUTH_COOLDOWN;
    const affected: string[] = [];
    for (const sibling of this.profiles.values()) {
      if (sibling.domain !== source.domain || sibling.id === source.id || sibling.disabled) continue;
      // Per-sibling seed so propagated cooldowns stay de-synchronized.
      let hash = 0;
      for (let i = 0; i < sibling.id.length; i++) {
        hash = ((hash * 31) + sibling.id.charCodeAt(i)) >>> 0;
      }
      let ms = this._cooldownMs(schedule, errorCount, { ...opts, profileSeed: opts.rng ? opts.profileSeed : hash });
      if (LAST_RESORT_MODEL_IDS.has(sibling.id)) ms = Math.min(ms, LAST_RESORT_COOLDOWN_CAP_MS);
      const until = now + ms;
      if (until > sibling.cooldownUntil) {
        sibling.cooldownUntil = until;
        sibling.cooldownClass = errClass;
        affected.push(sibling.id);
      }
    }
    if (affected.length > 0) {
      log.warn(
        { domain: source.domain, sourceProfileId: source.id, errClass, errorCount, affectedProfiles: affected },
        'Account-scoped error — cooldown propagated across credential domain',
      );
    }
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
    const rVal = Math.max(0, Math.min(1, rng()));
    // Only mix profileSeed phase when using the default RNG — injected RNGs (tests) control jitter exactly.
    const phase = (!opts.rng && opts.profileSeed !== undefined) ? ((opts.profileSeed >>> 0) % 1000) / 1000 : 0;
    // Additive jitter: base .. base*(1 + JITTER_RATIO). Never below base.
    let ms = base + base * JITTER_RATIO * Math.max(0, Math.min(1, rVal + phase));
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
    if (AUTH_CATEGORIES.has(category)) return 'auth';
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
    delete profile.cooldownClass;
    profile.lastUsed = Date.now();

    if (hadErrors) {
      log.info({ profileId }, 'Profile recovered — error count reset');
    } else {
      log.debug({ profileId }, 'Success recorded');
    }

    // ADR 0003: a working call proves the shared credential works — clear
    // domain siblings' ACCOUNT-scoped cooldowns (auth/billing). Transient
    // cooldowns are evidence about those models, not the credential, and
    // disabled profiles stay disabled (per-profile, permanent, as before).
    if (domainPropagationEnabled()) {
      const recovered: string[] = [];
      for (const sibling of this.profiles.values()) {
        if (sibling.domain !== profile.domain || sibling.id === profile.id || sibling.disabled) continue;
        if (sibling.cooldownUntil > 0 && (sibling.cooldownClass === 'auth' || sibling.cooldownClass === 'billing')) {
          sibling.cooldownUntil = 0;
          delete sibling.cooldownClass;
          recovered.push(sibling.id);
        }
      }
      if (recovered.length > 0) {
        log.info(
          { domain: profile.domain, sourceProfileId: profile.id, recoveredProfiles: recovered },
          'Domain success — account-scoped cooldowns cleared across credential domain',
        );
      }
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
   * @param opts.requireVision - when true, profiles in {@link NON_VISION_MODEL_IDS}
   *   are excluded entirely (never tried, never force-rescued) instead of
   *   being attempted and cooled down on a predictable format error.
   * @returns The selected ModelProfile, or null when ALL profiles are permanently disabled.
   */
  getNextProfile(opts?: { requireVision?: boolean }): ModelProfile | null {
    const now = Date.now();
    const visionOk = (p: ModelProfile): boolean =>
      !opts?.requireVision || !NON_VISION_MODEL_IDS.has(p.id);

    const available = Array.from(this.profiles.values())
      .filter((p) => !p.disabled && p.cooldownUntil <= now && visionOk(p))
      .sort((a, b) => a.priority - b.priority);

    if (available.length === 0) {
      // All profiles are either disabled or in cooldown.
      // Check if any non-disabled profiles exist — if so, force-reset the one
      // with the shortest remaining cooldown so we can attempt a retry.
      const cooledDown = Array.from(this.profiles.values())
        .filter((p) => !p.disabled && p.cooldownUntil > now && visionOk(p))
        .sort((a, b) => a.cooldownUntil - b.cooldownUntil);

      if (cooledDown.length > 0) {
        const rescued = cooledDown[0];
        const remainingMs = rescued.cooldownUntil - now;
        if (!rescued.lastRescuedAt || now - rescued.lastRescuedAt >= MIN_RESCUE_INTERVAL_MS) {
          rescued.lastRescuedAt = now;
          log.warn(
            { profileId: rescued.id, remainingMs, consecutiveErrors: rescued.consecutiveErrors },
            'All profiles in cooldown — force-resetting earliest to allow retry',
          );
          rescued.cooldownUntil = 0;
          // Keep consecutiveErrors so the next failure still escalates properly.
          return rescued;
        }
        // Rescue rate-limited — caller must back off until cooldown expires naturally
        log.warn(
          { profileId: rescued.id, remainingMs, lastRescuedAt: rescued.lastRescuedAt },
          'All profiles in cooldown; rescue rate-limited — returning null for caller back-off',
        );
        return null;
      }

      // Truly no usable profiles — all are permanently disabled.
      throw new Error('All model profiles permanently disabled — no LLM available');
    }

    const selected = available[0];
    log.debug(
      { profileId: selected.id, priority: selected.priority },
      'Selected model profile',
    );
    // GW-2: feed the sustained-failover monitor (priority 0 = primary).
    this.failoverMonitor?.noteSelection(selected.id, selected.priority === 0);
    return selected;
  }

  /**
   * Promote a registered model to the top of the failover order (priority 0);
   * the remaining profiles keep their relative order behind it. Without this,
   * runtime /model switching would only steer smart routing while the
   * sequential failover path kept starting from the boot-time primary.
   */
  setPrimary(modelString: string): void {
    const target = this.profiles.get(modelString);
    if (!target) {
      log.warn({ modelString }, 'setPrimary: model not registered — failover order unchanged');
      return;
    }
    const ordered = Array.from(this.profiles.values()).sort((a, b) => a.priority - b.priority);
    let next = 1;
    for (const profile of ordered) {
      profile.priority = profile === target ? 0 : next++;
    }
    log.info({ modelString }, 'Failover order rebased — model promoted to primary');
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
        delete profile.cooldownClass;
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
