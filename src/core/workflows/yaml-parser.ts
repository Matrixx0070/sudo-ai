/**
 * @file workflows/yaml-parser.ts
 * @description Minimal YAML subset parser for .lobster.yaml workflow files.
 *
 * Supports:
 *   - Top-level scalar keys: strings, numbers, booleans
 *   - A single top-level list (`steps:`) whose items are objects with scalar values
 *   - Quoted strings ("..." and '...')
 *   - No anchors, aliases, multi-line strings, or nested objects
 *
 * Throws on malformed input.
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Strip inline comments and trailing whitespace from a raw line value. */
function stripInlineComment(value: string): string {
  // Only strip if there is a space before `#` to avoid breaking URLs
  const idx = value.search(/ #/);
  return (idx !== -1 ? value.slice(0, idx) : value).trim();
}

/** Parse a raw scalar string into a typed JS value. */
function parseScalar(raw: string): string | number | boolean {
  const trimmed = raw.trim();

  // Quoted strings
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  // Boolean
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;

  // Integer
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);

  // Float
  if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);

  // Bare string
  return trimmed;
}

/** Count leading spaces (tabs count as 2 for simplicity, but tabs are unusual in YAML). */
function indent(line: string): number {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    i += line[i] === '\t' ? 2 : 1;
  }
  return i;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a YAML string into a plain object.
 * Designed exclusively for the .lobster.yaml workflow file format.
 *
 * @param source - Raw YAML text.
 * @returns Plain JS object.
 */
export function parseYaml(source: string): Record<string, unknown> {
  const lines = source.split('\n');
  const result: Record<string, unknown> = {};

  /** Current list being accumulated under a list key. */
  let currentList: Record<string, unknown>[] | null = null;
  let currentListKey = '';
  /** Current item in the list. */
  let currentItem: Record<string, unknown> | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as string;
    // Skip blank lines and comment-only lines
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;

    const ind = indent(raw);
    const line = raw.trim();

    // -----------------------------------------------------------------------
    // Top-level key:value  (indent 0, not a list item)
    // -----------------------------------------------------------------------
    if (ind === 0 && !line.startsWith('-')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;

      const key = line.slice(0, colonIdx).trim();
      const rest = stripInlineComment(line.slice(colonIdx + 1)).trim();

      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;

      if (rest === '') {
        // Could be a list header — will be populated by list items below
        currentList = [];
        currentListKey = key;
        currentItem = null;
        result[key] = currentList;
      } else {
        currentList = null;
        currentItem = null;
        result[key] = parseScalar(rest);
      }
      continue;
    }

    // -----------------------------------------------------------------------
    // List item opener:  "  - id: foo"  or  "  -"
    // -----------------------------------------------------------------------
    if (ind >= 2 && line.startsWith('- ')) {
      currentItem = {};
      currentList?.push(currentItem);

      // Rest of the line after "- " may contain a key:value
      const afterDash = line.slice(2).trim();
      if (afterDash !== '') {
        const colonIdx = afterDash.indexOf(':');
        if (colonIdx !== -1) {
          const key = afterDash.slice(0, colonIdx).trim();
          if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
          const val = stripInlineComment(afterDash.slice(colonIdx + 1)).trim();
          if (val !== '' && currentItem) currentItem[key] = parseScalar(val);
        }
      }
      continue;
    }

    // -----------------------------------------------------------------------
    // Sub-key inside a list item: "    command: tar czf ..."
    // -----------------------------------------------------------------------
    if (ind >= 4 && currentItem !== null) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;

      const key = line.slice(0, colonIdx).trim();
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      const val = stripInlineComment(line.slice(colonIdx + 1)).trim();
      if (val !== '') currentItem[key] = parseScalar(val);
      continue;
    }
  }

  // Discard empty currentListKey if no items were added
  if (currentListKey && currentList?.length === 0) {
    delete result[currentListKey];
  }

  return result;
}
