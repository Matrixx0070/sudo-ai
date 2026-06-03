/**
 * Credential Pool — Type definitions.
 *
 * Types for managing multiple API keys per provider with selection strategies.
 */

// ---------------------------------------------------------------------------
// Selection strategies
// ---------------------------------------------------------------------------

/** Strategy for selecting which credential to use from the pool. */
export type SelectionStrategy =
  | 'fill-first'    // Use first active credential until cooldown, then move to next
  | 'round-robin'   // Cycle through active credentials in order
  | 'least-used'    // Pick credential with lowest (successCount + failCount)
  | 'random';       // Pick random active credential

// ---------------------------------------------------------------------------
// Credential entry
// ---------------------------------------------------------------------------

/** Runtime state of a single API credential. */
export interface CredentialEntry {
  /** Unique identifier for this credential (e.g., 'openai-key-1'). */
  id: string;
  /** Provider name (e.g., 'openai', 'anthropic', 'google'). */
  provider: string;
  /** The actual API key value. */
  key: string;
  /** Whether this credential is currently active. */
  isActive: boolean;
  /** Unix ms timestamp of last successful use. */
  lastUsedAt?: number;
  /** Last error message encountered (for debugging). */
  lastError?: string;
  /** Unix ms timestamp after which this credential is eligible again. */
  cooldownUntil?: number;
  /** Count of successful uses. */
  successCount: number;
  /** Count of failed uses. */
  failCount: number;
  /** Selection strategy for this specific credential's provider pool. */
  strategy: SelectionStrategy;
  /** Index for round-robin tracking within provider pool. */
  roundRobinIndex?: number;
}

// ---------------------------------------------------------------------------
// Pool configuration
// ---------------------------------------------------------------------------

/** Configuration for a credential pool. */
export interface CredentialPoolConfig {
  /** Provider name this pool manages. */
  provider: string;
  /** Selection strategy for this pool. */
  strategy: SelectionStrategy;
  /** Maximum concurrent requests allowed with credentials from this pool. */
  maxConcurrent: number;
  /** Cooldown duration in milliseconds after a failure. */
  cooldownMs: number;
  /** Number of failures before triggering cooldown. */
  maxFailsBeforeCooldown: number;
}

// ---------------------------------------------------------------------------
// Pool status
// ---------------------------------------------------------------------------

/** Status summary for a credential pool. */
export interface PoolStatus {
  /** Provider name. */
  provider: string;
  /** Total credentials in pool. */
  total: number;
  /** Number of active (not in cooldown) credentials. */
  active: number;
  /** Number of credentials currently in cooldown. */
  cooldown: number;
  /** Current selection strategy. */
  strategy: SelectionStrategy;
  /** Current round-robin index (if applicable). */
  roundRobinIndex?: number;
}

// ---------------------------------------------------------------------------
// Add credential request
// ---------------------------------------------------------------------------

/** Request body for adding a credential. */
export interface AddCredentialRequest {
  /** Unique identifier for this credential. */
  id: string;
  /** The API key value. */
  key: string;
}

// ---------------------------------------------------------------------------
// Set strategy request
// ---------------------------------------------------------------------------

/** Request body for setting pool strategy. */
export interface SetStrategyRequest {
  /** New selection strategy. */
  strategy: SelectionStrategy;
}
