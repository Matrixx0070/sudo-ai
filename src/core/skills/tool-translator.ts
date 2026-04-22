/**
 * @file tool-translator.ts
 * @description ToolTranslator — maps agentskills.io canonical tool names to
 * SUDO-AI internal tool names.
 *
 * The translation table covers the 7 mandatory mappings from the Wave 10 spec:
 *   Bash        → system.shell     (shell_exec)
 *   Read        → coder.read-file  (file_read)
 *   Write       → coder.write-file (file_write)
 *   Edit        → coder.edit-file  (file_edit)
 *   Grep        → coder.grep       (grep_search)
 *   Glob        → coder.glob       (file_glob)
 *   WebFetch    → system.web-fetch (http_get)
 *
 * Additional mappings may be added without breaking existing consumers.
 */

import type { ToolTranslatorEntry, ToolTranslatorTable } from '../shared/wave10-types.js';

// ---------------------------------------------------------------------------
// Static translation table
// ---------------------------------------------------------------------------

const TRANSLATION_TABLE: ToolTranslatorTable = [
  {
    canonical: 'Bash',
    sudoName: 'system.shell',
    paramMap: { command: 'cmd', restart: 'restart' },
  },
  {
    canonical: 'Read',
    sudoName: 'coder.read-file',
    paramMap: { file_path: 'path', offset: 'offset', limit: 'limit' },
  },
  {
    canonical: 'Write',
    sudoName: 'coder.write-file',
    paramMap: { file_path: 'path', content: 'content' },
  },
  {
    canonical: 'Edit',
    sudoName: 'coder.edit-file',
    paramMap: { file_path: 'path', old_string: 'old', new_string: 'new', replace_all: 'replace_all' },
  },
  {
    canonical: 'Grep',
    sudoName: 'coder.grep',
    paramMap: { pattern: 'pattern', path: 'path', include: 'include', exclude: 'exclude' },
  },
  {
    canonical: 'Glob',
    sudoName: 'coder.glob',
    paramMap: { pattern: 'pattern', path: 'path' },
  },
  {
    canonical: 'WebFetch',
    sudoName: 'system.web-fetch',
    paramMap: { url: 'url', prompt: 'prompt' },
  },
] as const satisfies ToolTranslatorTable;

// Internal lookup index for O(1) translate()
const INDEX = new Map<string, ToolTranslatorEntry>(
  TRANSLATION_TABLE.map((entry) => [entry.canonical, entry]),
);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the full translation table (all 7 entries).
 */
export function translateAll(): ToolTranslatorTable {
  return [...TRANSLATION_TABLE];
}

/**
 * Translate a single canonical agentskills.io tool name to its SUDO-AI
 * equivalent entry.
 *
 * @param canonical - agentskills.io canonical tool name (case-sensitive).
 * @returns Matching ToolTranslatorEntry or null if unknown.
 */
export function translate(canonical: string): ToolTranslatorEntry | null {
  return INDEX.get(canonical) ?? null;
}

/**
 * Translate an array of canonical tool names, silently dropping unknowns.
 *
 * @param canonicals - Array of canonical tool names.
 * @returns Array of matched ToolTranslatorEntry objects.
 */
export function translateMany(canonicals: string[]): ToolTranslatorEntry[] {
  const results: ToolTranslatorEntry[] = [];
  for (const name of canonicals) {
    const entry = INDEX.get(name);
    if (entry) results.push(entry);
  }
  return results;
}

/**
 * Check whether a canonical name has a known SUDO-AI mapping.
 */
export function isKnownCanonical(canonical: string): boolean {
  return INDEX.has(canonical);
}

// Re-export types for consumer convenience
export type { ToolTranslatorEntry, ToolTranslatorTable };
