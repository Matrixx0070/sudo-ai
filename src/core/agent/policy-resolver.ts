/**
 * policy-resolver.ts — AL6.2 single adaptive-policy seam.
 *
 * One question, one place: "for this step, with these signals, what
 * {route, maxRetries, concurrency, reasoningDepth}?" Every decision is
 * logged WITH its inputs (auditable adaptation; AL7's training signal) and
 * mirrored to an injectable sink for persistence/telemetry.
 *
 * AL6.3 workload adaptation: under queue-depth or budget pressure the
 * resolver sheds load — cheap-routes eligible (non-agentic) steps, lowers
 * concurrency, defers background loops, tightens retries. Thresholds come
 * from env with HYSTERESIS (separate enter/exit levels) so decisions do not
 * flap around a boundary.
 *
 * AL6.5 shadow mode: with SUDO_AL_POLICY_SHADOW=1 every decision is computed
 * and logged but marked shadow — callers MUST NOT apply a shadow decision.
 * New adaptive policies ship shadow-first and are promoted only after the
 * shadow log proves they would not have degraded success/latency.
 *
 * Routes use the AL4.3 hint vocabulary ('cheap' | 'reasoning') — concrete
 * models stay behind resolveAlias; this module never names one.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:policy-resolver');

export type IntentClass = 'quick-fact' | 'conversational' | 'agentic' | 'unknown';

/** Observed inputs — all optional; absent signals are treated as calm (0). */
export interface PolicySignals {
  intent?: IntentClass;
  /** Pending tasks in the work queue. */
  queueDepth?: number;
  /** Fraction of the daily budget already consumed, 0..1. */
  budgetPressure?: number;
  /** Recent failure rate on the candidate route, 0..1. */
  recentFailureRate?: number;
}

export interface PolicyDecision {
  /** AL4.3 route hint — resolved to a model only via the llm alias layer. */
  route: 'cheap' | 'reasoning';
  maxRetries: number;
  /** Suggested parallel-dispatch cap (graph executor / fan-out pools). */
  concurrency: number;
  reasoningDepth: 'shallow' | 'standard' | 'deep';
  /** Background loops should defer while true. */
  deferBackground: boolean;
  /** Computed-not-applied (AL6.5). Callers must not act on shadow decisions. */
  shadow: boolean;
  /** Why — one line per contributing rule, in application order. */
  reasons: string[];
}

export interface PolicyDecisionEntry {
  at: string;
  signals: PolicySignals;
  decision: PolicyDecision;
  /** True when the load-shedding latch was engaged for this decision. */
  shedding: boolean;
}

export interface PolicyResolverOptions {
  /** Persistence/telemetry sink — receives every decision with its inputs. */
  onDecision?: (entry: PolicyDecisionEntry) => void;
  /** Hysteresis thresholds; defaults from env (see below). */
  loadHigh?: number;
  loadLow?: number;
  budgetHigh?: number;
  budgetLow?: number;
  /** Shadow override; default env SUDO_AL_POLICY_SHADOW === '1'. */
  shadow?: boolean;
}

const envNum = (key: string, fallback: number): number => {
  const raw = Number(process.env[key]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
};

const DEFAULT_CONCURRENCY = 4;
const SHED_CONCURRENCY = 2;
const DEFAULT_RETRIES = 3;

/**
 * The AL6.2 seam. Deterministic given (signals, latch state); the only
 * internal state is the load-shedding hysteresis latch.
 */
export class PolicyResolver {
  private readonly opts: PolicyResolverOptions;
  private readonly loadHigh: number;
  private readonly loadLow: number;
  private readonly budgetHigh: number;
  private readonly budgetLow: number;
  private readonly shadow: boolean;
  private shedding = false;

  constructor(options: PolicyResolverOptions = {}) {
    this.opts = options;
    this.loadHigh = options.loadHigh ?? envNum('SUDO_AL_LOAD_HIGH', 8);
    this.loadLow = options.loadLow ?? envNum('SUDO_AL_LOAD_LOW', 3);
    this.budgetHigh = options.budgetHigh ?? envNum('SUDO_AL_BUDGET_HIGH', 0.9);
    this.budgetLow = options.budgetLow ?? envNum('SUDO_AL_BUDGET_LOW', 0.7);
    this.shadow = options.shadow ?? process.env['SUDO_AL_POLICY_SHADOW'] === '1';
    if (this.loadLow >= this.loadHigh || this.budgetLow >= this.budgetHigh) {
      throw new Error(
        'PolicyResolver: hysteresis requires low < high thresholds ' +
          `(load ${this.loadLow}/${this.loadHigh}, budget ${this.budgetLow}/${this.budgetHigh})`,
      );
    }
  }

  /** Current state of the load-shedding latch (for telemetry/tests). */
  isShedding(): boolean {
    return this.shedding;
  }

  resolve(signals: PolicySignals): PolicyDecision {
    const reasons: string[] = [];
    const queueDepth = signals.queueDepth ?? 0;
    const budgetPressure = signals.budgetPressure ?? 0;
    const intent = signals.intent ?? 'unknown';

    // --- AL6.3 hysteresis latch: enter high, exit low — never flap between.
    if (!this.shedding && (queueDepth >= this.loadHigh || budgetPressure >= this.budgetHigh)) {
      this.shedding = true;
      reasons.push(
        `load-shed ENTER (queueDepth ${queueDepth} >= ${this.loadHigh} or budget ${budgetPressure} >= ${this.budgetHigh})`,
      );
    } else if (this.shedding && queueDepth <= this.loadLow && budgetPressure <= this.budgetLow) {
      this.shedding = false;
      reasons.push(
        `load-shed EXIT (queueDepth ${queueDepth} <= ${this.loadLow} and budget ${budgetPressure} <= ${this.budgetLow})`,
      );
    }

    // --- AL6.4 intent routing (conservative: unknown rides the strong route).
    let route: PolicyDecision['route'] = intent === 'agentic' || intent === 'unknown' ? 'reasoning' : 'cheap';
    reasons.push(`intent "${intent}" → route ${route}`);
    let reasoningDepth: PolicyDecision['reasoningDepth'] = intent === 'agentic' ? 'deep' : 'standard';
    let maxRetries = DEFAULT_RETRIES;
    let concurrency = DEFAULT_CONCURRENCY;
    let deferBackground = false;

    if (this.shedding) {
      if (intent !== 'agentic' && route !== 'cheap') {
        route = 'cheap';
        reasons.push('shedding: non-agentic step cheap-routed');
      }
      reasoningDepth = intent === 'agentic' ? 'standard' : 'shallow';
      maxRetries = 1;
      concurrency = SHED_CONCURRENCY;
      deferBackground = true;
      reasons.push(`shedding: concurrency ${SHED_CONCURRENCY}, retries 1, background deferred`);
    }

    // A route that is currently failing hard should not burn retries.
    if ((signals.recentFailureRate ?? 0) >= 0.5 && maxRetries > 1) {
      maxRetries = 1;
      reasons.push(`recent failure rate ${signals.recentFailureRate} >= 0.5 → retries 1`);
    }

    const decision: PolicyDecision = {
      route,
      maxRetries,
      concurrency,
      reasoningDepth,
      deferBackground,
      shadow: this.shadow,
      reasons,
    };

    // --- AL6.2: every decision logged with its inputs. Sink errors must
    // never break the hot path.
    const entry: PolicyDecisionEntry = {
      at: new Date().toISOString(),
      signals,
      decision,
      shedding: this.shedding,
    };
    log.info({ signals, decision, shedding: this.shedding }, 'policy decision');
    try {
      this.opts.onDecision?.(entry);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'policy decision sink failed');
    }
    return decision;
  }
}
