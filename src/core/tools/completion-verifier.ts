/**
 * @file completion-verifier.ts
 * @description Task Completion Verifier — addresses the #1 community complaint
 * across ALL agent platforms: "Phantom Task Completion".
 *
 * OpenClaw GitHub issue #40082 (4,200+ filings): agent says "Done" but returns
 * placeholder or partial results. The trust gap between reported success and
 * actual completion is the community's biggest credibility problem.
 *
 * Hermes suffers the same: self-evaluation is unreliable — "it almost always
 * thinks it did a good job even when it did not."
 *
 * This module provides verification BEFORE reporting task completion:
 *   1. Placeholder detection — empty strings, "N/A", TODO, stub patterns
 *   2. Output size validation — too small = likely incomplete
 *   3. Content quality scoring — heuristic quality assessment
 *   4. Cross-reference validation — verify against the original request
 *   5. Confidence scoring — only report Done when confidence is high
 *   6. Auto-retry with different approach when verification fails
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('tools:completion-verifier');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Severity of a verification issue. */
export type VerificationSeverity = 'pass' | 'warn' | 'fail';

/** A single verification check result. */
export interface VerificationCheck {
  name: string;
  severity: VerificationSeverity;
  message: string;
  details?: string;
}

/** Complete verification result for a task completion. */
export interface CompletionVerification {
  /** Overall pass/fail. */
  passed: boolean;
  /** Confidence score 0-100. */
  confidence: number;
  /** Individual check results. */
  checks: VerificationCheck[];
  /** If verification failed, suggested retry strategy. */
  retryStrategy?: RetryStrategy;
  /** Timestamp. */
  verifiedAt: string;
}

/** Strategy for retrying a failed task. */
export interface RetryStrategy {
  approach: 'rephrase' | 'decompose' | 'switch_model' | 'add_context';
  reason: string;
  suggestedPrompt?: string;
}

/** Configuration for the completion verifier. */
export interface CompletionVerifierConfig {
  /** Minimum confidence to consider a task "done" (0-100). */
  minConfidence: number;
  /** Minimum output length in characters. */
  minOutputLength: number;
  /** Maximum placeholder patterns to check. */
  placeholderPatterns: string[];
  /** Whether to auto-retry on failure. */
  autoRetry: boolean;
  /** Maximum retry attempts. */
  maxRetries: number;
}

const DEFAULT_CONFIG: Readonly<CompletionVerifierConfig> = {
  minConfidence: 70,
  minOutputLength: 20,
  placeholderPatterns: [
    'N/A', 'TODO', 'FIXME', 'PLACEHOLDER', 'STUB',
    'Not implemented', 'not yet implemented', 'coming soon',
    'work in progress', 'TBD', 'TBS', 'to be determined',
    'placeholder', 'dummy', 'test test', 'lorem ipsum',
    'insert here', 'your content here', 'fill in',
    '...', '—', '---',
  ],
  autoRetry: true,
  maxRetries: 2,
};

// ---------------------------------------------------------------------------
// Placeholder detection patterns (compiled once)
// ---------------------------------------------------------------------------

/** Regex patterns that strongly indicate placeholder content. */
const PLACEHOLDER_REGEXES: RegExp[] = [
  /^[\s]*$/i,                           // empty/whitespace only
  /^(N\/A|TBD|TBS|TODO|FIXME|STUB)\.?$/i, // standalone placeholder words
  /^(test|dummy|placeholder|lorem)/i,   // common filler starts
  /^(insert|fill|your)\s+(your|the|content)/i, // template instructions
  /^(coming\s+soon|work\s+in\s+progress)/i, // WIP markers
  /^(not\s+yet|not\s+implemented)/i,    // unimplemented markers
  /^\.{3,}$/,                           // just ellipsis
  /^[-—]{3,}$/,                         // just dashes
];

// ---------------------------------------------------------------------------
// CompletionVerifier
// ---------------------------------------------------------------------------

/**
 * Verifies task completion before reporting "Done" — addressing the
 * #1 community complaint across OpenClaw (4,200+ issues) and Hermes
 * (unreliable self-evaluation).
 *
 * Usage: Before reporting task completion, pass the result through
 * `verifier.verify(output, originalRequest)` and only report "Done"
 * if `result.passed && result.confidence >= minConfidence`.
 */
export class CompletionVerifier {
  private readonly config: Readonly<CompletionVerifierConfig>;
  private readonly stats = {
    totalVerifications: 0,
    passed: 0,
    failed: 0,
    retried: 0,
    autoRetriesSucceeded: 0,
  };

  constructor(config?: Partial<CompletionVerifierConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    log.info(
      { minConfidence: this.config.minConfidence, minOutputLength: this.config.minOutputLength },
      'CompletionVerifier initialized',
    );
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Verify that a task's output represents genuine completion.
   *
   * @param output          - The tool/task output string to verify.
   * @param originalRequest - The original user request for cross-reference.
   * @returns Verification result with confidence score and check details.
   */
  verify(output: string, originalRequest?: string): CompletionVerification {
    this.stats.totalVerifications++;

    const checks: VerificationCheck[] = [];
    let confidence = 100; // Start at 100, deduct for each issue

    // Check 1: Placeholder detection
    const placeholderCheck = this._checkPlaceholders(output);
    checks.push(placeholderCheck);
    if (placeholderCheck.severity === 'fail') confidence -= 50;
    else if (placeholderCheck.severity === 'warn') confidence -= 15;

    // Check 2: Output length
    const lengthCheck = this._checkOutputLength(output);
    checks.push(lengthCheck);
    if (lengthCheck.severity === 'fail') confidence -= 40;
    else if (lengthCheck.severity === 'warn') confidence -= 10;

    // Check 3: Content quality
    const qualityCheck = this._checkContentQuality(output);
    checks.push(qualityCheck);
    if (qualityCheck.severity === 'fail') confidence -= 30;
    else if (qualityCheck.severity === 'warn') confidence -= 10;

    // Check 4: Cross-reference with original request (if provided)
    if (originalRequest) {
      const crossRefCheck = this._checkCrossReference(output, originalRequest);
      checks.push(crossRefCheck);
      if (crossRefCheck.severity === 'fail') confidence -= 25;
      else if (crossRefCheck.severity === 'warn') confidence -= 10;
    }

    // Check 5: Structural completeness
    const structureCheck = this._checkStructuralCompleteness(output);
    checks.push(structureCheck);
    if (structureCheck.severity === 'fail') confidence -= 20;
    else if (structureCheck.severity === 'warn') confidence -= 5;

    // Clamp confidence
    confidence = Math.max(0, Math.min(100, confidence));

    const passed = confidence >= this.config.minConfidence;

    // Determine retry strategy if verification failed
    let retryStrategy: RetryStrategy | undefined;
    if (!passed) {
      retryStrategy = this._determineRetryStrategy(checks, output, originalRequest);
      this.stats.failed++;
    } else {
      this.stats.passed++;
    }

    const result: CompletionVerification = {
      passed,
      confidence,
      checks,
      retryStrategy,
      verifiedAt: new Date().toISOString(),
    };

    // debug-level: callers that wire this into a per-turn path (e.g. the agent
    // loop's SUDO_COMPLETION_VERIFY block) log the result themselves, so keep
    // the module's own per-call line off the info channel to avoid double-logging.
    log.debug(
      { passed, confidence, checkCount: checks.length },
      'Completion verification complete',
    );

    return result;
  }

  /**
   * Verify and optionally auto-retry a task.
   * Returns the original output if verification passes, or the retry
   * output if auto-retry succeeds, or null if all attempts fail.
   */
  async verifyWithRetry(
    output: string,
    originalRequest: string,
    retryFn?: (strategy: RetryStrategy) => Promise<string>,
  ): Promise<{ output: string; verification: CompletionVerification } | null> {
    let currentOutput = output;
    let attempts = 0;

    while (attempts <= this.config.maxRetries) {
      const verification = this.verify(currentOutput, originalRequest);

      if (verification.passed) {
        if (attempts > 0) this.stats.autoRetriesSucceeded++;
        return { output: currentOutput, verification };
      }

      // Cannot retry
      if (!this.config.autoRetry || !retryFn || !verification.retryStrategy) {
        return { output: currentOutput, verification };
      }

      if (attempts >= this.config.maxRetries) {
        log.warn({ attempts }, 'Max retries reached — returning last output');
        return { output: currentOutput, verification };
      }

      attempts++;
      this.stats.retried++;
      log.info({ attempt: attempts, strategy: verification.retryStrategy.approach }, 'Auto-retrying task');

      try {
        currentOutput = await retryFn(verification.retryStrategy);
      } catch (err) {
        log.error({ attempt: attempts, err }, 'Retry attempt failed');
        break;
      }
    }

    // All retries failed — return last verification
    const finalVerification = this.verify(currentOutput, originalRequest);
    return { output: currentOutput, verification: finalVerification };
  }

  /**
   * Get verification statistics.
   */
  getStats(): typeof this.stats & { passRate: number } {
    const total = this.stats.totalVerifications;
    return {
      ...this.stats,
      passRate: total > 0 ? Math.round((this.stats.passed / total) * 100) : 100,
    };
  }

  // -------------------------------------------------------------------------
  // Individual checks
  // -------------------------------------------------------------------------

  private _checkPlaceholders(output: string): VerificationCheck {
    const trimmed = output.trim();

    // Check against regex patterns
    for (const regex of PLACEHOLDER_REGEXES) {
      if (regex.test(trimmed)) {
        return {
          name: 'placeholder_detection',
          severity: 'fail',
          message: 'Output matches placeholder pattern',
          details: `Matched: ${regex.source}`,
        };
      }
    }

    // Check against known placeholder strings
    const lower = trimmed.toLowerCase();
    for (const pattern of this.config.placeholderPatterns) {
      if (lower === pattern.toLowerCase() || lower.startsWith(pattern.toLowerCase())) {
        return {
          name: 'placeholder_detection',
          severity: 'fail',
          message: `Output is a known placeholder: "${pattern}"`,
        };
      }
    }

    // Check for very short outputs that are likely placeholders
    if (trimmed.length < 5 && trimmed.length > 0) {
      return {
        name: 'placeholder_detection',
        severity: 'warn',
        message: 'Output is suspiciously short',
        details: `Length: ${trimmed.length} chars`,
      };
    }

    return {
      name: 'placeholder_detection',
      severity: 'pass',
      message: 'No placeholder patterns detected',
    };
  }

  private _checkOutputLength(output: string): VerificationCheck {
    const len = output.trim().length;

    if (len === 0) {
      return {
        name: 'output_length',
        severity: 'fail',
        message: 'Output is empty',
      };
    }

    if (len < this.config.minOutputLength) {
      return {
        name: 'output_length',
        severity: 'fail',
        message: `Output too short (${len} chars, minimum ${this.config.minOutputLength})`,
      };
    }

    if (len < 50) {
      return {
        name: 'output_length',
        severity: 'warn',
        message: `Output is very short (${len} chars) — may be incomplete`,
      };
    }

    return {
      name: 'output_length',
      severity: 'pass',
      message: `Output length is adequate (${len} chars)`,
    };
  }

  private _checkContentQuality(output: string): VerificationCheck {
    const trimmed = output.trim();

    // Check for repetitive content (same line repeated)
    const lines = trimmed.split('\n').filter(l => l.trim().length > 0);
    if (lines.length > 2) {
      const unique = new Set(lines.map(l => l.trim()));
      const repetitionRatio = 1 - unique.size / lines.length;
      if (repetitionRatio > 0.8) {
        return {
          name: 'content_quality',
          severity: 'fail',
          message: 'Output is highly repetitive',
          details: `${Math.round(repetitionRatio * 100)}% of lines are duplicates`,
        };
      }
      if (repetitionRatio > 0.5) {
        return {
          name: 'content_quality',
          severity: 'warn',
          message: 'Output has significant repetition',
          details: `${Math.round(repetitionRatio * 100)}% of lines are duplicates`,
        };
      }
    }

    // Check for error messages disguised as output
    const errorPatterns = [
      /error:\s*.+/i,
      /exception:\s*.+/i,
      /failed\s+to\s+/i,
      /cannot\s+.+/i,
      /unable\s+to\s+/i,
    ];

    for (const pattern of errorPatterns) {
      if (pattern.test(trimmed) && trimmed.length < 200) {
        return {
          name: 'content_quality',
          severity: 'fail',
          message: 'Output appears to be an error message, not a result',
          details: `Matched: ${pattern.source}`,
        };
      }
    }

    // Check for very low information density (ratio of unique words to total)
    const words = trimmed.split(/\s+/).filter(w => w.length > 2);
    if (words.length > 10) {
      const uniqueWords = new Set(words.map(w => w.toLowerCase()));
      const density = uniqueWords.size / words.length;
      if (density < 0.2) {
        return {
          name: 'content_quality',
          severity: 'warn',
          message: 'Low information density — may be boilerplate',
          details: `Unique word ratio: ${Math.round(density * 100)}%`,
        };
      }
    }

    return {
      name: 'content_quality',
      severity: 'pass',
      message: 'Content quality appears adequate',
    };
  }

  /**
   * Cross-reference the output against key terms in the request. NOTE: the
   * fail/warn paths only fire when the request has MORE THAN 2 content terms
   * (after stop-word stripping) — very short requests skip this check (returns
   * pass) to avoid false positives on terse asks like "fix bug".
   */
  private _checkCrossReference(output: string, originalRequest: string): VerificationCheck {
    const reqLower = originalRequest.toLowerCase();
    const outLower = output.toLowerCase();

    // Extract key terms from the original request
    const stopWords = new Set([
      'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been',
      'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
      'would', 'could', 'should', 'may', 'might', 'can', 'shall',
      'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
      'as', 'into', 'about', 'it', 'this', 'that', 'these', 'those',
      'i', 'me', 'my', 'we', 'our', 'you', 'your', 'please', 'and',
      'or', 'but', 'not', 'if', 'then', 'so', 'than', 'too', 'very',
    ]);

    const reqWords = reqLower.split(/\s+/)
      .filter(w => w.length > 3 && !stopWords.has(w));
    const reqKeyTerms = new Set(reqWords);

    // Check if output addresses the key terms from the request
    let matchedTerms = 0;
    for (const term of reqKeyTerms) {
      if (outLower.includes(term)) {
        matchedTerms++;
      }
    }

    const coverageRatio = reqKeyTerms.size > 0 ? matchedTerms / reqKeyTerms.size : 1;

    if (coverageRatio < 0.2 && reqKeyTerms.size > 2) {
      return {
        name: 'cross_reference',
        severity: 'fail',
        message: 'Output does not address the original request',
        details: `Key term coverage: ${Math.round(coverageRatio * 100)}% (${matchedTerms}/${reqKeyTerms.size})`,
      };
    }

    if (coverageRatio < 0.5 && reqKeyTerms.size > 2) {
      return {
        name: 'cross_reference',
        severity: 'warn',
        message: 'Output may not fully address the original request',
        details: `Key term coverage: ${Math.round(coverageRatio * 100)}% (${matchedTerms}/${reqKeyTerms.size})`,
      };
    }

    return {
      name: 'cross_reference',
      severity: 'pass',
      message: 'Output addresses the original request',
      details: `Key term coverage: ${Math.round(coverageRatio * 100)}%`,
    };
  }

  private _checkStructuralCompleteness(output: string): VerificationCheck {
    const trimmed = output.trim();

    // Check for truncated code blocks
    const codeBlockStarts = (trimmed.match(/```/g) || []).length;
    if (codeBlockStarts % 2 !== 0) {
      return {
        name: 'structural_completeness',
        severity: 'fail',
        message: 'Unclosed code block — output appears truncated',
      };
    }

    // Check for unclosed brackets in code-like content
    const openBrackets = (trimmed.match(/[({[]/g) || []).length;
    const closeBrackets = (trimmed.match(/[)}\]]/g) || []).length;
    const bracketDiff = Math.abs(openBrackets - closeBrackets);
    if (bracketDiff > 3 && trimmed.includes('```')) {
      return {
        name: 'structural_completeness',
        severity: 'warn',
        message: 'Unbalanced brackets in code — may be truncated',
        details: `Open: ${openBrackets}, Close: ${closeBrackets}`,
      };
    }

    // Check for sentences that end mid-word (common truncation sign)
    if (trimmed.endsWith('…') || /[a-z]$/.test(trimmed.split('\n').pop() ?? '')) {
      return {
        name: 'structural_completeness',
        severity: 'warn',
        message: 'Output may be truncated (ends mid-word or with ellipsis)',
      };
    }

    return {
      name: 'structural_completeness',
      severity: 'pass',
      message: 'Output structure appears complete',
    };
  }

  // -------------------------------------------------------------------------
  // Retry strategy
  // -------------------------------------------------------------------------

  private _determineRetryStrategy(
    checks: VerificationCheck[],
    output: string,
    originalRequest?: string,
  ): RetryStrategy {
    const failedChecks = checks.filter(c => c.severity === 'fail');

    // If the output is empty or a placeholder, rephrase the request
    if (failedChecks.some(c => c.name === 'placeholder_detection' || c.name === 'output_length')) {
      return {
        approach: 'rephrase',
        reason: 'Output was empty or a placeholder — rephrasing request for clarity',
        suggestedPrompt: originalRequest
          ? `Please provide a complete and detailed response to: ${originalRequest}. Include specific content, not placeholders.`
          : undefined,
      };
    }

    // If cross-reference failed, add more context
    if (failedChecks.some(c => c.name === 'cross_reference')) {
      return {
        approach: 'add_context',
        reason: 'Output did not address the original request — adding more context',
        suggestedPrompt: originalRequest
          ? `Focus specifically on: ${originalRequest}. Address each key point mentioned in the request.`
          : undefined,
      };
    }

    // If structural issues, try decomposing the task
    if (failedChecks.some(c => c.name === 'structural_completeness')) {
      return {
        approach: 'decompose',
        reason: 'Output was truncated — decomposing into smaller subtasks',
      };
    }

    // Default: try a different model
    return {
      approach: 'switch_model',
      reason: 'Output quality was low — trying with a different model',
    };
  }
}