/**
 * @file trace-driven-policy.ts
 * @description Policy engine that learns optimal model/tool/param combinations
 * from trace data for SUDO-AI v4.
 *
 * This is the core of the compounding flywheel: it replaces the in-memory
 * FailureLearner with a persistent policy engine that gets smarter over time.
 * Every evaluation feeds back through recordOutcome(), and periodic
 * refreshPolicies() calls rebuild rules from the latest trace aggregates.
 *
 * Kill-switch: set SUDO_POLICY_DISABLE=1 to disable all policy evaluation.
 */

import { TraceStore } from './trace-store.js';
import { TraceAnalyzer, type ModelToolStats } from './trace-analyzer.js';
import { createLogger } from '../shared/logger.js';
import { genId } from '../shared/utils.js';

const log = createLogger('learning:trace-driven-policy');

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/** Condition that must match for a rule to fire. All set fields are ANDed. */
export interface PolicyCondition {
  /** Regex or substring matched against the intent string. */
  intentPattern?: string;
  /** Exact tool name to match. */
  toolName?: string;
  /** Exact category to match (e.g. "coding", "analysis"). */
  category?: string;
  /** Exact model name to match. */
  model?: string;
}

/** Action to take when a rule fires. */
export interface PolicyAction {
  /** Preferred model to route to. */
  preferredModel?: string;
  /** Preferred tool to use. */
  preferredTool?: string;
  /** Extra parameters to pass through. */
  params?: Record<string, unknown>;
  /** If true, block the request entirely. */
  block?: boolean;
  /** Cooldown period in seconds before retrying this combo. */
  cooldownSeconds?: number;
}

/** A learned or manual policy rule. */
export interface PolicyRule {
  id: string;
  condition: PolicyCondition;
  action: PolicyAction;
  /** 0-1 confidence score derived from trace data. */
  confidence: number;
  /** How many times this rule has matched during evaluate(). */
  appliedCount: number;
  createdAt: string;
  updatedAt: string;
}

/** The decision produced by evaluating a single rule match. */
export interface PolicyDecision {
  action: PolicyAction;
  ruleId: string;
  confidence: number;
  /** Where this rule originated. */
  source: 'trace' | 'manual' | 'default';
}

/** Full evaluation result including the no-match case. */
export interface PolicyEvaluation {
  /** null when no rule matched. */
  decision: PolicyDecision | null;
  /** Human-readable explanation of why this result was produced. */
  reason: string;
  evaluatedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Success rate threshold for a "high-performing" combo. */
const HIGH_PERF_SUCCESS_RATE = 0.9;
/** Success rate threshold for a "failing" combo. */
const FAIL_SUCCESS_RATE = 0.5;
/** Minimum confidence for a rule to survive pruning. */
const MIN_CONFIDENCE = 0.3;
/** Minimum total calls before a combo is statistically meaningful. */
const MIN_CALLS_FOR_RULE = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const now = (): string => new Date().toISOString();

/** Test whether a regex pattern or literal substring matches the input. */
function intentMatches(pattern: string, intent: string): boolean {
  try {
    // If it looks like a regex (contains metacharacters), treat it as one.
    if (/[\^$.*+?()[\]{}|\\]/.test(pattern)) {
      return new RegExp(pattern, 'i').test(intent);
    }
    return intent.toLowerCase().includes(pattern.toLowerCase());
  } catch {
    // Bad regex pattern — fall back to case-insensitive substring match.
    return intent.toLowerCase().includes(pattern.toLowerCase());
  }
}

/**
 * Compute rule confidence from trace stats.
 * confidence = successRate * sqrt(totalCalls) / 100
 * This balances success rate with sample size so a 100% rate on 2 calls
 * doesn't dominate a 95% rate on 1000 calls.
 */
function computeConfidence(successRate: number, totalCalls: number): number {
  return successRate * Math.sqrt(totalCalls) / 100;
}

// ---------------------------------------------------------------------------
// TraceDrivenPolicy
// ---------------------------------------------------------------------------

/**
 * Policy engine that learns optimal model/tool/param combinations from
 * persistent trace data. Replaces the in-memory FailureLearner with rules
 * that survive restarts and compound over time.
 *
 * Usage:
 *   const policy = new TraceDrivenPolicy(traceStore, traceAnalyzer);
 *   policy.refreshPolicies();          // build initial rules from traces
 *   const eval = policy.evaluate(...); // check for a matching rule
 *   policy.recordOutcome(...);         // feed back result for future learning
 */
export class TraceDrivenPolicy {
  private traceStore: TraceStore;
  private traceAnalyzer: TraceAnalyzer;

  /** Rules derived from trace data, sorted by confidence descending. */
  private traceRules: PolicyRule[] = [];
  /** Manually authored rules (higher priority than trace rules). */
  private manualRules: PolicyRule[] = [];
  /** Default fallback rules that always exist. */
  private defaultRules: PolicyRule[] = [];

  /** Running counters for getStats(). */
  private totalEvaluations = 0;

  constructor(traceStore: TraceStore, traceAnalyzer: TraceAnalyzer) {
    this.traceStore = traceStore;
    this.traceAnalyzer = traceAnalyzer;

    // Seed a default rule: when nothing else matches, don't block or reroute.
    this.defaultRules = [
      {
        id: 'default:passthrough',
        condition: {},
        action: {},
        confidence: 0,
        appliedCount: 0,
        createdAt: now(),
        updatedAt: now(),
      },
    ];
  }

  // -- Evaluation -------------------------------------------------------------

  /**
   * Evaluate the policy for a given request context.
   * Checks manual rules first (highest priority), then trace-derived rules,
   * then default rules. Returns the first match.
   *
   * Kill-switch: if SUDO_POLICY_DISABLE=1, always returns a no-op evaluation.
   */
  evaluate(
    intent: string,
    toolName?: string,
    category?: string,
    currentModel?: string,
  ): PolicyEvaluation {
    const evaluatedAt = now();
    this.totalEvaluations++;

    // Kill-switch: bypass all policy logic when disabled.
    if (process.env['SUDO_POLICY_DISABLE'] === '1') {
      return {
        decision: null,
        reason: 'Policy evaluation disabled (SUDO_POLICY_DISABLE=1)',
        evaluatedAt,
      };
    }

    // 1. Check manual rules (highest priority).
    const manualMatch = this.findMatch(this.manualRules, intent, toolName, category, currentModel);
    if (manualMatch) {
      manualMatch.appliedCount++;
      return {
        decision: {
          action: manualMatch.action,
          ruleId: manualMatch.id,
          confidence: manualMatch.confidence,
          source: 'manual',
        },
        reason: `Matched manual rule ${manualMatch.id}`,
        evaluatedAt,
      };
    }

    // 2. Check trace-derived rules.
    const traceMatch = this.findMatch(this.traceRules, intent, toolName, category, currentModel);
    if (traceMatch) {
      traceMatch.appliedCount++;
      return {
        decision: {
          action: traceMatch.action,
          ruleId: traceMatch.id,
          confidence: traceMatch.confidence,
          source: 'trace',
        },
        reason: `Matched trace rule ${traceMatch.id} (confidence=${traceMatch.confidence.toFixed(2)})`,
        evaluatedAt,
      };
    }

    // 3. Default passthrough — no rerouting, no blocking.
    return {
      decision: {
        action: {},
        ruleId: 'default:passthrough',
        confidence: 0,
        source: 'default',
      },
      reason: 'No matching rule found; using default passthrough',
      evaluatedAt,
    };
  }

  /**
   * Scan a rule list for the first rule whose condition matches all provided
   * context fields. All set condition fields are ANDed together.
   */
  private findMatch(
    rules: PolicyRule[],
    intent: string,
    toolName?: string,
    category?: string,
    currentModel?: string,
  ): PolicyRule | null {
    for (const rule of rules) {
      const c = rule.condition;

      // Intent pattern: regex or substring match (skip empty patterns).
      if (c.intentPattern && !intentMatches(c.intentPattern, intent)) {
        continue;
      }
      // Tool name: exact match (skip undefined condition fields).
      if (c.toolName !== undefined && c.toolName !== toolName) {
        continue;
      }
      // Category: exact match.
      if (c.category !== undefined && c.category !== category) {
        continue;
      }
      // Model: exact match on the current model.
      if (c.model !== undefined && c.model !== currentModel) {
        continue;
      }

      // All conditions satisfied — this rule matches.
      return rule;
    }
    return null;
  }

  // -- Outcome recording -------------------------------------------------------

  /**
   * Record the outcome of a tool/brain call so that the next refreshPolicies()
   * can incorporate this data point. This is the feedback loop that makes the
   * policy engine self-improving.
   */
  recordOutcome(
    intent: string,
    toolName: string | undefined,
    category: string | undefined,
    model: string,
    success: boolean,
    latencyMs: number,
  ): void {
    this.traceStore.record({
      traceType: 'tool_call',
      intent,
      toolName,
      category: category as import('./trace-store.js').IntentCategory | undefined,
      model,
      success,
      latencyMs,
    });
    log.debug({ intent, toolName, model, success, latencyMs }, 'Outcome recorded');
  }

  // -- Manual rule management --------------------------------------------------

  /**
   * Add a manually authored rule. Manual rules take priority over all
   * trace-derived rules. Returns the new rule's ID.
   */
  addManualRule(condition: PolicyCondition, action: PolicyAction): string {
    const id = `manual:${genId()}`;
    const ts = now();
    const rule: PolicyRule = {
      id,
      condition,
      action,
      confidence: 1.0, // Manual rules are assumed fully trusted.
      appliedCount: 0,
      createdAt: ts,
      updatedAt: ts,
    };
    this.manualRules.push(rule);
    log.info({ ruleId: id, condition, action }, 'Manual rule added');
    return id;
  }

  /**
   * Remove a rule by its ID. Works for both manual and trace-derived rules.
   * Returns true if the rule was found and removed, false otherwise.
   */
  removeRule(ruleId: string): boolean {
    // Try manual rules first.
    const manualIdx = this.manualRules.findIndex(r => r.id === ruleId);
    if (manualIdx !== -1) {
      this.manualRules.splice(manualIdx, 1);
      log.info({ ruleId }, 'Manual rule removed');
      return true;
    }
    // Then trace rules.
    const traceIdx = this.traceRules.findIndex(r => r.id === ruleId);
    if (traceIdx !== -1) {
      this.traceRules.splice(traceIdx, 1);
      log.info({ ruleId }, 'Trace rule removed');
      return true;
    }
    log.warn({ ruleId }, 'removeRule: rule not found');
    return false;
  }

  /** Return all active rules (manual + trace + default), sorted by confidence. */
  getRules(): PolicyRule[] {
    return [
      ...this.manualRules,
      ...this.traceRules,
      ...this.defaultRules,
    ].sort((a, b) => b.confidence - a.confidence);
  }

  // -- Policy generation from traces ------------------------------------------

  /**
   * Rebuild trace-derived rules from the latest trace aggregates.
   *
   * Algorithm:
   *  1. Get ModelToolStats from the analyzer.
   *  2. Find combos with >90% success rate and below-median latency.
   *  3. For each high-performing combo, create a "prefer" rule:
   *     when (toolName=X AND category=Y), prefer model=Z.
   *  4. For each failing combo (<50% success), create block/cooldown rules.
   *  5. Score rules by confidence = successRate * sqrt(totalCalls) / 100.
   *  6. Discard rules with confidence < 0.3.
   *  7. Sort surviving rules by confidence, highest first.
   */
  refreshPolicies(): void {
    if (process.env['SUDO_POLICY_DISABLE'] === '1') {
      log.info('Policy refresh skipped (SUDO_POLICY_DISABLE=1)');
      return;
    }

    log.info('Refreshing trace-derived policies...');

    // 1. Run analysis to get fresh stats.
    const result = this.traceAnalyzer.analyze();
    const stats = result.modelToolStats;

    // 2. Compute median latency across all combos for threshold.
    const allLatencies = stats.map(s => s.avgLatencyMs).sort((a, b) => a - b);
    const medianLatency = allLatencies.length > 0
      ? allLatencies[Math.floor(allLatencies.length / 2)]
      : 0;

    const newRules: PolicyRule[] = [];
    const ts = now();

    for (const combo of stats) {
      // Skip combos with too few calls — not statistically meaningful.
      if (combo.totalCalls < MIN_CALLS_FOR_RULE) continue;

      const confidence = computeConfidence(combo.successRate, combo.totalCalls);

      // 3. High-performing combo: >90% success AND below-median latency.
      if (combo.successRate >= HIGH_PERF_SUCCESS_RATE && combo.avgLatencyMs <= medianLatency) {
        if (confidence >= MIN_CONFIDENCE) {
          newRules.push({
            id: `trace:prefer:${genId()}`,
            condition: { toolName: combo.toolName },
            action: { preferredModel: combo.model },
            confidence,
            appliedCount: 0,
            createdAt: ts,
            updatedAt: ts,
          });
        }
      }

      // 4. Failing combo: <50% success — block or add cooldown.
      if (combo.successRate < FAIL_SUCCESS_RATE) {
        if (confidence >= MIN_CONFIDENCE) {
          // Severe failures: block entirely. Mild failures: add cooldown.
          const shouldBlock = combo.successRate < 0.25;
          newRules.push({
            id: `trace:${shouldBlock ? 'block' : 'cooldown'}:${genId()}`,
            condition: { toolName: combo.toolName, model: combo.model },
            action: shouldBlock
              ? { block: true }
              : { cooldownSeconds: 30 },
            confidence,
            appliedCount: 0,
            createdAt: ts,
            updatedAt: ts,
          });
        }
      }
    }

    // 5. Also generate category-level preference rules from modelCategoryStats.
    for (const catStats of result.modelCategoryStats) {
      if (catStats.totalCalls < MIN_CALLS_FOR_RULE) continue;
      const catConfidence = computeConfidence(catStats.successRate, catStats.totalCalls);
      if (catConfidence < MIN_CONFIDENCE) continue;
      if (catStats.successRate >= HIGH_PERF_SUCCESS_RATE) {
        newRules.push({
          id: `trace:cat-prefer:${genId()}`,
          condition: { category: catStats.category },
          action: { preferredModel: catStats.model },
          confidence: catConfidence,
          appliedCount: 0,
          createdAt: ts,
          updatedAt: ts,
        });
      }
    }

    // 6. Discard rules below the confidence threshold (already done above,
    //    but double-check after any post-processing).
    const surviving = newRules.filter(r => r.confidence >= MIN_CONFIDENCE);

    // 7. Sort by confidence, highest first.
    surviving.sort((a, b) => b.confidence - a.confidence);

    const prevCount = this.traceRules.length;
    this.traceRules = surviving;

    log.info(
      { generated: newRules.length, surviving: surviving.length, previous: prevCount },
      'Trace policies refreshed',
    );
  }

  // -- Statistics --------------------------------------------------------------

  /** Return usage statistics for monitoring and debugging. */
  getStats(): {
    totalEvaluations: number;
    traceRules: number;
    manualRules: number;
    defaultRules: number;
    avgConfidence: number;
  } {
    const allRuleConfidences = [
      ...this.traceRules.map(r => r.confidence),
      ...this.manualRules.map(r => r.confidence),
    ];
    const avgConfidence = allRuleConfidences.length > 0
      ? allRuleConfidences.reduce((a, b) => a + b, 0) / allRuleConfidences.length
      : 0;

    return {
      totalEvaluations: this.totalEvaluations,
      traceRules: this.traceRules.length,
      manualRules: this.manualRules.length,
      defaultRules: this.defaultRules.length,
      avgConfidence: Math.round(avgConfidence * 1000) / 1000,
    };
  }
}