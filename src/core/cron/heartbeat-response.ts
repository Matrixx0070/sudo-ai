/**
 * heartbeat-response.ts — HEARTBEAT_OK suppression logic.
 *
 * Processes agent responses to heartbeat turns and decides whether to
 * suppress delivery or strip the HEARTBEAT_OK acknowledgement token.
 *
 * Rules:
 * 1. Response is exactly "HEARTBEAT_OK" (case-insensitive, trimmed)
 *    → suppress: true, content: undefined
 * 2. Response starts with or ends with "HEARTBEAT_OK" and remaining
 *    content (after stripping token + surrounding whitespace) is <= threshold
 *    → suppress: true, content: undefined
 * 3. Response starts with or ends with "HEARTBEAT_OK" and remaining
 *    content is > threshold
 *    → suppress: false, content: cleaned string
 * 4. Response contains no HEARTBEAT_OK token
 *    → suppress: false, content: original response
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('cron:heartbeat-response');

/** Minimum character count for partial-content delivery after HEARTBEAT_OK strip. */
export const HEARTBEAT_OK_MIN_CONTENT_CHARS = 300;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of processHeartbeatResponse. */
export interface HeartbeatResponseResult {
  /** Whether the response should be completely suppressed (not sent anywhere). */
  suppress: boolean;
  /**
   * Cleaned content to deliver. Undefined when suppress is true or when the
   * stripped content is too short to be meaningful.
   */
  content?: string;
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Determine whether an agent heartbeat response should be suppressed and
 * return the cleaned content if delivery is warranted.
 *
 * @param response - Raw agent response string.
 * @param minContentChars - Override threshold (default: HEARTBEAT_OK_MIN_CONTENT_CHARS).
 */
export function processHeartbeatResponse(
  response: string,
  minContentChars: number = HEARTBEAT_OK_MIN_CONTENT_CHARS,
): HeartbeatResponseResult {
  const trimmed = response.trim();
  const upper = trimmed.toUpperCase();
  const TOKEN = 'HEARTBEAT_OK';

  // Rule 1: exact match → full suppression
  if (upper === TOKEN) {
    return { suppress: true };
  }

  let cleaned: string | undefined;

  if (upper.startsWith(TOKEN)) {
    // Strip leading token + any following separators / whitespace
    cleaned = trimmed.slice(TOKEN.length).replace(/^[\s\-—:]+/, '').trim();
  } else if (upper.endsWith(TOKEN)) {
    // Strip trailing token + any preceding separators / whitespace
    cleaned = trimmed.slice(0, trimmed.length - TOKEN.length).replace(/[\s\-—:]+$/, '').trim();
  } else {
    // No token found — deliver as-is
    return { suppress: false, content: response };
  }

  // Rules 2 & 3: only deliver if there is substantial content remaining
  if (!cleaned || cleaned.length <= minContentChars) {
    log.debug(
      { cleanedLen: cleaned?.length ?? 0, threshold: minContentChars },
      'Heartbeat response suppressed (HEARTBEAT_OK with short content)',
    );
    return { suppress: true };
  }

  log.debug(
    { cleanedLen: cleaned.length },
    'Heartbeat HEARTBEAT_OK token stripped — delivering remaining content',
  );
  return { suppress: false, content: cleaned };
}
