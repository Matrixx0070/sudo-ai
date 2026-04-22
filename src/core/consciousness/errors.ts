/**
 * @file errors.ts
 * @description Consciousness-layer error hierarchy for SUDO-AI v4.
 *
 * ConsciousnessError extends SudoError and enforces the `consciousness_*`
 * code prefix so downstream catch blocks can route these errors precisely.
 */

import { SudoError } from '../shared/errors.js';

// ---------------------------------------------------------------------------
// ConsciousnessError
// ---------------------------------------------------------------------------

/**
 * Errors originating from the consciousness layer (codes: consciousness_*).
 *
 * Examples:
 *   new ConsciousnessError('DB not open', 'consciousness_db_not_open')
 *   new ConsciousnessError('Invalid body state', 'consciousness_invalid_body', { value })
 */
export class ConsciousnessError extends SudoError {
  public override readonly name = 'ConsciousnessError';

  constructor(
    message: string,
    code: `consciousness_${string}`,
    details?: Record<string, unknown>,
  ) {
    super(message, code, details);
    // Restore prototype chain — required when extending built-ins in TypeScript.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
