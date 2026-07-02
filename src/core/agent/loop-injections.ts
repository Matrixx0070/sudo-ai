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
import type { LazinessNudge } from './laziness-nudge.js';
import type { TodoGate } from './todo-gate.js';
import type { SelfVerify } from './self-verify.js';
import type { GoalClassifier } from '../autonomy/goal-pipeline.js';
import type { GoalStopDetector } from '../autonomy/goal-stop-detector.js';
import type { PlanModeStateMachine } from './plan-mode-v2.js';
import type { BestOfNExecutor } from './best-of-n.js';
import type { ToolOutcomeLearner } from './tool-outcome-learner.js';
import type { VerifyGateLike, CriticPassLike } from './loop-helpers.js';
import type { FeedbackMemory } from '../self-improvement/feedback-memory.js';
import type { AlignmentEngine } from '../alignment/alignment-engine.js';
import type { SteeringChannel } from './steering.js';

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
  protected _lazinessNudge?: LazinessNudge;
  protected _todoGate?: TodoGate;
  protected _selfVerify?: SelfVerify;
  protected _goalClassifier?: GoalClassifier;
  protected _goalStopDetector?: GoalStopDetector;
  protected _planModeStateMachine?: PlanModeStateMachine;
  protected _bestOfNExecutor?: BestOfNExecutor;
  protected _toolOutcomeLearner?: ToolOutcomeLearner;
  protected _verifyGate?: VerifyGateLike;
  protected _criticPass?: CriticPassLike;
  protected _feedbackMemory?: FeedbackMemory;
  protected _alignmentEngine?: AlignmentEngine;
  protected _steeringChannel?: SteeringChannel;

  /**
   * Wire a steering channel so an in-process caller can abort/inject/reprioritize
   * a running turn. The loop polls it at each iteration boundary. Fail-open if
   * the duck-type doesn't match.
   */
  setSteeringChannel(c: SteeringChannel): void {
    if (c && typeof c.checkSteering === 'function' && typeof c.clearSteering === 'function') {
      this._steeringChannel = c;
      log.info('AgentLoop: steering channel attached');
    } else {
      log.warn('AgentLoop: setSteeringChannel: invalid duck-type — ignoring');
    }
  }

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

  /** Wire LazinessNudge after construction. Fail-open if duck-type mismatch. */
  setLazinessNudge(ln: LazinessNudge): void {
    if (ln && typeof ln.classify === 'function') {
      this._lazinessNudge = ln;
      log.info('AgentLoop: LazinessNudge attached');
    } else {
      log.warn('AgentLoop: setLazinessNudge: invalid duck-type — ignoring');
    }
  }

  /** Wire TodoGate after construction. Fail-open if duck-type mismatch. */
  setTodoGate(tg: TodoGate): void {
    if (tg && typeof tg.check === 'function') {
      this._todoGate = tg;
      log.info('AgentLoop: TodoGate attached');
    } else {
      log.warn('AgentLoop: setTodoGate: invalid duck-type — ignoring');
    }
  }

  /** Wire SelfVerify after construction. Fail-open if duck-type mismatch. */
  setSelfVerify(sv: SelfVerify): void {
    if (sv && typeof sv.verify === 'function') {
      this._selfVerify = sv;
      log.info('AgentLoop: SelfVerify attached');
    } else {
      log.warn('AgentLoop: setSelfVerify: invalid duck-type — ignoring');
    }
  }

  /** Wire GoalClassifier after construction. Fail-open if duck-type mismatch. */
  setGoalClassifier(gc: GoalClassifier): void {
    if (gc && typeof gc.classify === 'function') {
      this._goalClassifier = gc;
      log.info('AgentLoop: GoalClassifier attached');
    } else {
      log.warn('AgentLoop: setGoalClassifier: invalid duck-type — ignoring');
    }
  }

  /** Wire GoalStopDetector after construction. Fail-open if duck-type mismatch. */
  setGoalStopDetector(gsd: GoalStopDetector): void {
    if (gsd && typeof gsd.detect === 'function') {
      this._goalStopDetector = gsd;
      log.info('AgentLoop: GoalStopDetector attached');
    } else {
      log.warn('AgentLoop: setGoalStopDetector: invalid duck-type — ignoring');
    }
  }

  /** Wire PlanModeStateMachine after construction. Fail-open if duck-type mismatch. */
  setPlanModeStateMachine(pms: PlanModeStateMachine): void {
    if (pms && typeof pms.enterPlanMode === 'function' && typeof pms.exitPlanMode === 'function') {
      this._planModeStateMachine = pms;
      log.info('AgentLoop: PlanModeStateMachine attached');
    } else {
      log.warn('AgentLoop: setPlanModeStateMachine: invalid duck-type — ignoring');
    }
  }

  /** Returns the PlanModeStateMachine instance if attached. */
  getPlanModeStateMachine(): PlanModeStateMachine | undefined {
    return this._planModeStateMachine;
  }

  /** Wire BestOfNExecutor after construction. Fail-open if duck-type mismatch. */
  setBestOfNExecutor(bne: BestOfNExecutor): void {
    if (bne && typeof bne.execute === 'function') {
      this._bestOfNExecutor = bne;
      log.info('AgentLoop: BestOfNExecutor attached');
    } else {
      log.warn('AgentLoop: setBestOfNExecutor: invalid duck-type — ignoring');
    }
  }

  /** Returns the BestOfNExecutor instance if attached. */
  getBestOfNExecutor(): BestOfNExecutor | undefined {
    return this._bestOfNExecutor;
  }

  /** Wire ToolOutcomeLearner after construction. Fail-open if duck-type mismatch. */
  setToolOutcomeLearner(learner: ToolOutcomeLearner): void {
    this._toolOutcomeLearner = learner;
    log.info('AgentLoop: ToolOutcomeLearner attached');
  }

  /** Wire a verify-gate after construction. Fail-open if duck-type mismatch. */
  setVerifyGate(gate: VerifyGateLike): void {
    if (gate && typeof gate.evaluate === 'function') {
      this._verifyGate = gate;
      log.info('AgentLoop: VerifyGate attached');
    } else {
      log.warn('AgentLoop: setVerifyGate: invalid duck-type — ignoring');
    }
  }

  /** Wire a critic pass after construction. Fail-open if duck-type mismatch. */
  setCriticPass(critic: CriticPassLike): void {
    if (critic && typeof critic.review === 'function') {
      this._criticPass = critic;
      log.info('AgentLoop: CriticPass attached');
    } else {
      log.warn('AgentLoop: setCriticPass: invalid duck-type — ignoring');
    }
  }

  /** Wire FeedbackMemory after construction. */
  setFeedbackMemory(fb: FeedbackMemory): void {
    if (fb && typeof fb.recordSuccess === 'function' && typeof fb.recordFailure === 'function') {
      this._feedbackMemory = fb;
      log.info('AgentLoop: FeedbackMemory attached');
    } else {
      log.warn('AgentLoop: setFeedbackMemory: invalid duck-type — ignoring');
    }
  }

  /** Returns the FeedbackMemory if attached (for admin/inspect). */
  getFeedbackMemory(): FeedbackMemory | undefined {
    return this._feedbackMemory;
  }

  /** Wire AlignmentEngine after construction. */
  setAlignmentEngine(ae: AlignmentEngine): void {
    if (ae && typeof ae.computeSignals === 'function') {
      this._alignmentEngine = ae;
      log.info('AgentLoop: AlignmentEngine attached');
    } else {
      log.warn('AgentLoop: setAlignmentEngine: invalid duck-type — ignoring');
    }
  }

  /** Returns the AlignmentEngine instance if attached. */
  getAlignmentEngine(): AlignmentEngine | undefined {
    return this._alignmentEngine;
  }
}
