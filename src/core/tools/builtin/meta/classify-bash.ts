/**
 * @file classify-bash.ts
 * @description `meta.classify-bash` (gap #22) — static safety classifier
 * the agent can call BEFORE invoking `system.exec` to know whether a
 * command needs approval, will be force-denied, or is safe.
 *
 * Pure wrapper over the existing `BashASTParser` (security/bash-ast.ts)
 * with a small projection of the rich validation result onto a tight
 * summary that fits in a tool response. The DANGEROUS_PREFIXES from
 * gap #16's exec-policy are also consulted so the classifier's verdict
 * lines up with what the runtime gate will do: an `'auto-denied'`
 * verdict means the command WILL be force-denied by ApprovalManager
 * regardless of any user rule.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { bashASTParser } from '../../../security/bash-ast.js';
import { isDangerousCommand } from '../../../agent/exec-policy.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('meta.classify-bash');

export interface BashClassification {
  /**
   * - `auto-denied`: a hardcoded DANGEROUS_PREFIX matched; ApprovalManager
   *   will force-deny regardless of any allow rule.
   * - `dangerous`: BashASTParser flagged high/critical risk; almost always
   *   needs explicit approval.
   * - `needs-approval`: medium risk OR explicitly destructive flag; the
   *   ApprovalManager will prompt the user unless a persistent rule
   *   (gap #16) allows it.
   * - `safe`: read-only or low-risk, no approval expected.
   */
  verdict: 'auto-denied' | 'dangerous' | 'needs-approval' | 'safe';
  /** BashASTParser risk level (`safe` | `low` | `medium` | `high` | `critical`). */
  riskLevel: string;
  /** Category tags (file_destruction, data_exfiltration, etc.). */
  categories: string[];
  /** Human-readable explanation. */
  explanation: string;
  /** True when the command only reads filesystem / no side-effects. */
  isReadOnly: boolean;
  /** True when the command writes / deletes files. */
  modifiesFilesystem: boolean;
  /** True when the command opens network sockets / reaches out. */
  accessesNetwork: boolean;
  /** Confidence 0..1 from the parser. */
  confidence: number;
}

/**
 * Pure classification function — exported so other code (e.g. the loop
 * or a future pre-flight check) can call it without going through the
 * tool dispatch path.
 */
export function classifyBashCommand(command: string): BashClassification {
  const trimmed = (command ?? '').trim();
  if (!trimmed) {
    return {
      verdict: 'safe',
      riskLevel: 'safe',
      categories: ['none'],
      explanation: 'Empty command',
      isReadOnly: true,
      modifiesFilesystem: false,
      accessesNetwork: false,
      confidence: 1.0,
    };
  }

  // Hard ban list takes precedence over AST risk levels — these are
  // unconditionally denied by ApprovalManager. Categorize the entry so
  // modifiesFilesystem / accessesNetwork reflect the actual hazard
  // class (verifier HIGH #1 — previously modifiesFilesystem was
  // hardcoded true for curl|sh and fork bombs, misleading the agent).
  if (isDangerousCommand('system.exec', { command: trimmed })) {
    const isNetwork = /^(curl|wget)\b/.test(trimmed);
    const isForkBomb = /:\(\)\s*\{/.test(trimmed);
    return {
      verdict: 'auto-denied',
      riskLevel: 'critical',
      categories: ['dangerous_prefix'],
      explanation: 'Matches a hardcoded DANGEROUS_PREFIXES entry — will be force-denied at the policy layer regardless of any user allow rule.',
      isReadOnly: false,
      // Network commands and fork bombs do not modify the filesystem.
      modifiesFilesystem: !(isNetwork || isForkBomb),
      accessesNetwork: isNetwork,
      confidence: 1.0,
    };
  }

  const result = bashASTParser.parse(trimmed);
  const risk = result.risk;
  const verdict: BashClassification['verdict'] =
    risk.level === 'critical' || risk.level === 'high'
      ? 'dangerous'
      : risk.level === 'medium' || risk.requiresApproval
        ? 'needs-approval'
        : 'safe';

  return {
    verdict,
    riskLevel: risk.level,
    categories: risk.categories,
    explanation: risk.explanation,
    isReadOnly: result.isReadOnly,
    modifiesFilesystem: result.modifiesFilesystem,
    accessesNetwork: result.accessesNetwork,
    confidence: risk.confidence,
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const classifyBashTool: ToolDefinition = {
  name: 'meta.classify-bash',
  description:
    'Statically classify a bash command without executing it. Returns a verdict ' +
    '("auto-denied" | "dangerous" | "needs-approval" | "safe"), risk level, ' +
    'categories, and read-only / writes-fs / network-access flags. Call this ' +
    'before `system.exec` to know whether you should even attempt the command. ' +
    'No subprocess is spawned — fast, free, deterministic.',
  category: 'meta' as const,
  safety: 'readonly',
  requiresConfirmation: false,
  timeout: 1_000,
  parameters: {
    command: {
      type: 'string',
      required: true,
      description: 'The bash command to classify (do not include `bash -c` wrapping).',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const command = typeof params['command'] === 'string' ? (params['command'] as string) : '';
    if (!command.trim()) {
      return { success: false, output: 'meta.classify-bash: command is required.' };
    }
    logger.info({ sessionId: ctx.sessionId, commandPreview: command.slice(0, 80) }, 'classifying bash');
    const c = classifyBashCommand(command);
    const summary =
      `verdict: ${c.verdict}\n` +
      `risk: ${c.riskLevel} (confidence ${c.confidence.toFixed(2)})\n` +
      `categories: ${c.categories.join(', ')}\n` +
      `flags: readOnly=${c.isReadOnly} modifiesFs=${c.modifiesFilesystem} network=${c.accessesNetwork}\n` +
      `explanation: ${c.explanation}`;
    return {
      success: true,
      output: summary,
      data: c,
    };
  },
};
