/**
 * @file response-compressor.ts
 * @description Final answer compression and filler removal for agent responses.
 *
 * Based on Codex GPT-5.4 strict formatting rules:
 *   - Responses must be concise and high-signal.
 *   - Filler openers (e.g. "Got it!", "Sure!", "Great question!") are removed.
 *   - Overly long responses are trimmed with a visible compression marker.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:response-compressor');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum lines before a response is compressed. */
const MAX_RESPONSE_LINES = 60 as const;

/** Maximum characters before a response is compressed. */
const MAX_RESPONSE_CHARS = 4_000 as const;

/** Number of lines to keep from the start and end when compressing. */
const COMPRESSION_HALF = 30 as const; // Math.floor(MAX_RESPONSE_LINES / 2)

// ---------------------------------------------------------------------------
// Filler patterns
// ---------------------------------------------------------------------------

/**
 * Leading filler phrases that add no information.
 * Each pattern anchors to the start of the (trimmed) response.
 */
const FILLER_PATTERNS: RegExp[] = [
  /^(got it|sure|great question|absolutely|of course|certainly|understood|i'd be happy to)[,!.\s\-]*/i,
  /^(let me|i'll|i will|okay|alright|right)[,\s]*/i,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Decide whether a line is a low-value filler opener.
 * Only tests single-line filler at the very start of a response.
 */
function isFiller(line: string): boolean {
  const trimmed = line.trim().toLowerCase();
  // Short single-word filler starters
  if (trimmed === 'sure' || trimmed === 'okay' || trimmed === 'alright') return true;
  if (trimmed.startsWith('got it') || trimmed.startsWith('great question')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compress a final agent response to stay within line and character budgets.
 *
 * Algorithm:
 * 1. Return unchanged if within both limits.
 * 2. Strip obvious filler lines.
 * 3. If still over the line limit: keep the first COMPRESSION_HALF lines,
 *    insert a compression marker, then append the last COMPRESSION_HALF lines.
 *
 * @param response - The raw response string from the LLM.
 * @returns Compressed response string.
 */
export function compressResponse(response: string): string {
  if (typeof response !== 'string') {
    log.warn({ type: typeof response }, 'compressResponse: non-string input — returning empty string');
    return '';
  }

  // Fast path — within both limits.
  if (response.length <= MAX_RESPONSE_CHARS && response.split('\n').length <= MAX_RESPONSE_LINES) {
    return response;
  }

  const lines = response.split('\n');

  // Strip filler lines from the top (first 3 lines only to avoid false positives).
  const filtered: string[] = [];
  let headerDone = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!headerDone && i < 3 && isFiller(line)) {
      continue;
    }
    headerDone = true;
    filtered.push(line);
  }

  // If now within limits, return the filtered version.
  if (
    filtered.join('\n').length <= MAX_RESPONSE_CHARS &&
    filtered.length <= MAX_RESPONSE_LINES
  ) {
    return filtered.join('\n');
  }

  // Still too long — apply line-count compression.
  if (filtered.length > MAX_RESPONSE_LINES) {
    const droppedLines = filtered.length - MAX_RESPONSE_LINES;
    const compressed = [
      ...filtered.slice(0, COMPRESSION_HALF),
      '',
      `... (${droppedLines} lines compressed) ...`,
      '',
      ...filtered.slice(-COMPRESSION_HALF),
    ];

    log.debug(
      { originalLines: lines.length, compressedLines: compressed.length, droppedLines },
      'Response compressed (lines)',
    );

    // Line compression alone may still exceed the character budget if individual
    // lines are long — re-enforce the char cap before returning.
    const joined = compressed.join('\n');
    if (joined.length > MAX_RESPONSE_CHARS) {
      return joined.slice(0, MAX_RESPONSE_CHARS) + '\n... (response truncated for length)';
    }
    return joined;
  }

  // Character limit only — hard truncate with marker.
  const truncated = filtered.join('\n').slice(0, MAX_RESPONSE_CHARS);
  log.debug(
    { originalChars: response.length, limit: MAX_RESPONSE_CHARS },
    'Response compressed (chars)',
  );
  return truncated + '\n... (response truncated for length)';
}

/**
 * Remove common filler openers from the beginning of a response string.
 *
 * Applies each {@link FILLER_PATTERNS} regex in order and trims leading
 * whitespace after each replacement.
 *
 * @param response - Raw response string.
 * @returns Response with the leading filler phrase stripped.
 */
export function removeFiller(response: string): string {
  if (typeof response !== 'string') {
    return '';
  }

  let text = response.trimStart();

  for (const pattern of FILLER_PATTERNS) {
    text = text.replace(pattern, '');
  }

  return text.trimStart();
}
