/**
 * @file compiler.ts
 * @description Compiles a detected repeated tool-call pattern into a reusable
 * Procedure object.
 *
 * The compiler is purely functional — it takes data in and returns a new
 * Procedure. It does NOT write to the database; that is the responsibility of
 * store.ts.
 */

import { genId } from '../../shared/utils.js';
import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { Procedure, ProcedureStep } from './types.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('procedural-memory:compiler');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compile a repeated tool-call pattern into a Procedure.
 *
 * @param pattern    - Ordered list of tool names that form the pattern,
 *                     e.g. ["coder.read-file", "coder.write-file"].
 * @param sessionIds - Session IDs in which this pattern was observed.
 * @param name       - Optional custom name; auto-generated if omitted.
 * @returns A fully-formed Procedure ready to be persisted by store.ts.
 *
 * @throws ConsciousnessError for invalid inputs.
 */
export function compileProcedure(
  pattern: string[],
  sessionIds: string[],
  name?: string,
): Procedure {
  // --- Input validation ---
  if (!Array.isArray(pattern) || pattern.length === 0) {
    throw new ConsciousnessError(
      'compileProcedure: pattern must be a non-empty array of tool names',
      'consciousness_procedural_invalid_pattern',
      { pattern },
    );
  }

  for (let i = 0; i < pattern.length; i++) {
    const tool = pattern[i];
    if (!tool || typeof tool !== 'string') {
      throw new ConsciousnessError(
        `compileProcedure: pattern[${i}] must be a non-empty string`,
        'consciousness_procedural_invalid_pattern_entry',
        { index: i, value: tool },
      );
    }
  }

  if (!Array.isArray(sessionIds)) {
    throw new ConsciousnessError(
      'compileProcedure: sessionIds must be an array',
      'consciousness_procedural_invalid_session_ids',
      { sessionIds },
    );
  }

  // --- Build steps ---
  const steps: ProcedureStep[] = pattern.map((toolName, index) => ({
    toolName,
    argumentTemplate: {},
    expectedOutcome: '',
    order: index,
  }));

  // --- Derive procedure name ---
  const firstTool = sanitiseSegment(pattern[0] as string);
  const lastTool = sanitiseSegment(pattern[pattern.length - 1] as string);
  const resolvedName = name && name.trim().length > 0
    ? name.trim()
    : `auto_${firstTool}_${lastTool}`;

  // --- Build trigger pattern ---
  // Stored as a human-readable and LIKE-matchable string.
  const triggerPattern = pattern.join(' then ');

  const now = new Date().toISOString();
  const id = genId();

  const procedure: Procedure = {
    id,
    name: resolvedName,
    description: `Auto-compiled from ${pattern.length}-step sequence observed in ${sessionIds.length} session(s).`,
    triggerPattern,
    steps,
    successCount: 0,
    failureCount: 0,
    avgDurationMs: 0,
    lastUsed: null,
    compiledFrom: [...sessionIds],
    enabled: true,
    createdAt: now,
  };

  log.info(
    {
      id,
      name: resolvedName,
      stepCount: steps.length,
      triggerPattern,
      compiledFrom: sessionIds,
    },
    'compileProcedure: procedure compiled successfully',
  );

  return procedure;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sanitise a tool name segment for use in an auto-generated procedure name.
 * Replaces any character that is not alphanumeric or underscore with "_",
 * then trims leading/trailing underscores.
 */
function sanitiseSegment(segment: string): string {
  return segment
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32); // cap length to keep names readable
}
