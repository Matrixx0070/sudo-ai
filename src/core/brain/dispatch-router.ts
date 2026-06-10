/**
 * dispatch-router.ts
 *
 * Layers novelty scoring, an LRU fast-path cache, and an anti-self-promotion
 * guard on top of chooseModel() from cheap-model-router.ts for
 * principal-task fidelity and capability preservation for owner-critical task routing.
 *
 * cheap-model-router.ts is NOT modified — this class wraps it.
 */

import { createLogger } from '../shared/logger.js';
import { chooseModel } from '../agent/cheap-model-router.js';
import type { ChooseModelInput, ChooseModelResult, HistoryMessage } from '../agent/cheap-model-router.js';

const log = createLogger('brain:dispatch-router');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Cache entry for fast-path routing decisions. */
export interface RouteCacheEntry {
  result: ChooseModelResult;
  /** Unix ms timestamp when this entry expires. */
  expiresAt: number;
}

/** Input to DispatchRouter.route() — superset of ChooseModelInput. */
export interface DispatchInput extends ChooseModelInput {
  /** Agent role identifier (e.g. 'subagent', 'planner'). Used for anti-self-promotion. */
  agentRole?: string;
  /**
   * Hint from the caller about novelty. If undefined, router computes internally.
   * 0 = seen before, 1 = completely novel.
   */
  noveltyHint?: number;
}

/** Result of DispatchRouter.route() — superset of ChooseModelResult. */
export interface DispatchResult extends ChooseModelResult {
  /** 0-1 novelty score that influenced the decision. */
  noveltyScore: number;
  /** True when the fast-path cache was hit. */
  cacheHit: boolean;
  /** True when anti-self-promotion guard overrode a cheap decision. */
  selfPromotionBlocked: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Allowlist of roles permitted to use the fast-path (cheap model).
 *
 * Design choice: ALLOWLIST over blocklist.
 * Rationale: any new non-human role added in future is blocked by default,
 * preventing capability downgrade through role-name proliferation.
 * Only explicitly human/operator roles are eligible for cheap-model routing.
 *
 * Blocked by default (non-exhaustive examples):
 *   planner, subagent, sub-agent, scheduler, agent, assistant, system,
 *   daemon, background-task, autonomy-loop, worker, tool, tool-runner, etc.
 *
 * Fast-path eligible: human, user, operator.
 */
const FAST_PATH_ELIGIBLE_ROLES: ReadonlySet<string> = new Set([
  'human',
  'user',
  'operator',
]);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * djb2 non-crypto hash — produces a stable numeric hash from a string.
 * Fast, zero dependencies, sufficient for cache keying.
 */
function djb2Hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    // eslint-disable-next-line no-bitwise
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    // eslint-disable-next-line no-bitwise
    h = h >>> 0; // keep unsigned 32-bit
  }
  return h;
}

/**
 * Compute bigram overlap ratio between two strings.
 * Returns 0-1: 1.0 = identical bigrams; 0.0 = no shared bigrams.
 */
function bigramOverlap(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return 0;

  const bigrams = (s: string): Set<string> => {
    const result = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) {
      result.add(s.slice(i, i + 2).toLowerCase());
    }
    return result;
  };

  const setA = bigrams(a);
  const setB = bigrams(b);
  let shared = 0;
  for (const gram of setA) {
    if (setB.has(gram)) shared++;
  }
  const union = setA.size + setB.size - shared;
  return union === 0 ? 0 : shared / union;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Module-level re-anchor callback — set via setGlobalDispatchReAnchorCallback()
// Mirrors the veto-gate module-level pattern so cli.ts can wire it without
// holding a reference to the DispatchRouter instance (which lives inside loop.ts).
// ---------------------------------------------------------------------------

/**
 * Module-level re-anchor callback. Fired after every successful route() call.
 * Both the class-level and module-level callbacks are invoked when set.
 * Fail-open: if never set the callback is skipped silently.
 */
let _globalReAnchorCallback: (() => void) | undefined;

/**
 * Register a module-level re-anchor callback for all DispatchRouter instances.
 * Called from cli.ts after createReAnchorEmitter('post-dispatch', ...) is built.
 * Pass undefined to clear (useful in tests afterEach).
 */
export function setGlobalDispatchReAnchorCallback(cb: (() => void) | undefined): void {
  _globalReAnchorCallback = cb;
  log.info({ event: 'dispatch.global.reanchor.callback.set', hasCallback: cb !== undefined }, 'Global dispatch re-anchor callback updated');
}

// ---------------------------------------------------------------------------
// DispatchRouter
// ---------------------------------------------------------------------------

/**
 * DispatchRouter layers novelty scoring, an LRU fast-path cache, and
 * an anti-self-promotion guard on top of chooseModel() from
 * cheap-model-router.ts.
 *
 * cheap-model-router.ts is NOT modified. This class wraps it.
 *
 * Anti-self-promotion: if agentRole indicates a sub-agent or planning
 * component, it is not permitted to route itself to the cheap model on
 * any turn that has complexity signals — prevents cost-driven capability
 * downgrade for owner-critical tasks.
 *
 * Owner-loyalty framing: principal-task fidelity, capability preservation
 * for complex directives.
 */
export class DispatchRouter {
  /** LRU cache capacity. */
  static readonly CACHE_MAX = 64;
  /** Cache TTL in milliseconds (default 60s). */
  static readonly CACHE_TTL_MS = 60_000;
  /** Novelty threshold above which cheap model is blocked. */
  static readonly NOVELTY_THRESHOLD = 0.6;

  private readonly cacheMax: number;
  private readonly cacheTtlMs: number;
  /** Insertion-order map acts as an LRU (delete+re-insert to promote). */
  private readonly cache = new Map<string, RouteCacheEntry>();

  /**
   * Post-dispatch re-anchor callback. Fired after every successful
   * route() call (every outbound dispatch). Fail-open: undefined → skipped.
   */
  private _reAnchorCallback: (() => void) | undefined;

  constructor(opts?: { cacheMax?: number; cacheTtlMs?: number }) {
    this.cacheMax = opts?.cacheMax ?? DispatchRouter.CACHE_MAX;
    this.cacheTtlMs = opts?.cacheTtlMs ?? DispatchRouter.CACHE_TTL_MS;
    log.info({ cacheMax: this.cacheMax, cacheTtlMs: this.cacheTtlMs }, 'DispatchRouter initialised');
  }

  /**
   * Register a zero-argument re-anchor callback for post-dispatch events.
   * Called from cli.ts after createReAnchorEmitter('post-dispatch', ...) is built.
   * Pass undefined to clear (useful in tests afterEach).
   */
  setReAnchorCallback(cb: (() => void) | undefined): void {
    this._reAnchorCallback = cb;
    log.info({ event: 'dispatch.reanchor.callback.set', hasCallback: cb !== undefined }, 'Dispatch re-anchor callback updated');
  }

  /**
   * Route a request to the appropriate model.
   * Wraps chooseModel() with novelty scoring, caching, and anti-self-promotion.
   * Never throws — falls back to primary model on any error.
   *
   * Fires post-dispatch re-anchor callback after every successful route.
   */
  route(input: DispatchInput): DispatchResult {
    let result: DispatchResult;
    try {
      result = this._routeInternal(input);
    } catch (err) {
      log.warn({ err: String(err) }, 'DispatchRouter.route threw — failing open to primary model');
      return {
        model: input.primaryModel,
        reason: 'dispatch-router error — failing open to primary model for capability preservation',
        cheapUsed: false,
        noveltyScore: 0,
        cacheHit: false,
        selfPromotionBlocked: false,
      };
    }

    // Post-dispatch re-anchor emission (fail-open).
    // Fires both class-level and module-level callbacks independently (if set).
    // In production, only the module-level global callback is wired from cli.ts.
    // If both are set simultaneously (e.g. in tests), both fire — each emits once.
    if (this._reAnchorCallback !== undefined) {
      try {
        this._reAnchorCallback();
      } catch {
        // fail-open — re-anchor emission is non-fatal
      }
    }
    if (_globalReAnchorCallback !== undefined) {
      try {
        _globalReAnchorCallback();
      } catch {
        // fail-open — re-anchor emission is non-fatal
      }
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Private implementation
  // ---------------------------------------------------------------------------

  private _routeInternal(input: DispatchInput): DispatchResult {
    this._evictExpired();

    // Step 1: compute novelty score (uses hint if provided).
    const noveltyScore = this._computeNovelty(input);

    // Step 2: check cache.
    const key = this._cacheKey(input);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      // Promote to most-recently-used position.
      this.cache.delete(key);
      this.cache.set(key, cached);
      log.info({ key, model: cached.result.model }, 'DispatchRouter: cache hit — serving cached cheap-path decision');
      return {
        ...cached.result,
        noveltyScore,
        cacheHit: true,
        selfPromotionBlocked: false,
      };
    }

    // Step 3: call base router.
    const baseResult = chooseModel(input);

    // Step 4: novelty override — if novel, preserve primary model capability.
    let finalResult: ChooseModelResult = baseResult;
    let selfPromotionBlocked = false;

    if (noveltyScore >= DispatchRouter.NOVELTY_THRESHOLD && baseResult.cheapUsed) {
      finalResult = {
        model: input.primaryModel,
        reason: `novelty score ${noveltyScore.toFixed(3)} >= threshold — principal-task fidelity preserved`,
        cheapUsed: false,
      };
      log.debug({ noveltyScore }, 'DispatchRouter: novelty override — routing to primary model');
    }

    // Step 5: anti-self-promotion guard (allowlist).
    // Only explicitly human/operator roles may use cheap-model fast-path.
    // Any non-human or unrecognised role is blocked by default — capability
    // reservation for owner-critical tasks.
    if (
      !selfPromotionBlocked &&
      finalResult.cheapUsed &&
      input.agentRole != null &&
      !FAST_PATH_ELIGIBLE_ROLES.has(input.agentRole)
    ) {
      finalResult = {
        model: input.primaryModel,
        reason: 'sub-agent self-promotion to cheap model blocked — capability reservation',
        cheapUsed: false,
      };
      selfPromotionBlocked = true;
      log.info({ agentRole: input.agentRole }, 'DispatchRouter: anti-self-promotion guard triggered — fast-path denied for non-allowlisted role');
    }

    // Step 6: store in cache only for simple (cheap) decisions.
    if (finalResult.cheapUsed) {
      if (this.cache.size >= this.cacheMax) {
        // Evict oldest entry (first key in insertion order).
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) {
          this.cache.delete(oldest);
        }
      }
      this.cache.set(key, {
        result: finalResult,
        expiresAt: Date.now() + this.cacheTtlMs,
      });
      log.debug({ key }, 'DispatchRouter: cached fast-path result');
    }

    return {
      ...finalResult,
      noveltyScore,
      cacheHit: false,
      selfPromotionBlocked,
    };
  }

  /**
   * Compute a 0-1 novelty score for the given input.
   * If noveltyHint is provided, returns it directly.
   * Otherwise scores based on history length, text similarity, and word count.
   */
  private _computeNovelty(input: DispatchInput): number {
    if (input.noveltyHint !== undefined) {
      return Math.max(0, Math.min(1, input.noveltyHint));
    }

    const { userText, history } = input;
    let score = 0;

    // +0.4 if no meaningful history (fewer than 2 messages).
    const userHistory = (history as HistoryMessage[]).filter(m => m.role === 'user');
    if (userHistory.length < 2) {
      score += 0.4;
    } else {
      // +0.3 if last user message has low bigram overlap with current text.
      const lastUserMsg = userHistory[userHistory.length - 1];
      const lastMsgUnknown: unknown = lastUserMsg;
      const lastText = typeof (lastMsgUnknown as { content?: unknown }).content === 'string'
        ? (lastMsgUnknown as { content: string }).content
        : '';
      const overlap = bigramOverlap(userText, lastText);
      if (overlap < 0.2) {
        score += 0.3;
      }
    }

    // +0.3 if word count > 60.
    const words = userText.trim().split(/\s+/).filter(Boolean).length;
    if (words > 60) {
      score += 0.3;
    }

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Generate a deterministic cache key from the routing-relevant fields.
   * Does NOT include full message text.
   * Uses djb2 hash for fast stable hashing without crypto dependency.
   */
  private _cacheKey(input: DispatchInput): string {
    const textPart = input.userText.length > 40
      ? input.userText.slice(0, 40)
      : input.userText;
    const raw = [
      input.agentRole ?? '',
      input.cheapModel,
      input.primaryModel,
      textPart,
      input.hasAttachments === true ? '1' : '0',
    ].join('|');
    return djb2Hash(raw).toString(16);
  }

  /**
   * Evict entries from the LRU cache that have passed their TTL.
   */
  private _evictExpired(): void {
    const now = Date.now();
    for (const [k, v] of this.cache.entries()) {
      if (v.expiresAt <= now) {
        this.cache.delete(k);
      }
    }
  }
}
