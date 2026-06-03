/**
 * Credential Pool — manages multiple API keys per provider.
 *
 * Automatically selects between API keys based on configurable strategies:
 * - fill-first: use first active credential until cooldown, then move to next
 * - round-robin: cycle through active credentials
 * - least-used: pick credential with lowest usage count
 * - random: pick random active credential
 *
 * Kill-switch: SUDO_CREDENTIAL_POOL_DISABLE=1 falls back to first key.
 */

import { createLogger } from '../shared/logger.js';
import { randomBytes } from 'node:crypto';
import type {
  CredentialEntry,
  CredentialPoolConfig,
  SelectionStrategy,
  PoolStatus,
  AddCredentialRequest,
  SetStrategyRequest,
} from './credential-pool-types.js';

const log = createLogger('auth:credential-pool');

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: Omit<CredentialPoolConfig, 'provider'> = {
  strategy: 'fill-first',
  maxConcurrent: 10,
  cooldownMs: 60_000, // 1 minute
  maxFailsBeforeCooldown: 3,
};

// ---------------------------------------------------------------------------
// CredentialPool class
// ---------------------------------------------------------------------------

/**
 * Manages multiple API keys per provider with selectable strategies.
 *
 * Usage:
 *   const pool = CredentialPool.getInstance();
 *   pool.loadFromEnv('openai');
 *   const cred = pool.selectCredential('openai');
 *   // Use cred.key...
 *   pool.reportSuccess(cred.id);
 */
export class CredentialPool {
  private static instance: CredentialPool | null = null;

  /** Map of provider -> list of credentials. */
  private readonly pools: Map<string, CredentialEntry[]> = new Map();

  /** Map of provider -> pool configuration. */
  private readonly configs: Map<string, CredentialPoolConfig> = new Map();

  /** Map of provider -> current round-robin index. */
  private readonly roundRobinIndices: Map<string, number> = new Map();

  /** Whether pool selection is disabled via kill-switch. */
  private poolDisabled = false;

  private constructor() {
    this.checkKillSwitch();
  }

  /**
   * Get the singleton instance.
   */
  public static getInstance(): CredentialPool {
    if (!CredentialPool.instance) {
      CredentialPool.instance = new CredentialPool();
    }
    return CredentialPool.instance;
  }

  /**
   * Reset the singleton instance (for testing).
   */
  public static resetInstance(): void {
    CredentialPool.instance = null;
  }

  /**
   * Check the kill-switch environment variable.
   */
  private checkKillSwitch(): void {
    this.poolDisabled = process.env['SUDO_CREDENTIAL_POOL_DISABLE'] === '1';
    if (this.poolDisabled) {
      log.warn('Credential pool is DISABLED via kill-switch');
    }
  }

  // ---------------------------------------------------------------------------
  // Credential management
  // ---------------------------------------------------------------------------

  /**
   * Add a credential to the pool.
   *
   * @param id - Unique identifier for this credential.
   * @param provider - Provider name (e.g., 'openai', 'anthropic').
   * @param key - The API key value.
   * @param strategy - Selection strategy (defaults to pool config).
   */
  public addCredential(
    id: string,
    provider: string,
    key: string,
    strategy?: SelectionStrategy,
  ): void {
    const providerPool = this.pools.get(provider) ?? [];
    const existingIndex = providerPool.findIndex((c) => c.id === id);

    if (existingIndex >= 0) {
      log.warn({ provider, id }, 'Credential already exists, updating');
      providerPool[existingIndex].key = key;
      providerPool[existingIndex].isActive = true;
      return;
    }

    const poolConfig = this.configs.get(provider);
    const entry: CredentialEntry = {
      id,
      provider,
      key,
      isActive: true,
      successCount: 0,
      failCount: 0,
      strategy: strategy ?? poolConfig?.strategy ?? DEFAULT_CONFIG.strategy,
    };

    providerPool.push(entry);
    this.pools.set(provider, providerPool);

    // Initialize round-robin index if needed
    if (!this.roundRobinIndices.has(provider)) {
      this.roundRobinIndices.set(provider, 0);
    }

    // Set default config if not exists
    if (!this.configs.has(provider)) {
      this.configs.set(provider, {
        provider,
        ...DEFAULT_CONFIG,
      });
    }

    log.info({ provider, id }, 'Added credential to pool');
  }

  /**
   * Remove a credential from the pool.
   *
   * @param id - The credential identifier.
   * @returns True if removed, false if not found.
   */
  public removeCredential(id: string): boolean {
    for (const [provider, pool] of this.pools.entries()) {
      const index = pool.findIndex((c) => c.id === id);
      if (index >= 0) {
        pool.splice(index, 1);
        this.pools.set(provider, pool);
        log.info({ provider, id }, 'Removed credential from pool');
        return true;
      }
    }

    log.warn({ id }, 'removeCredential: unknown credential');
    return false;
  }

  /**
   * Get a credential by ID.
   *
   * @param id - The credential identifier.
   * @returns The credential or null if not found.
   */
  public getCredential(id: string): CredentialEntry | null {
    for (const pool of this.pools.values()) {
      const found = pool.find((c) => c.id === id);
      if (found) return { ...found };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Credential selection
  // ---------------------------------------------------------------------------

  /**
   * Select the best credential for a provider based on strategy.
   *
   * When pool is disabled (kill-switch), always returns first active credential.
   * Otherwise, applies the configured selection strategy.
   *
   * @param provider - Provider name.
   * @returns The selected credential, or null if none available.
   */
  public selectCredential(provider: string): CredentialEntry | null {
    const providerPool = this.pools.get(provider);

    if (!providerPool || providerPool.length === 0) {
      log.warn({ provider }, 'No credentials registered for provider');
      return null;
    }

    // Kill-switch: always return first active credential
    if (this.poolDisabled) {
      const first = providerPool.find((c) => c.isActive);
      if (!first) {
        log.error({ provider }, 'First credential inactive and pool disabled');
        return null;
      }
      return { ...first };
    }

    const config = this.configs.get(provider);
    const strategy = config?.strategy ?? DEFAULT_CONFIG.strategy;
    const now = Date.now();

    // Get active credentials (not in cooldown)
    const active = providerPool.filter(
      (c) => c.isActive && (c.cooldownUntil ?? 0) <= now,
    );

    if (active.length === 0) {
      // All credentials in cooldown - return earliest expiring
      const cooled = providerPool
        .filter((c) => c.isActive && (c.cooldownUntil ?? 0) > now)
        .sort((a, b) => (a.cooldownUntil ?? 0) - (b.cooldownUntil ?? 0));

      if (cooled.length > 0) {
        const rescued = cooled[0];
        log.warn(
          { provider, id: rescued.id, cooldownRemaining: (rescued.cooldownUntil ?? 0) - now },
          'All credentials in cooldown - force-selecting earliest',
        );
        return { ...rescued };
      }

      log.error({ provider }, 'No available credentials - all inactive');
      return null;
    }

    let selected: CredentialEntry | null = null;

    switch (strategy) {
      case 'fill-first':
        selected = this.selectFillFirst(provider, active);
        break;
      case 'round-robin':
        selected = this.selectRoundRobin(provider, active);
        break;
      case 'least-used':
        selected = this.selectLeastUsed(active);
        break;
      case 'random':
        selected = this.selectRandom(active);
        break;
    }

    if (selected) {
      log.debug(
        { provider, id: selected.id, strategy },
        'Selected credential',
      );
    }

    return selected;
  }

  /**
   * Fill-first selection: use first credential until cooldown, then next.
   */
  private selectFillFirst(
    provider: string,
    active: CredentialEntry[],
  ): CredentialEntry | null {
    // Sort by ID to ensure consistent ordering, then pick first
    const sorted = [...active].sort((a, b) => a.id.localeCompare(b.id));
    return sorted[0] ?? null;
  }

  /**
   * Round-robin selection: cycle through credentials.
   */
  private selectRoundRobin(
    provider: string,
    active: CredentialEntry[],
  ): CredentialEntry | null {
    let index = this.roundRobinIndices.get(provider) ?? 0;

    // Ensure index is within bounds
    const providerPool = this.pools.get(provider);
    if (!providerPool) return null;

    // Find the next active credential starting from current index
    let attempts = 0;
    while (attempts < providerPool.length) {
      const candidate = providerPool[index % providerPool.length];
      if (active.some((c) => c.id === candidate.id)) {
        // Update index for next call
        this.roundRobinIndices.set(provider, (index + 1) % providerPool.length);
        return { ...candidate };
      }
      index++;
      attempts++;
    }

    // Fallback to first active if round-robin fails
    return active[0] ?? null;
  }

  /**
   * Least-used selection: pick credential with lowest usage.
   */
  private selectLeastUsed(active: CredentialEntry[]): CredentialEntry | null {
    const sorted = [...active].sort(
      (a, b) => (a.successCount + a.failCount) - (b.successCount + b.failCount),
    );
    return sorted[0] ?? null;
  }

  /**
   * Random selection: pick random active credential.
   */
  private selectRandom(active: CredentialEntry[]): CredentialEntry | null {
    if (active.length === 0) return null;
    const randomIndex = Math.floor(Math.random() * active.length);
    return active[randomIndex] ?? null;
  }

  // ---------------------------------------------------------------------------
  // Success and failure reporting
  // ---------------------------------------------------------------------------

  /**
   * Report success for a credential.
   *
   * Increments success count, clears cooldown.
   *
   * @param credentialId - The credential identifier.
   */
  public reportSuccess(credentialId: string): void {
    const entry = this.findCredential(credentialId);
    if (!entry) {
      log.warn({ credentialId }, 'reportSuccess: unknown credential');
      return;
    }

    entry.successCount++;
    entry.lastUsedAt = Date.now();
    entry.cooldownUntil = undefined;
    entry.lastError = undefined;

    log.debug({ id: credentialId, successCount: entry.successCount }, 'Success reported');
  }

  /**
   * Report failure for a credential.
   *
   * Increments fail count, applies cooldown if threshold reached.
   *
   * @param credentialId - The credential identifier.
   * @param error - Error message or object.
   */
  public reportFailure(credentialId: string, error: unknown): void {
    const entry = this.findCredential(credentialId);
    if (!entry) {
      log.warn({ credentialId }, 'reportFailure: unknown credential');
      return;
    }

    const config = this.configs.get(entry.provider);
    const maxFails = config?.maxFailsBeforeCooldown ?? DEFAULT_CONFIG.maxFailsBeforeCooldown;
    const cooldownMs = config?.cooldownMs ?? DEFAULT_CONFIG.cooldownMs;

    entry.failCount++;
    entry.lastUsedAt = Date.now();
    entry.lastError = typeof error === 'string' ? error : String(error);

    if (entry.failCount >= maxFails) {
      entry.cooldownUntil = Date.now() + cooldownMs;
      log.warn(
        { id: credentialId, failCount: entry.failCount, cooldownMs, cooldownUntil: entry.cooldownUntil },
        'Credential entered cooldown',
      );
    } else {
      log.debug(
        { id: credentialId, failCount: entry.failCount, maxFails },
        'Failure reported',
      );
    }
  }

  /**
   * Find a credential by ID across all pools.
   */
  private findCredential(credentialId: string): CredentialEntry | null {
    for (const pool of this.pools.values()) {
      const found = pool.find((c) => c.id === credentialId);
      if (found) return found;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Loading from environment
  // ---------------------------------------------------------------------------

  /**
   * Load credentials from environment variables.
   *
   * Loads keys matching patterns:
   * - ${PROVIDER_UPPER}_API_KEY (single key)
   * - ${PROVIDER_UPPER}_API_KEY_1, _2, _3, etc. (multiple keys)
   *
   * @param provider - Provider name (e.g., 'openai', 'anthropic').
   * @returns Number of credentials loaded.
   */
  public loadFromEnv(provider: string): number {
    const providerUpper = provider.toUpperCase();
    const loaded: CredentialEntry[] = [];

    // Scan for numbered keys first
    let index = 1;
    while (true) {
      const keyName = `${providerUpper}_API_KEY_${index}`;
      const apiKey = process.env[keyName];

      if (!apiKey) {
        // Also check for single key without number
        if (index === 1) {
          const singleKey = process.env[`${providerUpper}_API_KEY`];
          if (singleKey) {
            const id = `${provider}-key-1`;
            this.addCredential(id, provider, singleKey);
            loaded.push(this.findCredential(id)!);
          }
        }
        break;
      }

      const id = `${provider}-key-${index}`;
      this.addCredential(id, provider, apiKey);
      loaded.push(this.findCredential(id)!);
      index++;

      // Safety cap
      if (index > 100) {
        log.warn({ provider }, 'Hit max credential limit (100)');
        break;
      }
    }

    if (loaded.length > 0) {
      log.info({ provider, count: loaded.length }, 'Loaded credentials from env');
    }

    return loaded.length;
  }

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  /**
   * Set the selection strategy for a provider pool.
   *
   * @param provider - Provider name.
   * @param strategy - New selection strategy.
   */
  public setStrategy(provider: string, strategy: SelectionStrategy): void {
    const config = this.configs.get(provider);
    if (config) {
      config.strategy = strategy;
      this.configs.set(provider, config);
    } else {
      this.configs.set(provider, {
        provider,
        ...DEFAULT_CONFIG,
        strategy,
      });
    }

    log.info({ provider, strategy }, 'Strategy updated');
  }

  /**
   * Get the current strategy for a provider.
   */
  public getStrategy(provider: string): SelectionStrategy {
    return this.configs.get(provider)?.strategy ?? DEFAULT_CONFIG.strategy;
  }

  // ---------------------------------------------------------------------------
  // Inspection and diagnostics
  // ---------------------------------------------------------------------------

  /**
   * Get status of a provider pool.
   *
   * @param provider - Provider name.
   * @returns Pool status summary.
   */
  public getPoolStatus(provider: string): PoolStatus {
    const providerPool = this.pools.get(provider) ?? [];
    const config = this.configs.get(provider);
    const now = Date.now();

    const active = providerPool.filter(
      (c) => c.isActive && (c.cooldownUntil ?? 0) <= now,
    ).length;

    const cooldown = providerPool.filter(
      (c) => c.isActive && (c.cooldownUntil ?? 0) > now,
    ).length;

    return {
      provider,
      total: providerPool.length,
      active,
      cooldown,
      strategy: config?.strategy ?? DEFAULT_CONFIG.strategy,
      roundRobinIndex: this.roundRobinIndices.get(provider),
    };
  }

  /**
   * Get status of all provider pools.
   *
   * @returns Map of provider -> PoolStatus.
   */
  public getAllStatus(): Map<string, PoolStatus> {
    const result = new Map<string, PoolStatus>();
    for (const provider of this.pools.keys()) {
      result.set(provider, this.getPoolStatus(provider));
    }
    return result;
  }

  /**
   * Get list of registered providers.
   */
  public getRegisteredProviders(): string[] {
    return Array.from(this.pools.keys());
  }

  /**
   * Get all credentials for a provider (for admin UI).
   *
   * @param provider - Provider name.
   * @returns Array of credential snapshots.
   */
  public getCredentials(provider: string): CredentialEntry[] {
    const providerPool = this.pools.get(provider);
    if (!providerPool) return [];
    return providerPool.map((c) => ({ ...c }));
  }

  /**
   * Force-reset cooldown on all credentials for a provider.
   *
   * @param provider - Provider name.
   */
  public resetProviderCooldowns(provider: string): void {
    const providerPool = this.pools.get(provider);
    if (!providerPool) return;

    let count = 0;
    for (const cred of providerPool) {
      if (cred.cooldownUntil !== undefined) {
        cred.cooldownUntil = undefined;
        count++;
      }
    }

    log.info({ provider, resetCount: count }, 'Provider cooldowns force-reset');
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/**
 * Default singleton instance for application-wide use.
 * Initialize with loadFromEnv() at startup.
 */
export const credentialPool = CredentialPool.getInstance();
