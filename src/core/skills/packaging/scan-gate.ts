/**
 * @file scan-gate.ts
 * @description Severity-graded scanner verdict for skill packages (Spec 9).
 * Wraps the flat injection scanner (clean / not-clean) with a severity tier so
 * update flows can distinguish "CRITICAL — abort the update" from advisory
 * warnings shown in the update report. Also folds in the capability policy
 * (declared caps beyond the workspace tier are CRITICAL — a skill package can
 * never escalate itself past the tier the Workshop pins).
 */

import { scanMemoryContent } from '../../memory/injection-scanner.js';
import { extractDeclaredCaps } from '../workshop.js';
import { checkCapabilities } from '../trust-policy.js';

export type ScanSeverity = 'clean' | 'warning' | 'critical';

export interface SkillScanVerdict {
  severity: ScanSeverity;
  /** All matched reasons, prefixed with their severity. */
  reasons: string[];
  criticalReasons: string[];
  warningReasons: string[];
}

/** Scanner pattern names that are advisory rather than install-blocking.
 * Everything not listed here is CRITICAL — fail closed on unknown names. */
const WARNING_PATTERNS = new Set(['external_url', 'prompt_delimiter']);

/** Trust tier all packaged skills are evaluated against (mirrors WORKSHOP_TIER). */
const PACKAGE_TIER = 'workspace' as const;

/**
 * Scan a skill package's SKILL.md content. CRITICAL blocks pack/install/update;
 * warnings are reported but do not block.
 */
export function scanSkillContent(markdown: string, context = 'skill-package'): SkillScanVerdict {
  const critical: string[] = [];
  const warning: string[] = [];

  const scan = scanMemoryContent(markdown, undefined, context);
  if (!scan.clean) {
    for (const reason of scan.reasons) {
      if (WARNING_PATTERNS.has(reason)) warning.push(`injection-scan: ${reason}`);
      else critical.push(`injection-scan: ${reason}`);
    }
  }

  const declared = extractDeclaredCaps(markdown);
  const caps = checkCapabilities(declared, PACKAGE_TIER);
  if (!caps.granted) critical.push(`capabilities beyond ${PACKAGE_TIER} tier: ${caps.missing.join(', ')}`);

  const severity: ScanSeverity = critical.length > 0 ? 'critical' : warning.length > 0 ? 'warning' : 'clean';
  return {
    severity,
    reasons: [...critical.map((r) => `CRITICAL ${r}`), ...warning.map((r) => `WARNING ${r}`)],
    criticalReasons: critical,
    warningReasons: warning,
  };
}

/**
 * Scanner delta between the currently installed content and a candidate
 * update — surfaces what the NEW version introduces that the old one didn't.
 */
export function scanDelta(oldMarkdown: string | undefined, newMarkdown: string): {
  verdict: SkillScanVerdict;
  newReasons: string[];
} {
  const verdict = scanSkillContent(newMarkdown);
  if (oldMarkdown === undefined) return { verdict, newReasons: verdict.reasons };
  const oldReasons = new Set(scanSkillContent(oldMarkdown).reasons);
  return { verdict, newReasons: verdict.reasons.filter((r) => !oldReasons.has(r)) };
}
