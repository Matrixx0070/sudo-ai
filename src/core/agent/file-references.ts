/**
 * File reference formatting utilities.
 *
 * Converts raw file path strings in agent response text into clickable
 * markdown links (compatible with terminal emulators and VS Code).
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:file-references');

// ---------------------------------------------------------------------------
// formatFileReferences
// ---------------------------------------------------------------------------

/**
 * Convert file paths in response text to clickable markdown links with optional
 * line-number suffixes.
 *
 * Pattern matched: /path/to/file.ts or /path/to/file.ts:42
 * Result:          [file.ts](/path/to/file.ts) or [file.ts](/path/to/file.ts):42
 *
 * Paths already wrapped in markdown link syntax (preceded by '(' or '[') are
 * intentionally left untouched to avoid double-linking.
 *
 * @param text - Raw agent response text.
 * @returns Text with absolute file paths converted to markdown links.
 */
export function formatFileReferences(text: string): string {
  if (!text || typeof text !== 'string') {
    log.warn('formatFileReferences: received empty or non-string input');
    return text ?? '';
  }

  // Match absolute paths like /path/to/project/src/core/brain.ts or /root/foo.ts:42
  // Negative lookbehind prevents matching paths already inside markdown link syntax.
  const result = text.replace(
    /(?<![(\[])(\/([\w.-]+\/)+[\w.-]+\.[a-z]{1,4})(?::(\d+))?/g,
    (match, filepath, _dir, line) => {
      const basename = filepath.split('/').pop() ?? filepath;
      const lineRef = line ? `:${line}` : '';
      return `[${basename}](${filepath})${lineRef}`;
    },
  );

  log.debug(
    { originalLength: text.length, resultLength: result.length },
    'File references formatted',
  );

  return result;
}

// ---------------------------------------------------------------------------
// fileRef
// ---------------------------------------------------------------------------

/**
 * Build a single markdown file reference string.
 *
 * @param filepath - Absolute path to the file, e.g. '/path/to/project/src/brain.ts'.
 * @param line     - Optional line number to append.
 * @returns Markdown link string, e.g. '[brain.ts](/path/to/project/src/brain.ts):10'.
 */
export function fileRef(filepath: string, line?: number): string {
  if (!filepath || typeof filepath !== 'string') {
    log.warn({ filepath }, 'fileRef: invalid filepath');
    return filepath ?? '';
  }

  const basename = filepath.split('/').pop() ?? filepath;
  const lineRef = line !== undefined ? `:${line}` : '';
  return `[${basename}](${filepath})${lineRef}`;
}

log.debug('file-references module loaded');
