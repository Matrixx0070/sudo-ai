/**
 * Concatenated-JSON splitter + balanced-object scanner for LLM tool-call text.
 * Extracted verbatim from brain.ts (F103 mechanical slimming); zero behavior change.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('brain');

// ---------------------------------------------------------------------------
// Concatenated-JSON splitter — handles LLMs that batch multiple tool call
// argument objects into a single arguments string, e.g. grok-3 via xai.
// ---------------------------------------------------------------------------

/**
 * Split a string that may contain one or more concatenated JSON objects.
 *
 * The scanner tracks brace depth and whether it is inside a JSON string
 * literal (respecting backslash-escape sequences), so values that contain
 * literal `{` or `}` characters inside strings are handled correctly.
 *
 * @param raw - The raw arguments string from the LLM.
 * @returns An array of parsed objects; empty array on total failure.
 */
export function splitConcatenatedJsonObjects(raw: string): Record<string, unknown>[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return [];

  const results: Record<string, unknown>[] = [];
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  let objectStart = -1; // sentinel: -1 = not currently inside a top-level object

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{') {
      if (depth === 0) objectStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth < 0) {
        // Unbalanced closing brace — input is corrupt. A stale objectStart from
        // a prior segment would slice the wrong bytes, so abort rather than
        // emit garbage that could drive tool dispatch with wrong arguments.
        log.warn({ at: i }, 'splitConcatenatedJsonObjects: unbalanced closing brace — aborting parse');
        return [];
      }
      if (depth === 0 && objectStart >= 0) {
        const segment = trimmed.slice(objectStart, i + 1);
        objectStart = -1;
        try {
          const parsed = JSON.parse(segment) as Record<string, unknown>;
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            results.push(parsed);
          }
        } catch {
          // malformed segment — skip it
        }
      }
    }
  }

  if (depth !== 0) {
    // Trailing object truncated mid-stream (depth never returned to 0). Nothing
    // partial was pushed (we only push on depth===0), but surface it so callers
    // can tell "no tool calls" from "tool calls truncated".
    log.warn({ depth }, 'splitConcatenatedJsonObjects: truncated trailing object — ignored');
  }

  return results;
}

/**
 * Scan arbitrary text for ALL balanced top-level JSON objects, returning each
 * `{...}` substring. Unlike splitConcatenatedJsonObjects this does NOT require
 * the text to start with `{` — it locates objects embedded anywhere (e.g. an
 * LLM that wraps a `{"tool_calls":[...]}` payload in prose). String/escape
 * aware, O(n), no regex backtracking.
 */
export function findBalancedJsonObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  let objectStart = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escapeNext) { escapeNext = false; continue; }
    if (ch === '\\' && inString) { escapeNext = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '{') {
      if (depth === 0) objectStart = i;
      depth++;
    } else if (ch === '}') {
      if (depth === 0) continue; // stray closing brace outside any object — ignore
      depth--;
      if (depth === 0 && objectStart >= 0) {
        out.push(text.slice(objectStart, i + 1));
        objectStart = -1;
      }
    }
  }

  return out;
}
