/**
 * @file admin/tools-helpers.ts
 * @description Filesystem and config helpers for tools.handler.ts.
 *
 * Tool discovery uses a source-parse strategy that reads every .ts file in
 * each category directory tree (including index.ts and sub-directories) and
 * extracts ToolDefinition name literals via regex.  This correctly handles
 * all three patterns present in the codebase:
 *
 *  1. File-per-tool categories (browser, coder, system, …):
 *     Each non-index .ts file contains exactly one ToolDefinition with a
 *     `name:` property.  The source-parse finds these correctly, and unlike
 *     the old filename-slug approach it returns the ACTUAL tool name (e.g.
 *     browser.launch from browser-manager.ts, not browser.browser-manager).
 *
 *  2. Bundled index.ts categories (business, content, data, …):
 *     All ToolDefinitions are declared inline inside index.ts.  The old code
 *     skipped index.ts entirely, causing every tool here to be invisible.
 *     Source-parse finds them.
 *
 *  3. Index.ts that imports from sub-directories or external paths:
 *     - dev/tools/*.ts, research/tools/*.ts  — recursed one level deep.
 *     - superpowers category              — also scans src/core/superpowers/
 *       because that is where the ToolDefinition objects live.
 *
 * Cross-category bundles (e.g. comms.email-responder defined in content/index.ts,
 * learn.* tools defined in research/tools/learn-tools.ts) are attributed to the
 * correct logical category via the tool-name prefix, not the file directory.
 * Global deduplication ensures each tool appears exactly once regardless of how
 * many files declare or re-export its name literal.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readConfig, writeConfig } from './config-io.js';
import { createLogger } from '../../shared/logger.js';
import { PROJECT_ROOT } from '../../shared/paths.js';

const log = createLogger('api:admin:tools-helpers');

export const TOOLS_DIR = path.join(PROJECT_ROOT, 'src', 'core', 'tools', 'builtin');

/**
 * Absolute path to the external superpowers module directory.
 * builtin/superpowers/index.ts re-exports ToolDefinition objects that live here,
 * so this directory must be included in the superpowers category scan.
 */
const SUPERPOWERS_EXTERNAL_DIR = path.join(PROJECT_ROOT, 'src', 'core', 'superpowers');

/**
 * Source root used to build display-friendly relative file paths.
 * All reported `file` fields will start with "src/".
 */
const SRC_ROOT = path.join(PROJECT_ROOT, 'src');

/**
 * Regex that matches a ToolDefinition `name` property literal in TypeScript source.
 * Captures the tool name string value (group 1).
 *
 * Accepted forms (any amount of leading whitespace, optional trailing comma):
 *   name: 'some-category.tool-slug',
 *   name: "some-category.tool-slug"
 *
 * The pattern requires:
 *   - At least one leading whitespace character (rules out top-level declarations
 *     and comment lines that start in column 0).
 *   - A category segment:  one or more lowercase alphanumeric or hyphen chars.
 *   - A literal dot separator.
 *   - A slug segment:      one or more lowercase alphanumeric or hyphen chars.
 *
 * Template literals containing `${…}` never match because `$` and `{` are not
 * in the character class, so dynamically-built names (e.g. `${skillName}` in
 * meta/index.ts) are safely ignored.
 */
const TOOL_NAME_LITERAL_RE = /^\s+name:\s+['"]([a-z][a-z0-9-]*\.[a-z][a-z0-9-]*)['"]/;

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/** Return all category directory names present under the builtin tools directory. */
export function listToolCategories(): string[] {
  try {
    return fs.readdirSync(TOOLS_DIR).filter((f) => {
      try {
        return fs.statSync(path.join(TOOLS_DIR, f)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch (err) {
    log.warn({ err }, 'listToolCategories: cannot read tools dir');
    return [];
  }
}

export interface ToolEntry {
  name: string;
  category: string;
  file: string;
}

// ---------------------------------------------------------------------------
// Internal scan helpers
// ---------------------------------------------------------------------------

/**
 * Collect all .ts file paths reachable from `dir`, descending one additional
 * level into any immediate sub-directories (e.g. dev/tools/, research/tools/).
 * index.ts files are included — many categories define all tools inline there.
 *
 * @param dir - Absolute path of the directory to scan.
 * @returns Absolute .ts file paths found (no duplicates).
 */
function collectTsFiles(dir: string): string[] {
  const collected: string[] = [];

  let topLevel: string[];
  try {
    topLevel = fs.readdirSync(dir);
  } catch (err) {
    log.warn({ dir, err }, 'collectTsFiles: cannot read directory — skipping');
    return collected;
  }

  for (const entry of topLevel) {
    const fullPath = path.join(dir, entry);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isFile() && entry.endsWith('.ts')) {
      collected.push(fullPath);
      continue;
    }

    if (stat.isDirectory()) {
      // Recurse one level for tools/ sub-directories used by dev and research.
      let subEntries: string[];
      try {
        subEntries = fs.readdirSync(fullPath);
      } catch {
        continue;
      }
      for (const sub of subEntries) {
        if (!sub.endsWith('.ts')) continue;
        const subPath = path.join(fullPath, sub);
        try {
          if (fs.statSync(subPath).isFile()) collected.push(subPath);
        } catch {
          // unreadable sub-entry — skip silently
        }
      }
    }
  }

  return collected;
}

/**
 * Read `filePath` and return every tool name literal found.
 * Uses line-by-line regex — no AST, no dynamic imports, no side effects.
 *
 * @param filePath - Absolute path to the .ts file.
 * @returns Tool name strings extracted (may include duplicates if file is unusual).
 */
function parseToolNamesFromFile(filePath: string): string[] {
  let source: string;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    log.warn({ filePath, err }, 'parseToolNamesFromFile: cannot read file — skipping');
    return [];
  }

  const names: string[] = [];
  for (const line of source.split('\n')) {
    const match = TOOL_NAME_LITERAL_RE.exec(line);
    if (match?.[1]) {
      names.push(match[1]);
    }
  }

  return names;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover all built-in tool definitions by parsing TypeScript source files.
 *
 * For every category directory under `TOOLS_DIR` the function:
 *   1. Collects all .ts files in the category tree (top-level + one sub-level).
 *   2. Appends `SUPERPOWERS_EXTERNAL_DIR` for the `superpowers` category.
 *   3. Extracts `name: 'category.slug'` literals from each file.
 *   4. Deduplicates globally on tool name (first occurrence wins).
 *   5. Attributes each tool to its logical category via the name prefix.
 *
 * The `file` field in each returned entry is a source-relative path starting
 * with "src/" for display in the admin UI.
 *
 * @returns Flat array of {@link ToolEntry} objects — one per unique tool found.
 */
export function listToolsFromFilesystem(): ToolEntry[] {
  const categories = listToolCategories();

  // Global deduplication map: tool name → ToolEntry.
  const byName = new Map<string, ToolEntry>();

  for (const category of categories) {
    const categoryDir = path.join(TOOLS_DIR, category);

    // Build the list of directories to scan for this category.
    const scanDirs: string[] = [categoryDir];
    if (category === 'superpowers') {
      scanDirs.push(SUPERPOWERS_EXTERNAL_DIR);
    }

    for (const scanDir of scanDirs) {
      const tsFiles = collectTsFiles(scanDir);

      for (const filePath of tsFiles) {
        const names = parseToolNamesFromFile(filePath);

        for (const toolName of names) {
          if (byName.has(toolName)) continue; // already catalogued from another file

          // The logical category comes from the tool name prefix (e.g. "comms" from
          // "comms.email-responder" even when found in content/index.ts).
          const logicalCategory = toolName.split('.')[0] ?? category;

          // Build a display-friendly relative path ("src/core/tools/builtin/…")
          const relFile = path.relative(SRC_ROOT, filePath);

          byName.set(toolName, {
            name: toolName,
            category: logicalCategory,
            file: path.join('src', relFile),
          });
        }
      }
    }
  }

  const tools = Array.from(byName.values());

  log.info(
    { total: tools.length, categories: categories.length },
    'listToolsFromFilesystem: discovery complete',
  );

  return tools;
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/** Return the tools.disabled array from config (defaults to empty). */
export function getDisabledTools(): string[] {
  try {
    const config = readConfig();
    const tools = config['tools'] as Record<string, unknown> | undefined;
    if (!tools) return [];
    const disabled = tools['disabled'];
    if (!Array.isArray(disabled)) return [];
    return disabled.filter((d): d is string => typeof d === 'string');
  } catch (err) {
    log.warn({ err }, 'getDisabledTools: could not read config');
    return [];
  }
}

/** Persist an updated disabled list to config. */
export function setDisabledTools(disabled: string[]): void {
  const config = readConfig();
  const tools = (config['tools'] as Record<string, unknown>) ?? {};
  tools['disabled'] = disabled;
  config['tools'] = tools;
  writeConfig(config);
}

/** Allowed keys for browser config updates. */
export const ALLOWED_BROWSER_KEYS = [
  'headless', 'executablePath', 'timeout', 'viewportWidth',
  'viewportHeight', 'userDataDir', 'args',
] as const;
