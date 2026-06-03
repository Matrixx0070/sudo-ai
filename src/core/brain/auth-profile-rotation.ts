/**
 * Auth Profile Rotation — manages multiple API keys per provider.
 *
 * Automatically rotates between API keys when rate limits or billing errors occur.
 * Keys are loaded from environment variables (e.g., OPENAI_API_KEY_1, OPENAI_API_KEY_2)
 * or from a JSON config. Each key tracks its own state and cooldown.
 *
 * Kill-switch: SUDO_AUTH_ROTATION_DISABLE=1 disables rotation (always returns first key).
 */

import { createLogger } from '../shared/logger.js';
import { LLMError } from '../shared/errors.js';

const log = createLogger('brain:auth-rotation');

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

/** Error categories that trigger key rotation. */
export type AuthErrorCategory = 'rate_limit' | 'billing_error' | 'auth_invalid' | 'unknown';

/** State of an API key profile. */
export type AuthProfileState =
  | 'active'
  | 'rate_limited'
  | 'billing_error'
  | 'auth_invalid'
  | 'disabled';

/** Runtime state of a single API key profile. */
export interface AuthProfile {
  /** Unique identifier for this key (e.g., 'openai-key-1'). */
  keyId: string;
  /** The actual API key value. */
  apiKey: string;
  /** Provider name (e.g., 'openai', 'anthropic'). */
  provider: string;
  /** Current state of this key. */
  state: AuthProfileState;
  /** Unix ms timestamp after which this key is eligible again. 0 = no cooldown. */
  cooldownUntil: number;
  /** Count of consecutive errors since last success. */
  consecutiveErrors: number;
  /** Whether this key is permanently disabled. */
  disabled: boolean;
}

/** Configuration for auth profile rotation. */
export interface AuthRotationConfig {
  /** Cooldown durations for rate limit errors (ms), indexed by consecutive failures. */
  rateLimitCooldowns: readonly number[];
  /** Cooldown durations for billing errors (ms), indexed by consecutive failures. */
  billingCooldowns: readonly number[];
  /** Cooldown durations for auth invalid errors (ms), indexed by consecutive failures. */
  authCooldowns: readonly number[];
}

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: AuthRotationConfig = {
  rateLimitCooldowns: [
    60_000,    // 1 min
    300_000,   // 5 min
    900_000,   // 15 min
    1_800_000, // 30 min max
  ] as const,
  billingCooldowns: [
    300_000,   // 5 min
    900_000,   // 15 min
    1_800_000, // 30 min
    3_600_000, // 1 hour max
  ] as const,
  authCooldowns: [
    60_000,    // 1 min
    300_000,   // 5 min
    900_000,   // 15 min
    1_800_000, // 30 min max
  ] as const,
};

// ---------------------------------------------------------------------------
// AuthProfileRotation class
// ---------------------------------------------------------------------------

/**
 * Manages multiple API keys per provider with automatic rotation on errors.
 *
 * Usage:
 *   const rotation = AuthProfileRotation.getInstance();
 *   const profile = rotation.getNextKey('openai');
 *   // Use profile.apiKey...
 *   rotation.reportError('openai', profile.keyId, 'rate_limit');
 */
export class AuthProfileRotation {
  private static instance: AuthProfileRotation | null = null;

  /** Map of provider -> list of auth profiles. */
  private readonly profiles: Map<string, AuthProfile[]> = new Map();

  /** Configuration for cooldown schedules. */
  private readonly config: AuthRotationConfig;

  /** Whether rotation is disabled via kill-switch. */
  private rotationDisabled = false;

  private constructor(config: AuthRotationConfig = DEFAULT_CONFIG) {
    this.config = config;
    this.checkKillSwitch();
  }

  /**
   * Get the singleton instance.
   *
   * @param config - Optional custom configuration.
   */
  public static getInstance(config?: AuthRotationConfig): AuthProfileRotation {
    if (!AuthProfileRotation.instance) {
      AuthProfileRotation.instance = new AuthProfileRotation(config);
    }
    return AuthProfileRotation.instance;
  }

  /**
   * Reset the singleton instance (for testing).
   */
  public static resetInstance(): void {
    AuthProfileRotation.instance = null;
  }

  /**
   * Check the kill-switch environment variable.
   */
  private checkKillSwitch(): void {
    this.rotationDisabled = process.env['SUDO_AUTH_ROTATION_DISABLE'] === '1';
    if (this.rotationDisabled) {
      log.warn('Auth profile rotation is DISABLED via kill-switch');
    }
  }

  // ---------------------------------------------------------------------------
  // Key loading and registration
  // ---------------------------------------------------------------------------

  /**
   * Load API keys from environment variables.
   *
   * Loads keys matching the pattern: ${PROVIDER_UPPER}_API_KEY_N
   * e.g., OPENAI_API_KEY_1, OPENAI_API_KEY_2, ANTHROPIC_API_KEY_1
   *
   * @param provider - Provider name (e.g., 'openai', 'anthropic').
   * @returns Number of keys loaded.
   */
  public loadKeysFromEnv(provider: string): number {
    const providerUpper = provider.toUpperCase();
    const loaded: AuthProfile[] = [];

    // Scan for numbered keys: ${PROVIDER}_API_KEY_1, _2, _3, etc.
    let index = 1;
    while (true) {
      const keyName = `${providerUpper}_API_KEY_${index}`;
      const apiKey = process.env[keyName];

      if (!apiKey) {
        // Also check for single key without number
        if (index === 1) {
          const singleKey = process.env[`${providerUpper}_API_KEY`];
          if (singleKey) {
            loaded.push(this.createProfile(provider, singleKey, index));
          }
        }
        break;
      }

      loaded.push(this.createProfile(provider, apiKey, index));
      index++;

      // Safety cap to prevent infinite loops
      if (index > 100) {
        log.warn({ provider, count: index }, 'Hit max key limit (100)');
        break;
      }
    }

    if (loaded.length > 0) {
      this.profiles.set(provider, loaded);
      log.info({ provider, count: loaded.length }, 'Loaded API keys from env');
    }

    return loaded.length;
  }

  /**
   * Register API keys programmatically (e.g., from JSON config).
   *
   * @param provider - Provider name.
   * @param keys - Array of API key objects with keyId and apiKey.
   */
  public registerKeys(
    provider: string,
    keys: Array<{ keyId?: string; apiKey: string }>,
  ): void {
    const loaded = keys.map((k, i) =>
      this.createProfile(provider, k.apiKey, i + 1, k.keyId),
    );

    this.profiles.set(provider, loaded);
    log.info({ provider, count: loaded.length }, 'Registered API keys');
  }

  /**
   * Create an AuthProfile instance.
   */
  private createProfile(
    provider: string,
    apiKey: string,
    index: number,
    explicitKeyId?: string,
  ): AuthProfile {
    const keyId = explicitKeyId ?? `${provider}-key-${index}`;
    return {
      keyId,
      apiKey,
      provider,
      state: 'active' as AuthProfileState,
      cooldownUntil: 0,
      consecutiveErrors: 0,
      disabled: false,
    };
  }

  // ---------------------------------------------------------------------------
  // Key selection
  // ---------------------------------------------------------------------------

  /**
   * Get the next available API key for a provider.
   *
   * When rotation is disabled (kill-switch), always returns the first key.
   * Otherwise, returns the first active key (not in cooldown, not disabled).
   * If all keys are in cooldown, returns the one expiring soonest.
   *
   * @param provider - Provider name.
   * @returns The selected AuthProfile, or null if no keys available.
   */
  public getNextKey(provider: string): AuthProfile | null {
    const providerKeys = this.profiles.get(provider);

    if (!providerKeys || providerKeys.length === 0) {
      log.warn({ provider }, 'No API keys registered for provider');
      return null;
    }

    // Kill-switch: always return first key
    if (this.rotationDisabled) {
      const first = providerKeys[0];
      if (first.disabled) {
        log.error({ provider }, 'First key is disabled and rotation is disabled');
        return null;
      }
      return first;
    }

    const now = Date.now();

    // Find active keys (not disabled, not in cooldown)
    const available = providerKeys
      .filter((p) => !p.disabled && p.cooldownUntil <= now)
      .sort((a, b) => {
        // Prefer active keys, then by error count (fewer is better)
        if (a.state === 'active' && b.state !== 'active') return -1;
        if (b.state === 'active' && a.state !== 'active') return 1;
        return a.consecutiveErrors - b.consecutiveErrors;
      });

    if (available.length === 0) {
      // All keys are disabled or in cooldown
      const cooledDown = providerKeys
        .filter((p) => !p.disabled && p.cooldownUntil > now)
        .sort((a, b) => a.cooldownUntil - b.cooldownUntil);

      if (cooledDown.length > 0) {
        // Force-reset the key expiring soonest
        const rescued = cooledDown[0];
        const remainingMs = rescued.cooldownUntil - now;
        log.warn(
          { keyId: rescued.keyId, remainingMs, consecutiveErrors: rescued.consecutiveErrors },
          'All keys in cooldown — force-resetting earliest to allow retry',
        );
        rescued.cooldownUntil = 0;
        rescued.state = 'active';
        return rescued;
      }

      // Truly no usable keys
      log.error({ provider }, 'No available API keys — all are disabled');
      return null;
    }

    const selected = available[0];
    log.debug(
      { provider, keyId: selected.keyId, state: selected.state },
      'Selected API key',
    );
    return selected;
  }

  // ---------------------------------------------------------------------------
  // Error and success reporting
  // ---------------------------------------------------------------------------

  /**
   * Report an error for a specific API key.
   *
   * Applies the appropriate cooldown based on error category.
   *
   * @param provider - Provider name.
   * @param keyId - The key identifier.
   * @param errorCategory - The error category ('rate_limit', 'billing_error', 'auth_invalid').
   */
  public reportError(
    provider: string,
    keyId: string,
    errorCategory: AuthErrorCategory,
  ): void {
    const providerKeys = this.profiles.get(provider);
    if (!providerKeys) {
      log.warn({ provider, keyId }, 'reportError: no keys registered');
      return;
    }

    const profile = providerKeys.find((p) => p.keyId === keyId);
    if (!profile) {
      log.warn({ provider, keyId }, 'reportError: unknown keyId');
      return;
    }

    profile.consecutiveErrors += 1;
    const errorCount = profile.consecutiveErrors;
    const now = Date.now();

    // Determine cooldown schedule and state based on error category
    let cooldownMs: number;
    let newState: AuthProfileState;

    switch (errorCategory) {
      case 'rate_limit':
        cooldownMs = this.getCooldown(
          this.config.rateLimitCooldowns,
          errorCount,
        );
        newState = 'rate_limited';
        break;

      case 'billing_error':
        cooldownMs = this.getCooldown(
          this.config.billingCooldowns,
          errorCount,
        );
        newState = 'billing_error';
        break;

      case 'auth_invalid':
        cooldownMs = this.getCooldown(
          this.config.authCooldowns,
          errorCount,
        );
        newState = 'auth_invalid';
        // Auth errors may indicate permanently invalid key
        if (errorCount >= 3) {
          profile.disabled = true;
          log.error(
            { provider, keyId, errorCount },
            'Key disabled after 3 auth_invalid errors',
          );
          return;
        }
        break;

      default:
        // Unknown errors get a short cooldown
        cooldownMs = this.config.rateLimitCooldowns[0];
        newState = 'active';
    }

    profile.cooldownUntil = now + cooldownMs;
    profile.state = newState;

    log.warn(
      { provider, keyId, errorCategory, errorCount, cooldownMs, cooldownUntil: profile.cooldownUntil },
      'Error reported for API key',
    );
  }

  /**
   * Report success for a specific API key.
   *
   * Resets the consecutive error count and clears cooldown.
   *
   * @param provider - Provider name.
   * @param keyId - The key identifier.
   */
  public reportSuccess(provider: string, keyId: string): void {
    const providerKeys = this.profiles.get(provider);
    if (!providerKeys) {
      log.warn({ provider, keyId }, 'reportSuccess: no keys registered');
      return;
    }

    const profile = providerKeys.find((p) => p.keyId === keyId);
    if (!profile) {
      log.warn({ provider, keyId }, 'reportSuccess: unknown keyId');
      return;
    }

    const hadErrors = profile.consecutiveErrors > 0;
    profile.consecutiveErrors = 0;
    profile.cooldownUntil = 0;
    profile.state = 'active';

    if (hadErrors) {
      log.info({ provider, keyId }, 'API key recovered — error count reset');
    } else {
      log.debug({ provider, keyId }, 'Success recorded');
    }
  }

  /**
   * Get the cooldown duration for a given error count.
   */
  private getCooldown(schedule: readonly number[], errorCount: number): number {
    const index = Math.min(errorCount - 1, schedule.length - 1);
    return schedule[index];
  }

  // ---------------------------------------------------------------------------
  // Inspection and diagnostics
  // ---------------------------------------------------------------------------

  /**
   * Check if a specific key is currently in cooldown.
   *
   * @param provider - Provider name.
   * @param keyId - The key identifier.
   */
  public isKeyInCooldown(provider: string, keyId: string): boolean {
    const providerKeys = this.profiles.get(provider);
    if (!providerKeys) return false;

    const profile = providerKeys.find((p) => p.keyId === keyId);
    if (!profile) return false;

    return profile.cooldownUntil > Date.now();
  }

  /**
   * Get remaining cooldown in milliseconds for a key.
   *
   * @param provider - Provider name.
   * @param keyId - The key identifier.
   */
  public getCooldownRemaining(provider: string, keyId: string): number {
    const providerKeys = this.profiles.get(provider);
    if (!providerKeys) return 0;

    const profile = providerKeys.find((p) => p.keyId === keyId);
    if (!profile || profile.cooldownUntil === 0) return 0;

    return Math.max(0, profile.cooldownUntil - Date.now());
  }

  /**
   * Get status of all keys for a provider.
   *
   * @param provider - Provider name.
   * @returns Array of AuthProfile snapshots.
   */
  public getStatus(provider: string): AuthProfile[] {
    const providerKeys = this.profiles.get(provider);
    if (!providerKeys) return [];

    return providerKeys.map((p) => ({ ...p }));
  }

  /**
   * Get status of all providers.
   *
   * @returns Map of provider -> AuthProfile snapshots.
   */
  public getAllStatus(): Map<string, AuthProfile[]> {
    const result = new Map<string, AuthProfile[]>();
    for (const [provider, keys] of this.profiles) {
      result.set(provider, keys.map((p) => ({ ...p })));
    }
    return result;
  }

  /**
   * Force-reset cooldowns on all keys for a provider.
   *
   * @param provider - Provider name.
   */
  public resetProviderCooldowns(provider: string): void {
    const providerKeys = this.profiles.get(provider);
    if (!providerKeys) return;

    let count = 0;
    for (const profile of providerKeys) {
      if (!profile.disabled && (profile.cooldownUntil > 0 || profile.consecutiveErrors > 0)) {
        profile.cooldownUntil = 0;
        profile.consecutiveErrors = 0;
        profile.state = 'active';
        count++;
      }
    }

    log.info({ provider, resetCount: count }, 'Provider cooldowns force-reset');
  }

  /**
   * Get the list of registered providers.
   */
  public getRegisteredProviders(): string[] {
    return Array.from(this.profiles.keys());
  }

  /**
   * Get the API key value for a specific keyId.
   *
   * WARNING: Use this carefully. The keyId should be validated.
   *
   * @param provider - Provider name.
   * @param keyId - The key identifier.
   * @returns The API key value, or null if not found.
   */
  public getApiKey(provider: string, keyId: string): string | null {
    const providerKeys = this.profiles.get(provider);
    if (!providerKeys) return null;

    const profile = providerKeys.find((p) => p.keyId === keyId);
    return profile?.apiKey ?? null;
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/**
 * Default singleton instance for application-wide use.
 * Initialize with loadKeysFromEnv() or registerKeys() at startup.
 */
export const authProfileRotation = AuthProfileRotation.getInstance();
