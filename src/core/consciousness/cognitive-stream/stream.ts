/**
 * @file stream.ts
 * @description CognitiveStream — the autonomous inner thought loop for SUDO-AI v4.
 *
 * Runs a background setInterval generating micro/medium/deep thoughts at
 * configurable cadences. Never throws to the event loop — all tick errors are
 * caught, logged, and swallowed. Dependencies are duck-typed to avoid circular
 * imports.
 */

import { createLogger } from '../../shared/logger.js';
import type { ConsciousnessDB } from '../consciousness-db.js';
import type { ThoughtTier } from '../types.js';
import { getRecentThoughts } from './store.js';
import { executeTick, resolveTier } from './tick.js';
import type {
  ThoughtConfig,
  StreamState,
  InterruptResult,
  StreamBrainLike,
  BodyStateLike,
  SpreadingActivationLike,
  EmotionalStateLike,
  StreamThought,
} from './types.js';

const log = createLogger('consciousness:cognitive-stream');

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: ThoughtConfig = {
  microIntervalMs: 30_000,
  mediumEveryN: 10,
  deepEveryN: 120,
  microModel: '',
  mediumModel: '',
  deepModel: '',
  maxMicroTokens: 80,
  maxMediumTokens: 300,
  maxDeepTokens: 1_500,
};

/** Thoughts kept in the hot in-memory cache. */
const CACHE_SIZE = 20;
/** Thoughts shown by getCurrentContext(). */
const CONTEXT_WINDOW = 5;

// ---------------------------------------------------------------------------
// CognitiveStream
// ---------------------------------------------------------------------------

/**
 * Autonomous inner thought loop for SUDO-AI v4.
 *
 * Usage:
 * ```ts
 * const stream = new CognitiveStream(brain, db, embodied, spreading, emotional);
 * stream.start();
 * const ctx = stream.getCurrentContext();    // inject into system prompt
 * const snap = await stream.interrupt(userId, msg);
 * stream.stop();
 * ```
 */
export class CognitiveStream {
  private readonly _brain: StreamBrainLike;
  private readonly _cdb: ConsciousnessDB;
  private readonly _embodied: BodyStateLike;
  private readonly _spreading: SpreadingActivationLike;
  private readonly _emotional: EmotionalStateLike;
  private readonly _config: ThoughtConfig;

  /** Newest-at-end hot cache. */
  private readonly _cache: StreamThought[] = [];

  private _tickCount = 0;
  private _thoughtCount = 0;
  private _lastThoughtAt: string | null = null;
  private _currentThought: StreamThought | null = null;
  private _currentTier: ThoughtTier = 'micro';
  private _isRunning = false;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _ticking = false;

  constructor(
    brain: StreamBrainLike,
    db: ConsciousnessDB,
    embodiedState: BodyStateLike,
    spreadingActivation: SpreadingActivationLike,
    emotionalState: EmotionalStateLike,
    config: Partial<ThoughtConfig> = {},
  ) {
    if (!brain || typeof brain.call !== 'function') {
      throw new TypeError('CognitiveStream: brain must implement StreamBrainLike');
    }
    if (!db || typeof db.getDb !== 'function') {
      throw new TypeError('CognitiveStream: db must be a ConsciousnessDB instance');
    }
    if (!embodiedState || typeof embodiedState.getState !== 'function') {
      throw new TypeError('CognitiveStream: embodiedState must implement BodyStateLike');
    }
    if (!spreadingActivation || typeof spreadingActivation.activate !== 'function') {
      throw new TypeError('CognitiveStream: spreadingActivation must implement SpreadingActivationLike');
    }
    if (!emotionalState || typeof emotionalState.getCurrentState !== 'function') {
      throw new TypeError('CognitiveStream: emotionalState must implement EmotionalStateLike');
    }

    this._brain = brain;
    this._cdb = db;
    this._embodied = embodiedState;
    this._spreading = spreadingActivation;
    this._emotional = emotionalState;
    this._config = { ...DEFAULT_CONFIG, ...config };

    // Warm cache from DB (newest-first from DB → reverse for newest-at-end).
    try {
      const warm = getRecentThoughts(this._cdb, CACHE_SIZE).reverse();
      this._cache.push(...warm);
      this._currentThought = this._cache[this._cache.length - 1] ?? null;
      log.debug({ warmed: warm.length }, 'Cache seeded from DB');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ error: msg }, 'Failed to seed cache — starting cold');
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Begin the thought loop. Idempotent. */
  start(): void {
    if (this._isRunning) {
      log.warn('start() called while already running — ignored');
      return;
    }
    this._isRunning = true;
    void this._safeTick();
    this._timer = setInterval(() => void this._safeTick(), this._config.microIntervalMs);
    log.info({ intervalMs: this._config.microIntervalMs }, 'CognitiveStream started');
  }

  /** Stop the thought loop. Idempotent. */
  stop(): void {
    if (!this._isRunning) return;
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._isRunning = false;
    log.info('CognitiveStream stopped');
  }

  // -------------------------------------------------------------------------
  // State accessors
  // -------------------------------------------------------------------------

  /** Return a point-in-time snapshot of stream state. */
  getState(): StreamState {
    return {
      isRunning: this._isRunning,
      currentThought: this._currentThought,
      thoughtCount: this._thoughtCount,
      lastThoughtAt: this._lastThoughtAt,
      activeConcepts: this._spreading.getTopActive(10).map((n) => n.id),
      currentTier: this._currentTier,
    };
  }

  /**
   * Return recent thoughts from cache, falling back to DB.
   * @param count - Desired number of thoughts (default: 10).
   */
  getRecentThoughts(count = 10): StreamThought[] {
    const n = Math.max(1, count);
    if (this._cache.length >= n) return this._cache.slice(-n);
    try {
      return getRecentThoughts(this._cdb, n);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ error: msg }, 'DB fallback failed in getRecentThoughts');
      return [...this._cache];
    }
  }

  /**
   * Return the last CONTEXT_WINDOW thoughts as a text block for system prompt
   * injection.
   */
  getCurrentContext(): string {
    const recent = this._cache.slice(-CONTEXT_WINDOW);
    if (recent.length === 0) return '(no recent thoughts)';
    return recent
      .map((t, i) => `[${i + 1}/${recent.length}] (${t.tier}) ${t.content}`)
      .join('\n');
  }

  /**
   * Snapshot the stream state when a user message arrives.
   * Makes the AI appear caught mid-thought.
   *
   * @param userId  - Identifier of the interrupting user.
   * @param message - The user's message (used only for logging).
   */
  async interrupt(userId: string, message: string): Promise<InterruptResult> {
    if (typeof userId !== 'string' || userId.trim().length === 0) userId = 'unknown';
    if (typeof message !== 'string') message = '';

    const interruptedThought = this._currentThought;
    const activeConcepts = this._spreading.getTopActive(8).map((n) => n.id);
    const emotionalState = this._emotional.getCurrentState();
    const recent = this._cache.slice(-CONTEXT_WINDOW);
    const contextSummary = recent.length > 0
      ? recent.map((t) => `- [${t.tier}] ${t.content.slice(0, 120)}`).join('\n')
      : '(no recent thoughts)';

    log.info(
      { userId, msgLen: message.length, tier: interruptedThought?.tier ?? 'none' },
      'CognitiveStream interrupted',
    );

    return { interruptedThought, contextSummary, activeConcepts, emotionalState };
  }

  // -------------------------------------------------------------------------
  // Internal tick
  // -------------------------------------------------------------------------

  /** Consecutive tick failures — used for exponential backoff. */
  private _consecutiveTickFailures = 0;
  /** Max backoff multiplier (caps at ~16 minutes with 30s base). */
  private static readonly MAX_BACKOFF_MULTIPLIER = 32;

  private async _safeTick(): Promise<void> {
    try {
      await this._tick();
      // Reset backoff on success.
      if (this._consecutiveTickFailures > 0) {
        log.info(
          { previousFailures: this._consecutiveTickFailures },
          'CognitiveStream recovered — backoff reset',
        );
        this._consecutiveTickFailures = 0;
      }
    } catch (err: unknown) {
      this._consecutiveTickFailures++;
      const msg = err instanceof Error ? err.message : String(err);

      // If all models are exhausted, apply exponential backoff instead of
      // flooding the logs every 30 seconds.
      if (msg.includes('exhausted') || msg.includes('cooldown')) {
        const backoffMultiplier = Math.min(
          Math.pow(2, this._consecutiveTickFailures - 1),
          CognitiveStream.MAX_BACKOFF_MULTIPLIER,
        );
        const skipCount = Math.floor(backoffMultiplier);
        if (this._consecutiveTickFailures % skipCount === 1 || skipCount <= 1) {
          log.warn(
            { consecutiveFailures: this._consecutiveTickFailures, backoffMultiplier },
            'All LLM profiles unavailable — CognitiveStream backing off',
          );
        }
      } else {
        log.error({ error: msg }, 'Uncaught tick error — suppressed to protect event loop');
      }
    }
  }

  private async _tick(): Promise<void> {
    if (this._ticking) {
      log.warn('tick skipped — previous tick still in progress');
      return;
    }
    this._ticking = true;

    try {
      this._tickCount++;
      this._currentTier = resolveTier(this._tickCount, this._config);

      const thought = await executeTick({
        tickCount: this._tickCount,
        cache: this._cache,
        cdb: this._cdb,
        brain: this._brain,
        embodied: this._embodied,
        spreading: this._spreading,
        emotional: this._emotional,
        config: this._config,
        currentThought: this._currentThought,
      });

      if (thought === null) return;

      // Update cache.
      this._cache.push(thought);
      if (this._cache.length > CACHE_SIZE) this._cache.shift();

      // Update bookkeeping.
      this._currentThought = thought;
      this._thoughtCount++;
      this._lastThoughtAt = thought.timestamp;
    } finally {
      this._ticking = false;
    }
  }
}
