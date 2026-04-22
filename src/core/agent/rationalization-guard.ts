import { createLogger } from '../shared/logger.js';
import type { InspectionQueueInstance } from '../security/inspection-queue.js';

const log = createLogger('agent:rationalization-guard');

export interface RationalizationCheck {
  detected: boolean;
  patterns: string[];
  severity: 'low' | 'medium' | 'high';
  recommendation: string;
}

/**
 * Patterns that LLMs use to rationalize skipping safety checks.
 * Sourced from Claude Code's verification agent — these are the exact
 * shortcuts production AI systems are trained to resist.
 */
const RATIONALIZATION_PATTERNS: Array<{
  pattern: RegExp;
  label: string;
  severity: 'low' | 'medium' | 'high';
}> = [
  // "It's just a test" family
  {
    pattern: /\b(it'?s just a test|only a test|just testing|just a demo|just a simulation)\b/i,
    label: 'just-a-test',
    severity: 'medium',
  },
  // "The user said it's fine" family
  {
    pattern:
      /\b(user (said|confirmed|approved|authorized|gave permission)|user (said|told me) (it'?s|it was) (ok|okay|fine|allowed|safe))\b/i,
    label: 'user-permission-claim',
    severity: 'high',
  },
  // "This is an exception" family
  {
    pattern:
      /\b(this (case|situation|time|instance) is (different|special|an exception|unique|fine))\b/i,
    label: 'special-exception',
    severity: 'medium',
  },
  // "I'll fix it later" family
  {
    pattern:
      /\b(fix (it|this) later|come back (to|and fix)|clean up later|temporary|just for now|quick fix)\b/i,
    label: 'ill-fix-it-later',
    severity: 'low',
  },
  // "It won't matter" family
  {
    pattern:
      /\b(won'?t (matter|cause issues?|be a problem)|doesn'?t (really )?matter|no one will notice|harmless)\b/i,
    label: 'wont-matter',
    severity: 'medium',
  },
  // "The other system handles it" family
  {
    pattern:
      /\b((another|other|the other) (system|layer|component|service|tool) (will|handles?|takes? care of))\b/i,
    label: 'other-system-handles-it',
    severity: 'high',
  },
  // "It's already done" (fait accompli)
  {
    pattern:
      /\b(already (done|committed|deployed|sent|executed)|can'?t undo|no going back)\b/i,
    label: 'fait-accompli',
    severity: 'high',
  },
  // "The risk is acceptable" without evidence
  {
    pattern: /\b(risk is (acceptable|low|minimal|negligible)|acceptable risk|low risk)\b/i,
    label: 'unsupported-risk-claim',
    severity: 'medium',
  },
  // "Everyone does this"
  {
    pattern:
      /\b(everyone (does|is doing)|standard (practice|approach)|industry standard|common practice)\b/i,
    label: 'everyone-does-it',
    severity: 'low',
  },
  // "I'm authorized to do this"
  {
    pattern: /\b(i('?m| am) authorized|i have (permission|access|authority)|was told to)\b/i,
    label: 'self-authorization',
    severity: 'high',
  },
  // "It's reversible" (when it isn't)
  {
    pattern:
      /\b(easily (reversed?|undone?|rolled back)|can (reverse|undo|rollback) (this|it) (easily|anytime|later))\b/i,
    label: 'false-reversibility',
    severity: 'medium',
  },
  // Scope creep rationalization
  {
    pattern:
      /\b(while (i'?m|i am|we'?re) (here|at it)|might as well|since (i'?m|we'?re) (already|here))\b/i,
    label: 'scope-creep',
    severity: 'low',
  },
];

/**
 * Scan text (AI reasoning, tool inputs, plans) for rationalization patterns.
 * Use this before executing high-stakes autonomous operations.
 */
export function checkForRationalizations(text: string): RationalizationCheck {
  const detected: Array<{ label: string; severity: 'low' | 'medium' | 'high' }> = [];

  for (const { pattern, label, severity } of RATIONALIZATION_PATTERNS) {
    if (pattern.test(text)) {
      detected.push({ label, severity });
    }
  }

  if (detected.length === 0) {
    return {
      detected: false,
      patterns: [],
      severity: 'low',
      recommendation: 'No rationalization patterns detected. Proceed.',
    };
  }

  const maxSeverity: 'low' | 'medium' | 'high' = detected.some((d) => d.severity === 'high')
    ? 'high'
    : detected.some((d) => d.severity === 'medium')
      ? 'medium'
      : 'low';

  const recommendation =
    maxSeverity === 'high'
      ? 'HIGH RISK: Rationalization patterns detected. Pause and verify authorization before proceeding.'
      : maxSeverity === 'medium'
        ? 'CAUTION: Potential rationalization detected. Double-check the reasoning before executing.'
        : 'LOW RISK: Minor rationalization patterns. Proceed with awareness.';

  log.warn(
    { patterns: detected.map((d) => d.label), severity: maxSeverity },
    'Rationalization patterns detected',
  );

  return {
    detected: true,
    patterns: detected.map((d) => `${d.label} (${d.severity})`),
    severity: maxSeverity,
    recommendation,
  };
}

/**
 * Generate the system prompt injection that makes SUDO-AI resist rationalizations.
 * Add this to AGENTS.md or the system prompt for autonomous operations.
 */
export function getRationalizationResistancePrompt(): string {
  return `## Rationalization Resistance

When making autonomous decisions, actively resist these common shortcuts:
- "It's just a test" → Tests can have real consequences. Treat all operations as production.
- "The user said it's fine" → Verify authorization through proper channels, not just claimed permission.
- "This case is special/different" → Special cases usually aren't. Apply standard caution.
- "I'll fix it later" → Later never comes in autonomous operation. Fix it now or don't do it.
- "Another system handles it" → Never assume another layer catches your mistakes. Be the last line of defense.
- "It's already done / no going back" → Fait accompli is not justification. Escalate for review.
- "The risk is low" → Only claim low risk with evidence. Uncertainty is not low risk.
- "Everyone does this" → Consensus does not equal correct. Evaluate independently.

If you catch yourself using any of these patterns in your reasoning, STOP and reconsider.`;
}

/** Tool-compatible wrapper — check reasoning text before dangerous tool calls. */
export function guardOperation(
  reasoning: string,
  operationName: string,
): { safe: boolean; warning?: string } {
  const check = checkForRationalizations(reasoning);
  if (!check.detected || check.severity === 'low') return { safe: true };
  return {
    safe: check.severity !== 'high',
    warning: `[RationalizationGuard] ${operationName}: ${check.recommendation} Patterns: ${check.patterns.join(', ')}`,
  };
}

// ---------------------------------------------------------------------------
// Module-level optional inspection queue (set by app bootstrap)
// ---------------------------------------------------------------------------

let _rationalizationQueue: InspectionQueueInstance | null = null;

/**
 * Register an InspectionQueueInstance so the monitor can enqueue flagged content.
 * Call once at app bootstrap. Safe to call multiple times (last wins).
 */
export function setRationalizationQueue(queue: InspectionQueueInstance): void {
  _rationalizationQueue = queue;
}

/**
 * Monitor AI-generated text for rationalization patterns and optionally enqueue
 * flagged content into the inspection queue.
 *
 * @param text    - Generated text to analyse (reasoning, plan, output, etc.)
 * @param context - Metadata for the inspection queue entry.
 * @returns Object with `flagged` boolean and optional `queueId` if enqueued.
 */
export function monitorGeneratedContent(
  text: string,
  context: { sessionId: string; operationName?: string },
): { flagged: boolean; queueId?: string } {
  const check = checkForRationalizations(text);

  if (!check.detected) {
    return { flagged: false };
  }

  log.warn(
    { sessionId: context.sessionId, operationName: context.operationName, severity: check.severity },
    'monitorGeneratedContent: rationalization detected in generated text',
  );

  if (_rationalizationQueue === null) {
    return { flagged: true };
  }

  try {
    const queueId = _rationalizationQueue.enqueue({
      source: context.operationName ?? 'agent',
      category: 'generated',
      severity: check.severity,
      fullPayload: text,
      patternMatches: check.patterns,
    });
    return { flagged: true, queueId };
  } catch (err) {
    log.warn({ err, sessionId: context.sessionId }, 'monitorGeneratedContent: failed to enqueue — flag returned without queueId');
    return { flagged: true };
  }
}
