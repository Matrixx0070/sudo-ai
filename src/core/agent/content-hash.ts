/**
 * @file content-hash.ts
 * @description Content-hash helper — A1: deterministic 32-char hex per tool+args
 * combo. Used by the veto gate section to enable content-addressable
 * pre-approvals.
 */

import { createHash } from 'node:crypto';
import { sanitizeArgsForPrompt } from './veto-gate.js';

export function computeContentHash(toolName: string, args: Record<string, unknown>): string {
  const sanitized = sanitizeArgsForPrompt(args);  // returns JSON.stringify(sanitized, null, 2)
  const payload   = `${toolName}:${sanitized}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 32);
}
