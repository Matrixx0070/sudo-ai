/**
 * Unified Diff — parse and apply standard unified diffs to files.
 *
 * Supports the @@ hunk header format produced by git diff and diff -u.
 * Each hunk is applied in order with an accumulating line offset so that
 * multiple hunks in a single diff are applied correctly.
 */

import { createLogger } from '../../../shared/logger.js';
import { readFile, writeFile } from 'fs/promises';

const log = createLogger('tool:unified-diff');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single hunk extracted from a unified diff. */
export interface DiffHunk {
  /** 1-based line number in the original file where this hunk starts. */
  startLine: number;
  /** Number of lines removed from the original file. */
  removeCount: number;
  /** Number of lines added to the patched file. */
  addCount: number;
  /** Original lines that are removed (without the leading "-"). */
  removedLines: string[];
  /** New lines that are inserted (without the leading "+"). */
  addedLines: string[];
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a unified diff string into an ordered list of hunks.
 *
 * Lines that are not part of a recognised hunk (file headers, context lines,
 * "\ No newline at end of file") are silently ignored.
 *
 * @param diff - Raw unified diff text.
 * @returns Ordered list of hunks.
 * @throws {Error} When diff is not a string.
 */
export function parseDiff(diff: string): DiffHunk[] {
  if (typeof diff !== 'string') {
    throw new Error('parseDiff: diff must be a string');
  }

  const hunks: DiffHunk[] = [];
  const lines = diff.split('\n');
  let current: DiffHunk | null = null;

  for (const line of lines) {
    // Hunk header: @@ -<start>,<count> +<start>,<count> @@
    const hunkMatch = line.match(/^@@\s+-(\d+),?(\d*)\s+\+(\d+),?(\d*)\s+@@/);
    if (hunkMatch) {
      if (current) hunks.push(current);
      current = {
        startLine: parseInt(hunkMatch[1], 10),
        removeCount: parseInt(hunkMatch[2] !== '' ? hunkMatch[2] : '1', 10),
        addCount: parseInt(hunkMatch[4] !== '' ? hunkMatch[4] : '1', 10),
        removedLines: [],
        addedLines: [],
      };
      continue;
    }

    if (!current) continue;

    if (line.startsWith('-') && !line.startsWith('---')) {
      current.removedLines.push(line.slice(1));
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      current.addedLines.push(line.slice(1));
    }
    // Context lines (space prefix) and "\ No newline" markers are ignored.
  }

  if (current) hunks.push(current);

  log.debug({ hunkCount: hunks.length }, 'Diff parsed');
  return hunks;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Apply a unified diff to a file on disk.
 *
 * Reads the file, applies each hunk in order with cumulative offset
 * correction, then writes the result back to disk.
 *
 * @param filepath - Absolute or CWD-relative path to the target file.
 * @param diff     - Raw unified diff text.
 * @returns Summary string describing what was applied.
 * @throws {Error} When filepath is empty, or the file cannot be read/written.
 */
export async function applyUnifiedDiff(filepath: string, diff: string): Promise<string> {
  if (!filepath || typeof filepath !== 'string') {
    throw new Error('applyUnifiedDiff: filepath must be a non-empty string');
  }
  if (typeof diff !== 'string') {
    throw new Error('applyUnifiedDiff: diff must be a string');
  }

  let content: string;
  try {
    content = await readFile(filepath, 'utf8');
  } catch (err) {
    log.error({ filepath, err }, 'applyUnifiedDiff: failed to read file');
    throw new Error(`applyUnifiedDiff: cannot read "${filepath}": ${(err as Error).message}`);
  }

  const lines = content.split('\n');
  const hunks = parseDiff(diff);
  let offset = 0;

  for (const hunk of hunks) {
    // Convert 1-based startLine to 0-based array index, adjusted for prior hunks.
    const idx = hunk.startLine - 1 + offset;

    if (idx < 0 || idx > lines.length) {
      log.warn({ idx, hunk }, 'applyUnifiedDiff: hunk start index out of range — skipping');
      continue;
    }

    lines.splice(idx, hunk.removedLines.length, ...hunk.addedLines);
    offset += hunk.addedLines.length - hunk.removedLines.length;
  }

  const result = lines.join('\n');

  try {
    await writeFile(filepath, result, 'utf8');
  } catch (err) {
    log.error({ filepath, err }, 'applyUnifiedDiff: failed to write file');
    throw new Error(`applyUnifiedDiff: cannot write "${filepath}": ${(err as Error).message}`);
  }

  log.info({ filepath, hunks: hunks.length }, 'Diff applied');
  return `Applied ${hunks.length} hunk(s) to ${filepath}`;
}
