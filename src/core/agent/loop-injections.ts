/**
 * @file loop-injections.ts
 * @description Abstract base class holding the simpler post-construction
 * dependency-injected hooks that AgentLoop exposes. Extracted from loop.ts
 * (refactor #231) so the orchestrator file shrinks without restructuring
 * the call sites that read these fields — TypeScript `protected` access
 * keeps `this._foo` working inside the AgentLoop subclass.
 *
 * Scope of this slice: only the five purely-trivial setters whose bodies
 * are exactly "duck-type check → assign → log". Setters with side effects
 * beyond the simple assign (e.g. setGroundingChecker also flips
 * _groundingBlockEnabled) stay in loop.ts for a follow-up slice.
 *
 * Setters covered by this base class:
 *   - setPredictor / _predictor
 *   - setNegativeRouter / getNegativeRouter / _negativeRouter
 *   - setContextCompressor / getContextCompressor / _contextCompressor
 *   - setTraceStore / getTraceStore / _traceStore
 *   - setTraceDrivenPolicy / getTraceDrivenPolicy / _traceDrivenPolicy
 *
 * Behaviour delta: zero. Each method body is byte-identical to the version
 * that previously lived in loop.ts; only the host class changed.
 */

import { createLogger } from '../shared/logger.js';
import type { PredictorLike } from './loop-types.js';
import type { NegativeRouter } from '../brain/negative-router.js';
import type { ContextCompressor } from '../brain/context-compressor.js';
import type { TraceStore } from '../learning/trace-store.js';
import type { TraceDrivenPolicy } from '../learning/trace-driven-policy.js';

const log = createLogger('agent:loop:injections');

/**
 * Base class providing the simplest post-construction wiring hooks.
 * AgentLoop extends this to inherit the setter/getter surface without
 * carrying the boilerplate inline.
 */
export abstract class AgentLoopInjections {
  protected _predictor?: PredictorLike;
  protected _negativeRouter?: NegativeRouter;
  protected _contextCompressor?: ContextCompressor;
  protected _traceStore?: TraceStore;
  protected _traceDrivenPolicy?: TraceDrivenPolicy;

  /** Wire a Predictor for opt-in anticipatory injection (SUDO_PREDICTOR_LOOP). Fail-open if duck-type mismatch. */
  setPredictor(p: PredictorLike): void {
    if (p && typeof p.anticipate === 'function') {
      this._predictor = p;
      log.info('AgentLoop: Predictor attached');
    } else {
      log.warn('AgentLoop: setPredictor: invalid duck-type — ignoring');
    }
  }

  /** Wire NegativeRouter after construction. Fail-open if duck-type mismatch. */
  setNegativeRouter(router: NegativeRouter): void {
    if (router && typeof router.route === 'function') {
      this._negativeRouter = router;
      log.info('AgentLoop: NegativeRouter attached');
    } else {
      log.warn('AgentLoop: setNegativeRouter: invalid duck-type — ignoring');
    }
  }

  /** Returns the NegativeRouter instance if attached. */
  getNegativeRouter(): NegativeRouter | undefined {
    return this._negativeRouter;
  }

  /** Wire ContextCompressor after construction. Fail-open if duck-type mismatch. */
  setContextCompressor(compressor: ContextCompressor): void {
    if (compressor && typeof compressor.shouldCompress === 'function' && typeof compressor.compress === 'function') {
      this._contextCompressor = compressor;
      log.info('AgentLoop: ContextCompressor attached');
    } else {
      log.warn('AgentLoop: setContextCompressor: invalid duck-type — ignoring');
    }
  }

  /** Returns the ContextCompressor instance if attached. */
  getContextCompressor(): ContextCompressor | undefined {
    return this._contextCompressor;
  }

  /** Wire TraceStore after construction (Phase 2: persistent trace recording). Fail-open if duck-type mismatch. */
  setTraceStore(ts: TraceStore): void {
    if (ts && typeof ts.recordToolCall === 'function' && typeof ts.recordBrainCall === 'function' && typeof ts.recordRouting === 'function') {
      this._traceStore = ts;
      log.info('AgentLoop: TraceStore attached');
    } else {
      log.warn('AgentLoop: setTraceStore: invalid duck-type — ignoring');
    }
  }

  /** Returns the TraceStore instance if attached. */
  getTraceStore(): TraceStore | undefined {
    return this._traceStore;
  }

  /** Wire TraceDrivenPolicy after construction (Phase 2: learned policy evaluation). Fail-open if duck-type mismatch. */
  setTraceDrivenPolicy(policy: TraceDrivenPolicy): void {
    if (policy && typeof policy.evaluate === 'function' && typeof policy.recordOutcome === 'function') {
      this._traceDrivenPolicy = policy;
      log.info('AgentLoop: TraceDrivenPolicy attached');
    } else {
      log.warn('AgentLoop: setTraceDrivenPolicy: invalid duck-type — ignoring');
    }
  }

  /** Returns the TraceDrivenPolicy instance if attached. */
  getTraceDrivenPolicy(): TraceDrivenPolicy | undefined {
    return this._traceDrivenPolicy;
  }
}
