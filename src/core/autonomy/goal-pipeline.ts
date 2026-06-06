/**
 * @file goal-classifier.ts
 * @description Goal Classifier — classifies incoming tasks into goal types
 * with evidence-based confidence scoring. Grok Build CLI parity.
 *
 * The classifier determines:
 *   - Task type (bug_fix, feature, refactor, research, deployment, etc.)
 *   - Complexity (trivial, moderate, complex, critical)
 *   - Confidence (0-1) based on signal strength
 *   - Suggested approach and estimated steps
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('autonomy:goal-classifier');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GoalType =
  | 'bug_fix'
  | 'feature'
  | 'refactor'
  | 'research'
  | 'deployment'
  | 'testing'
  | 'documentation'
  | 'configuration'
  | 'security'
  | 'optimization'
  | 'integration'
  | 'unknown';

export type GoalComplexity = 'trivial' | 'moderate' | 'complex' | 'critical';

export interface GoalClassification {
  /** Classified goal type. */
  type: GoalType;
  /** Estimated complexity. */
  complexity: GoalComplexity;
  /** Confidence score 0-1 (higher = more certain). */
  confidence: number;
  /** Human-readable evidence for the classification. */
  evidence: string[];
  /** Suggested number of steps to complete. */
  estimatedSteps: number;
  /** Suggested approach strategy. */
  suggestedApproach: string;
}

// ---------------------------------------------------------------------------
// Keyword patterns for classification
// ---------------------------------------------------------------------------

const TYPE_PATTERNS: Record<GoalType, RegExp[]> = {
  bug_fix:       [/\bbug\b/i, /\bfix\b/i, /\berror\b/i, /\bcrash\b/i, /\bbroken\b/i, /\bissue\b/i, /\bfailing\b/i, /\bregression\b/i],
  feature:       [/\badd\b/i, /\bimplement\b/i, /\bcreate\b/i, /\bbuild\b/i, /\bsupport\b/i, /\benable\b/i, /\bnew\b.*\bfeature\b/i],
  refactor:      [/\brefactor\b/i, /\bcleanup\b/i, /\bclean up\b/i, /\breorganize\b/i, /\bsimplify\b/i, /\bconsolidate\b/i],
  research:      [/\binvestigate\b/i, /\bresearch\b/i, /\banalyze\b/i, /\bexplore\b/i, /\bunderstand\b/i, /\bfind out\b/i],
  deployment:    [/\bdeploy\b/i, /\brelease\b/i, /\bpublish\b/i, /\bship\b/i, /\brollout\b/i, /\blaunch\b/i],
  testing:       [/\btest\b/i, /\bunit test\b/i, /\bspec\b/i, /\bcoverage\b/i, /\bverify\b/i, /\bassert\b/i],
  documentation: [/\bdoc\b/i, /\bdocument\b/i, /\breadme\b/i, /\bguide\b/i, /\btutorial\b/i, /\bcomment\b/i],
  configuration: [/\bconfig\b/i, /\bconfigure\b/i, /\bsetup\b/i, /\bsetting\b/i, /\benv\b/i, /\boption\b/i],
  security:      [/\bsecurity\b/i, /\bvulnerability\b/i, /\bexploit\b/i, /\bpatch\b/i, /\bauth\b/i, /\bencrypt\b/i],
  optimization:  [/\boptimize\b/i, /\bperformance\b/i, /\bspeed\b/i, /\bfaster\b/i, /\breduce\b/i, /\bimprove\b.*\bspeed\b/i],
  integration:   [/\bintegrate\b/i, /\bconnect\b/i, /\bapi\b/i, /\bwebhook\b/i, /\bpartner\b/i],
  unknown:       [],
};

const COMPLEXITY_SIGNALS: Record<GoalComplexity, RegExp[]> = {
  trivial:   [/\bquick\b/i, /\bsimple\b/i, /\bone[- ]liner\b/i, /\bminor\b/i],
  moderate:  [/\bmoderate\b/i, /\bseveral\b/i, /\bmulti[- ]step\b/i],
  complex:   [/\bcomplex\b/i, /\barchitect\b/i, /\bdesign\b/i, /\bfull\b/i, /\bend[- ]to[- ]end\b/i],
  critical:  [/\bcritical\b/i, /\burgent\b/i, /\bproduction\b/i, /\boutage\b/i, /\bemergency\b/i],
};

// ---------------------------------------------------------------------------
// GoalClassifier
// ---------------------------------------------------------------------------

/**
 * Classifies incoming user tasks into structured goal types with confidence.
 *
 * Grok Build CLI uses a 4-stage goal pipeline:
 *   1. GoalClassifier (this) — classifies the task
 *   2. GoalPlanner — creates a structured plan from the classification
 *   3. GoalTracker — tracks execution progress via update_goal tool
 *   4. GoalStopDetector — detects when the goal is complete
 *
 * Usage:
 * ```ts
 * const classifier = new GoalClassifier();
 * const result = classifier.classify('Fix the login bug that crashes on empty password');
 * // result.type = 'bug_fix', result.complexity = 'moderate', result.confidence = 0.85
 * ```
 */
export class GoalClassifier {
  /**
   * Classify a user message into a structured goal type.
   *
   * @param message - The user's task description.
   * @returns GoalClassification with type, complexity, confidence, and evidence.
   */
  classify(message: string): GoalClassification {
    if (!message || typeof message !== 'string') {
      return {
        type: 'unknown',
        complexity: 'trivial',
        confidence: 0,
        evidence: ['Empty or invalid message'],
        estimatedSteps: 1,
        suggestedApproach: 'Ask the user for clarification',
      };
    }

    // Score each type by pattern match count and specificity
    const typeScores = this._scoreTypes(message);
    const bestType = this._selectBest(typeScores);

    // Score complexity
    const complexity = this._classifyComplexity(message);

    // Calculate confidence based on signal strength
    const confidence = this._calculateConfidence(typeScores, bestType);

    // Estimate steps based on type and complexity
    const estimatedSteps = this._estimateSteps(bestType.type, complexity);

    // Generate suggested approach
    const suggestedApproach = this._suggestApproach(bestType.type, complexity);

    log.info(
      { type: bestType.type, complexity, confidence, matches: bestType.count },
      'Goal classified',
    );

    return {
      type: bestType.type,
      complexity,
      confidence,
      evidence: bestType.evidence,
      estimatedSteps,
      suggestedApproach,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _scoreTypes(message: string): Array<{ type: GoalType; count: number; evidence: string[] }> {
    const results: Array<{ type: GoalType; count: number; evidence: string[] }> = [];

    for (const [type, patterns] of Object.entries(TYPE_PATTERNS)) {
      if (type === 'unknown') continue;
      const evidence: string[] = [];
      let count = 0;

      for (const pattern of patterns) {
        const matches = message.match(pattern);
        if (matches) {
          count += matches.length;
          evidence.push(matches[0]);
        }
      }

      results.push({ type: type as GoalType, count, evidence });
    }

    // Sort by match count descending
    results.sort((a, b) => b.count - a.count);
    return results;
  }

  private _selectBest(scores: Array<{ type: GoalType; count: number; evidence: string[] }>): {
    type: GoalType;
    count: number;
    evidence: string[];
  } {
    if (scores.length === 0 || scores[0].count === 0) {
      return { type: 'unknown', count: 0, evidence: ['No strong pattern match'] };
    }
    return scores[0];
  }

  private _classifyComplexity(message: string): GoalComplexity {
    let maxScore = 0;
    let best: GoalComplexity = 'moderate'; // default

    for (const [level, patterns] of Object.entries(COMPLEXITY_SIGNALS)) {
      let score = 0;
      for (const pattern of patterns) {
        if (pattern.test(message)) score++;
      }
      if (score > maxScore) {
        maxScore = score;
        best = level as GoalComplexity;
      }
    }

    return best;
  }

  private _calculateConfidence(
    scores: Array<{ type: GoalType; count: number }>,
    best: { type: GoalType; count: number },
  ): number {
    if (best.count === 0) return 0.1;

    const totalMatches = scores.reduce((sum, s) => sum + s.count, 0);
    if (totalMatches === 0) return 0.1;

    // Confidence = best / total, scaled to 0.3–1.0 range
    const rawRatio = best.count / totalMatches;
    return Math.min(1, Math.max(0.3, 0.3 + rawRatio * 0.7));
  }

  private _estimateSteps(type: GoalType, complexity: GoalComplexity): number {
    const baseSteps: Record<GoalType, number> = {
      bug_fix: 3, feature: 5, refactor: 4, research: 3,
      deployment: 4, testing: 3, documentation: 2, configuration: 2,
      security: 5, optimization: 4, integration: 4, unknown: 2,
    };
    const complexityMultiplier: Record<GoalComplexity, number> = {
      trivial: 0.5, moderate: 1, complex: 1.5, critical: 2,
    };

    return Math.max(1, Math.round(
      (baseSteps[type] ?? 2) * (complexityMultiplier[complexity] ?? 1),
    ));
  }

  private _suggestApproach(type: GoalType, complexity: GoalComplexity): string {
    const approaches: Record<GoalType, string> = {
      bug_fix: 'Reproduce the bug, identify root cause, implement fix, verify with tests',
      feature: 'Design interface, implement core logic, add tests, update documentation',
      refactor: 'Identify code smells, plan restructuring, make incremental changes, verify tests pass',
      research: 'Define scope, search documentation, analyze findings, synthesize report',
      deployment: 'Prepare build, run tests, stage deployment, verify in staging, promote to production',
      testing: 'Identify test cases, write unit tests, add integration tests, verify coverage',
      documentation: 'Identify audience, draft content, add examples, review and publish',
      configuration: 'Identify settings needed, update config files, validate, test end-to-end',
      security: 'Identify vulnerability, assess impact, implement fix, add regression test',
      optimization: 'Profile bottleneck, implement optimization, benchmark, verify no regressions',
      integration: 'Study API contract, implement client, add error handling, test integration',
      unknown: 'Analyze the request, break into subtasks, execute step by step',
    };

    let approach = approaches[type] ?? approaches.unknown;
    if (complexity === 'critical') {
      approach = `URGENT: ${approach}. Consider rollback plan and monitoring.`;
    }
    return approach;
  }
}