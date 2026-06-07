/**
 * @file held-out-gate.ts
 * @description Non-regression test gate for self-modification in SUDO-AI v4.
 *
 * Inspired by OpenJarvis's held-out gate: any policy change must pass a
 * non-regression test before being applied. The gate maintains a held-out
 * test set of known good/bad outcomes. When a policy change is proposed, it
 * is evaluated against the held-out set. If the change would cause regression
 * beyond the configured tolerance, it is rejected. Accepted changes are
 * versioned and can be rolled back.
 *
 * The gate prevents the system from entering a self-reinforcing degradation
 * loop — a policy that looks locally optimal but globally harmful is caught
 * before it ever reaches production.
 */

import { TraceStore, type TraceRecord } from './trace-store.js';
import type { PolicyAction } from './trace-driven-policy.js';
import { createLogger } from '../shared/logger.js';
import { genId } from '../shared/utils.js';

const log = createLogger('learning:held-out-gate');

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/**
 * A single test case in the held-out set. Each case represents a known
 * outcome that the system must continue to satisfy after any policy change.
 */
export interface GateTestCase {
  /** Unique identifier for this test case. */
  id: string;
  /** The user intent that was originally routed. */
  intent: string;
  /** Tool that was invoked, if applicable. */
  toolName?: string;
  /** Category tag (e.g. "coding", "analysis"). */
  category?: string;
  /** The model that was selected for this intent under current policy. */
  currentModel: string;
  /** Whether the original outcome was successful. */
  expectedSuccess: boolean;
  /** Maximum acceptable latency in ms. If exceeded, the case is a regression. */
  expectedMaxLatencyMs?: number;
}

/**
 * Result of running a single test case through the proposed policy change.
 * Captures both the outcome and the model the policy would have selected.
 */
export interface GateTestResult {
  /** ID of the GateTestCase this result corresponds to. */
  testCaseId: string;
  /** Whether this test case passed (no regression detected). */
  passed: boolean;
  /** The model the proposed policy would select for this test case. */
  actualModel: string;
  /** Whether the proposed policy would produce a successful outcome. */
  actualSuccess: boolean;
  /** Latency produced by the proposed policy, if available. */
  actualLatencyMs?: number;
  /** Human-readable reason for pass/fail. */
  reason?: string;
}

/**
 * Full evaluation result for a proposed policy change. Returned by
 * HeldOutGate.evaluate(). Contains the pass/fail verdict and detailed
 * regression information for every failing test case.
 */
export interface GateEvaluation {
  /** The proposal ID that was evaluated. */
  proposalId: string;
  /** Whether the proposal passed the gate (passRate >= 1 - tolerance). */
  passed: boolean;
  /** Fraction of test cases that passed (0..1). */
  passRate: number;
  /** The configured tolerance for this evaluation. */
  tolerance: number;
  /** Total test cases evaluated. */
  totalTests: number;
  /** Number of test cases that passed. */
  passedTests: number;
  /** Number of test cases that failed (regressions). */
  failedTests: number;
  /** Human-readable descriptions of each regression. */
  regressionDetails: string[];
}

/** Configuration for the held-out gate. */
export interface GateConfig {
  /** Maximum acceptable regression rate (0.01 = 1% of tests may fail). */
  tolerance: number;
  /** Minimum test cases required before the gate will evaluate a proposal. */
  minTestCases: number;
  /** If true, automatically apply proposals that pass the gate. */
  autoApply: boolean;
  /** If true, track version history so proposals can be rolled back. */
  rollbackEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default configuration: 1% tolerance, 10 min test cases, auto-apply on, rollback on. */
const DEFAULT_CONFIG: GateConfig = {
  tolerance: 0.01,
  minTestCases: 10,
  autoApply: true,
  rollbackEnabled: true,
};

// ---------------------------------------------------------------------------
// Versioned policy snapshot (for rollback support)
// ---------------------------------------------------------------------------

/** A versioned snapshot of an accepted policy change. */
interface PolicyVersion {
  /** Version identifier (proposal ID). */
  versionId: string;
  /** The policy action that was accepted. */
  policyChange: PolicyAction;
  /** ISO timestamp of when this version was applied. */
  appliedAt: string;
  /** The evaluation that justified acceptance. */
  evaluation: GateEvaluation;
}

// ---------------------------------------------------------------------------
// HeldOutGate
// ---------------------------------------------------------------------------

/**
 * Non-regression test gate for self-modification.
 *
 * Any policy change proposed to the system must be evaluated against a held-out
 * test set of known outcomes. If the change would regress more than the
 * configured tolerance, it is rejected outright. This prevents self-reinforcing
 * degradation loops where a locally optimal change causes global harm.
 *
 * Usage:
 *   const gate = new HeldOutGate(traceStore);
 *   gate.addTestCase({ intent: "...", currentModel: "...", expectedSuccess: true });
 *   const result = await gate.evaluate("prop-123", policyChange);
 *   if (!result.passed) { // reject the proposal }
 */
export class HeldOutGate {
  private traceStore: TraceStore;
  private config: GateConfig;

  /** The held-out test set, keyed by test case ID. */
  private testCases: Map<string, GateTestCase> = new Map();

  /** Version history for rollback support. */
  private versionHistory: PolicyVersion[] = [];

  /** Running statistics for monitoring. */
  private totalEvaluations = 0;
  private totalPasses = 0;
  private regressionsBlocked = 0;

  constructor(traceStore: TraceStore, config?: Partial<GateConfig>) {
    this.traceStore = traceStore;
    this.config = { ...DEFAULT_CONFIG, ...config };
    log.info(
      { tolerance: this.config.tolerance, minTestCases: this.config.minTestCases },
      'HeldOutGate initialized',
    );
  }

  // -- Test case management ---------------------------------------------------

  /**
   * Add a test case to the held-out set. Returns the generated ID.
   * The id field is auto-generated and should not be supplied by the caller.
   */
  addTestCase(testCase: Omit<GateTestCase, 'id'>): string {
    const id = `tc:${genId()}`;
    const full: GateTestCase = { id, ...testCase };
    this.testCases.set(id, full);
    log.debug({ id, intent: testCase.intent }, 'Test case added to held-out set');
    return id;
  }

  /**
   * Remove a test case by ID. Returns true if the case existed and was
   * removed, false otherwise.
   */
  removeTestCase(id: string): boolean {
    const removed = this.testCases.delete(id);
    if (removed) {
      log.debug({ id }, 'Test case removed from held-out set');
    }
    return removed;
  }

  /** Return all test cases in the held-out set. */
  getTestCases(): GateTestCase[] {
    return Array.from(this.testCases.values());
  }

  // -- Evaluation -------------------------------------------------------------

  /**
   * Evaluate a proposed policy change against the held-out test set.
   *
   * The proposal is run against every test case. For each case, we simulate
   * the policy change and check whether the outcome would match the expected
   * result. A test case "passes" if:
   *   - The proposed policy does not block the request (when expectedSuccess=true)
   *   - The proposed policy does not redirect to a model with known failures
   *   - Latency would not exceed expectedMaxLatencyMs (if set)
   *
   * If the number of failing cases exceeds tolerance * totalTests, the
   * proposal is rejected. Otherwise it is accepted and optionally versioned
   * for rollback.
   *
   * @param proposalId   - Unique identifier for this proposal.
   * @param policyChange - The policy action being proposed.
   * @returns A GateEvaluation with the verdict and detailed regression info.
   */
  async evaluate(proposalId: string, policyChange: PolicyAction): Promise<GateEvaluation> {
    const cases = this.getTestCases();
    const totalTests = cases.length;
    const regressionDetails: string[] = [];
    const results: GateTestResult[] = [];

    // Enforce minimum test case count.
    if (totalTests < this.config.minTestCases) {
      log.warn(
        { totalTests, minTestCases: this.config.minTestCases },
        'Not enough test cases to evaluate proposal — auto-rejecting',
      );
      return {
        proposalId,
        passed: false,
        passRate: 0,
        tolerance: this.config.tolerance,
        totalTests,
        passedTests: 0,
        failedTests: totalTests,
        regressionDetails: [
          `Insufficient test cases: ${totalTests} < ${this.config.minTestCases} minimum`,
        ],
      };
    }

    // A blocking policy is always suspicious — check each case individually.
    for (const tc of cases) {
      const result = this.evaluateTestCase(tc, policyChange);
      results.push(result);

      if (!result.passed) {
        regressionDetails.push(
          `Case ${tc.id} (${tc.intent.slice(0, 40)}): ${result.reason ?? 'unknown regression'}`,
        );
      }
    }

    const passedTests = results.filter(r => r.passed).length;
    const failedTests = totalTests - passedTests;
    const passRate = totalTests > 0 ? passedTests / totalTests : 0;
    const passed = passRate >= (1 - this.config.tolerance);

    // Update running statistics.
    this.totalEvaluations++;
    if (passed) {
      this.totalPasses++;
    } else {
      this.regressionsBlocked++;
    }

    const evaluation: GateEvaluation = {
      proposalId,
      passed,
      passRate,
      tolerance: this.config.tolerance,
      totalTests,
      passedTests,
      failedTests,
      regressionDetails,
    };

    // If the proposal passed and auto-apply is enabled, record it as a version.
    if (passed && this.config.autoApply) {
      this.applyVersion(proposalId, policyChange, evaluation);
    }

    log.info(
      { proposalId, passed, passRate: passRate.toFixed(3), passedTests, failedTests },
      'Held-out gate evaluation complete',
    );

    return evaluation;
  }

  /**
   * Evaluate a single test case against the proposed policy change.
   *
   * Checks for three regression modes:
   *  1. Block regression: policy blocks a request that should succeed.
   *  2. Model regression: policy redirects to a model with known failures.
   *  3. Latency regression: policy causes latency above the expected max.
   */
  private evaluateTestCase(tc: GateTestCase, policy: PolicyAction): GateTestResult {
    // Mode 1: Block regression.
    // If the test case expects success but the policy blocks it, that is a regression.
    if (policy.block && tc.expectedSuccess) {
      return {
        testCaseId: tc.id,
        passed: false,
        actualModel: policy.preferredModel ?? tc.currentModel,
        actualSuccess: false,
        reason: 'Policy blocks a request that is expected to succeed',
      };
    }

    // Determine which model the policy would select.
    const actualModel = policy.preferredModel ?? tc.currentModel;

    // Mode 2: Model regression.
    // Check whether the proposed model has known failures for this intent/tool.
    // We query the trace store for recent outcomes with the proposed model.
    const traces = this.traceStore.query({
      model: actualModel,
      toolName: tc.toolName,
      success: false,
      limit: 10,
    });

    // If the proposed model has recent failures for this tool, flag it.
    if (traces.length > 0 && tc.expectedSuccess) {
      const failCount = traces.length;
      return {
        testCaseId: tc.id,
        passed: false,
        actualModel,
        actualSuccess: false,
        reason: `Proposed model ${actualModel} has ${failCount} recent failures for tool ${tc.toolName ?? 'unknown'}`,
      };
    }

    // Mode 3: Latency regression.
    // If the policy specifies a cooldown, it may indirectly increase latency.
    // Check against expected max latency if specified.
    if (tc.expectedMaxLatencyMs !== undefined) {
      // Estimate latency from recent traces for the proposed model.
      const recentTraces = this.traceStore.query({
        model: actualModel,
        toolName: tc.toolName,
        limit: 20,
      });
      const avgLatency = averageLatency(recentTraces);

      if (avgLatency > tc.expectedMaxLatencyMs) {
        return {
          testCaseId: tc.id,
          passed: false,
          actualModel,
          actualSuccess: tc.expectedSuccess,
          actualLatencyMs: avgLatency,
          reason: `Latency regression: ${Math.round(avgLatency)}ms > ${tc.expectedMaxLatencyMs}ms max for model ${actualModel}`,
        };
      }

      return {
        testCaseId: tc.id,
        passed: true,
        actualModel,
        actualSuccess: tc.expectedSuccess,
        actualLatencyMs: avgLatency,
      };
    }

    // No regression detected for this test case.
    return {
      testCaseId: tc.id,
      passed: true,
      actualModel,
      actualSuccess: tc.expectedSuccess,
    };
  }

  // -- Auto-generation from traces --------------------------------------------

  /**
   * Generate test cases from historical trace data. Scans the trace store
   * for recent successful outcomes and creates test cases that any future
   * policy change must continue to satisfy.
   *
   * Only traces with success=true are used, since they represent the
   * system's current known-good behavior that must not regress.
   *
   * @returns The number of new test cases generated.
   */
  async generateTestCasesFromTraces(): Promise<number> {
    // Fetch recent successful tool calls to use as gold-standard cases.
    const traces = this.traceStore.query({
      type: 'tool_call',
      success: true,
      limit: 200,
    });

    let generated = 0;

    for (const trace of traces) {
      // Skip traces missing required fields.
      if (!trace.intent || !trace.model) continue;

      // Deduplicate: don't add a test case if one with the same intent
      // and model already exists in the held-out set.
      const isDuplicate = Array.from(this.testCases.values()).some(
        tc => tc.intent === trace.intent && tc.currentModel === trace.model,
      );
      if (isDuplicate) continue;

      this.addTestCase({
        intent: trace.intent,
        toolName: trace.toolName ?? undefined,
        category: trace.category ?? undefined,
        currentModel: trace.model,
        expectedSuccess: true,
        expectedMaxLatencyMs: trace.latencyMs
          ? Math.round(trace.latencyMs * 1.5) // 50% headroom over observed latency
          : undefined,
      });

      generated++;
    }

    log.info({ generated }, 'Test cases auto-generated from traces');
    return generated;
  }

  // -- Version management / rollback ------------------------------------------

  /**
   * Record an accepted policy as a versioned snapshot for rollback.
   */
  private applyVersion(
    proposalId: string,
    policyChange: PolicyAction,
    evaluation: GateEvaluation,
  ): void {
    if (!this.config.rollbackEnabled) return;

    this.versionHistory.push({
      versionId: proposalId,
      policyChange,
      appliedAt: new Date().toISOString(),
      evaluation,
    });

    log.debug({ proposalId }, 'Policy version recorded for rollback');
  }

  /**
   * Roll back to the state before a given proposal was applied.
   * Removes the version from history and returns the policy that was rejected.
   * Returns null if the proposal was not found or rollback is disabled.
   */
  rollback(proposalId: string): PolicyAction | null {
    if (!this.config.rollbackEnabled) {
      log.warn('Rollback requested but rollback is disabled in config');
      return null;
    }

    const idx = this.versionHistory.findIndex(v => v.versionId === proposalId);
    if (idx === -1) {
      log.warn({ proposalId }, 'Rollback failed: proposal not found in version history');
      return null;
    }

    const [removed] = this.versionHistory.splice(idx, 1);
    log.info({ proposalId }, 'Policy version rolled back');
    return removed.policyChange;
  }

  /** Return all versioned policy snapshots (for auditing). */
  getVersionHistory(): PolicyVersion[] {
    return [...this.versionHistory];
  }

  // -- Statistics -------------------------------------------------------------

  /** Return running statistics about the gate's operation. */
  getStats(): {
    totalEvaluations: number;
    passRate: number;
    regressionsBlocked: number;
    testCases: number;
  } {
    return {
      totalEvaluations: this.totalEvaluations,
      passRate: this.totalEvaluations > 0
        ? this.totalPasses / this.totalEvaluations
        : 0,
      regressionsBlocked: this.regressionsBlocked,
      testCases: this.testCases.size,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute the average latency from a set of trace records. Returns 0 if empty. */
function averageLatency(traces: TraceRecord[]): number {
  const latencies = traces
    .map(t => t.latencyMs)
    .filter((v): v is number => v !== undefined && v !== null);
  if (latencies.length === 0) return 0;
  return latencies.reduce((sum, l) => sum + l, 0) / latencies.length;
}