/**
 * Special user request detection and hint generation.
 *
 * Detects intents like "undo", "review", "explain" and returns a system hint
 * that guides the agent toward the correct handling strategy.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:special-requests');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SpecialRequest =
  | 'undo'
  | 'review'
  | 'explain'
  | 'time'
  | 'status'
  | 'none';

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Analyse a raw user message and return the best-matching SpecialRequest.
 *
 * @param message - Raw user message text.
 * @returns The detected request type, or 'none' if no pattern matched.
 */
export function detectSpecialRequest(message: string): SpecialRequest {
  if (!message || typeof message !== 'string') {
    log.warn({ message }, 'detectSpecialRequest: invalid input');
    return 'none';
  }

  const m = message.toLowerCase().trim();

  if (/^undo|^revert|^rollback/i.test(m)) return 'undo';
  if (/^review|^code review/i.test(m)) return 'review';
  if (/^explain|^what does|^how does|^why does/i.test(m)) return 'explain';
  if (/^what time|^current time|^date$/i.test(m)) return 'time';
  if (/^status$|^what.s running/i.test(m)) return 'status';

  return 'none';
}

// ---------------------------------------------------------------------------
// Hint generation
// ---------------------------------------------------------------------------

/**
 * Return a system-prompt hint string for the given SpecialRequest.
 * Returns an empty string for 'none'.
 *
 * @param request - Detected special request type.
 */
export function getSpecialRequestHint(request: SpecialRequest): string {
  switch (request) {
    case 'undo':
      return (
        'User wants to undo/revert. Use git to find and revert the last change. ' +
        'NEVER use git reset --hard.'
      );
    case 'review':
      return (
        'User wants a code review. Prioritize bugs, risks, regressions, missing tests. ' +
        'Present findings ordered by severity with file/line references.'
      );
    case 'explain':
      return (
        'User wants an explanation. Include code references. Be concise and educational.'
      );
    case 'time':
      return 'User asked for the time. Run `date` command.';
    case 'status':
      return 'User wants system status. Check running services, disk, memory.';
    default:
      return '';
  }
}

log.debug('special-requests module loaded');
