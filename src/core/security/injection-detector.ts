/**
 * @file injection-detector.ts
 * @description Upgrade 42 — Standalone prompt injection detection for tool results.
 *
 * Detects when a tool result attempts to hijack the agent via injected instructions.
 * Exported functions are distinct from SecurityGuard.detectInjection to avoid conflicts.
 */

import { createLogger } from '../shared/logger.js';
import type { InspectionQueueInstance } from './inspection-queue.js';

const log = createLogger('security:injection');

// ---------------------------------------------------------------------------
// Module-level optional inspection queue (set by app bootstrap)
// ---------------------------------------------------------------------------

let _inspectionQueue: InspectionQueueInstance | null = null;

/**
 * Register an InspectionQueueInstance so the detector can enqueue flagged results.
 * Call once at app bootstrap. Safe to call multiple times (last wins).
 */
export function setInspectionQueue(queue: InspectionQueueInstance): void {
  _inspectionQueue = queue;
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const INJECTION_PATTERNS: RegExp[] = [
  /ignore (all )?(previous|prior|above) instructions/i,
  /you are now/i,
  /new instructions:/i,
  /system:\s*override/i,
  /forget (everything|all|your)/i,
  /disregard (all|your|the)/i,
  /act as (a|an) /i,
  /pretend (you are|to be)/i,
  /<\/?system>/i,
  /\[INST\]/i,
  /\[\/INST\]/i,
  /<<SYS>>/i,
  /\bHuman:\s/i,
  /\bAssistant:\s/i,
  /BEGIN INJECTION/i,
];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface InjectionResult {
  detected: boolean;
  score: number;
  patterns: string[];
  source: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan arbitrary text for prompt-injection signals.
 *
 * @param text   - Content to analyse (tool result, web-scrape, etc.)
 * @param source - Human-readable label for log attribution.
 * @returns InjectionResult with `detected = true` when score >= 2/3 of patterns match.
 */
export function detectInjection(text: string, source: string = 'unknown'): InjectionResult {
  if (!text || typeof text !== 'string') {
    return { detected: false, score: 0, patterns: [], source };
  }

  const matches: string[] = [];

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      matches.push(pattern.source);
    }
  }

  const score = Math.min(matches.length / 3, 1);

  if (matches.length > 0) {
    log.warn(
      { source, score: score.toFixed(2), matchCount: matches.length },
      'Potential prompt injection detected',
    );
  }

  return {
    detected: matches.length >= 2,
    score,
    patterns: matches,
    source,
  };
}

/**
 * Sanitize a tool result before it is passed back into the agent context.
 *
 * If injection is detected the result is truncated and wrapped with a warning
 * header. The agent can still see the beginning of the content but the
 * injected instructions are defused by the prepended warning framing.
 *
 * @param result   - Raw string returned by the tool.
 * @param toolName - Tool identifier for logging and user-facing messages.
 */
export function sanitizeToolResult(
  result: string,
  toolName: string,
): { safe: boolean; sanitized: string; warning?: string } {
  if (!result || typeof result !== 'string') {
    return { safe: true, sanitized: result ?? '' };
  }

  const check = detectInjection(result, toolName);

  if (check.detected) {
    const warning = `Tool "${toolName}" returned content with ${check.patterns.length} injection pattern(s) (score: ${check.score.toFixed(2)}). Review before trusting.`;

    log.error({ toolName, score: check.score, patternCount: check.patterns.length }, warning);

    if (_inspectionQueue !== null) {
      try {
        _inspectionQueue.enqueue({
          source: toolName,
          category: 'inbound',
          severity: check.score >= 0.67 ? 'high' : 'medium',
          fullPayload: result,
          patternMatches: check.patterns,
        });
      } catch (err) {
        log.warn({ toolName, err }, 'Failed to enqueue injection detection result — sanitization unaffected');
      }
    }

    return {
      safe: false,
      sanitized:
        `[TOOL RESULT FLAGGED: potential prompt injection from ${toolName}. ` +
        `Score: ${check.score.toFixed(2)}]\n` +
        result.substring(0, 500) +
        '...',
      warning,
    };
  }

  return { safe: true, sanitized: result };
}
