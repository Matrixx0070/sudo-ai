/**
 * @file patch-parser.ts
 * @description Extract the `<<<PATCH>>>...<<<END>>>` block from LLM output
 * and validate the JSON shape against {@link PatchOp}.
 *
 * Contract: the LLM's free-form reasoning may precede the block; the parser
 * scans for the FIRST `<<<PATCH>>>` marker and consumes through the next
 * `<<<END>>>`. Anything outside is ignored — narrative reasoning is fine.
 *
 * Validation is strict: a malformed op fails the whole parse rather than
 * silently dropping individual entries. Partial-success patches are not
 * a thing — either the LLM emitted a valid plan or it didn't.
 */

import type { PatchOp } from './patch-types.js';

/** Marker pair that delimits the patch JSON in the LLM response. */
const OPEN_MARKER = '<<<PATCH>>>';
const CLOSE_MARKER = '<<<END>>>';

export interface ParseSuccess {
  ok: true;
  ops: PatchOp[];
}
export interface ParseFailure {
  ok: false;
  /** Human-readable diagnostic — surfaced to the caller / user. */
  error: string;
}
export type ParseResult = ParseSuccess | ParseFailure;

/**
 * Locate and validate the patch block in raw LLM output. Returns a discriminated
 * result so callers can react to specific failure modes without throwing.
 */
export function parsePatchBlock(raw: string): ParseResult {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, error: 'empty or non-string LLM output' };
  }

  const openIdx = raw.indexOf(OPEN_MARKER);
  if (openIdx === -1) {
    return { ok: false, error: `missing ${OPEN_MARKER} marker` };
  }
  const closeIdx = raw.indexOf(CLOSE_MARKER, openIdx + OPEN_MARKER.length);
  if (closeIdx === -1) {
    return { ok: false, error: `missing ${CLOSE_MARKER} marker after ${OPEN_MARKER}` };
  }

  const inner = raw.slice(openIdx + OPEN_MARKER.length, closeIdx).trim();
  if (inner.length === 0) {
    return { ok: false, error: 'patch block is empty' };
  }

  // The LLM may have wrapped the JSON in a markdown fence — strip it.
  const unfenced = inner.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `patch block is not valid JSON: ${msg}` };
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, error: 'patch block must be a JSON array' };
  }
  if (parsed.length === 0) {
    return { ok: false, error: 'patch array is empty' };
  }

  const ops: PatchOp[] = [];
  for (let i = 0; i < parsed.length; i += 1) {
    const validated = validateOp(parsed[i], i);
    if (!validated.ok) return validated;
    ops.push(validated.op);
  }
  return { ok: true, ops };
}

type ValidatedOp = { ok: true; op: PatchOp } | ParseFailure;

function validateOp(raw: unknown, index: number): ValidatedOp {
  const where = `op[${index}]`;
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, error: `${where}: must be an object` };
  }
  const obj = raw as Record<string, unknown>;
  const op = obj['op'];
  const file = obj['file'];

  if (typeof op !== 'string') return { ok: false, error: `${where}: missing string "op"` };
  if (typeof file !== 'string' || file.length === 0) {
    return { ok: false, error: `${where}: missing string "file"` };
  }
  // Block path traversal / absolute paths early; the applier double-checks
  // after path.resolve(), but failing here gives a clearer LLM-facing error.
  if (file.startsWith('/') || file.includes('..')) {
    return { ok: false, error: `${where}: "file" must be a project-relative path without "..": ${file}` };
  }

  switch (op) {
    case 'str_replace': {
      const oldStr = obj['old'];
      const newStr = obj['new'];
      if (typeof oldStr !== 'string') return { ok: false, error: `${where}: str_replace requires string "old"` };
      if (typeof newStr !== 'string') return { ok: false, error: `${where}: str_replace requires string "new"` };
      if (oldStr.length === 0) return { ok: false, error: `${where}: str_replace "old" cannot be empty` };
      if (oldStr === newStr) return { ok: false, error: `${where}: str_replace is a no-op (old === new)` };
      return { ok: true, op: { op: 'str_replace', file, old: oldStr, new: newStr } };
    }
    case 'insert_after':
    case 'insert_before': {
      const anchor = obj['anchor'];
      const content = obj['content'];
      if (typeof anchor !== 'string' || anchor.length === 0) {
        return { ok: false, error: `${where}: ${op} requires non-empty string "anchor"` };
      }
      if (typeof content !== 'string') {
        return { ok: false, error: `${where}: ${op} requires string "content"` };
      }
      return { ok: true, op: { op, file, anchor, content } };
    }
    case 'create_file': {
      const content = obj['content'];
      if (typeof content !== 'string') {
        return { ok: false, error: `${where}: create_file requires string "content"` };
      }
      return { ok: true, op: { op: 'create_file', file, content } };
    }
    case 'delete_file':
      return { ok: true, op: { op: 'delete_file', file } };
    default:
      return { ok: false, error: `${where}: unknown op "${op}"` };
  }
}
