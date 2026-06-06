/**
 * @file security/tool-translator.ts
 * @description ToolTranslator — maps competitor tool names to SUDO-AI equivalents.
 *
 * Handles translation between OpenClaw, Hermes, and OpenJarvis tool namespaces
 * and the SUDO-AI canonical naming scheme (category.action). Also translates
 * input parameters and result shapes to match SUDO-AI conventions.
 *
 * @module security/tool-translator
 */

import { createLogger } from '../shared/logger.js';
import { genId, contentHash } from '../shared/utils.js';
import type { ToolTranslatorEntry } from '../shared/wave10-types.js';

const log = createLogger('security:tool-translator');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single tool mapping entry with provenance metadata.
 * Extends ToolTranslatorEntry from wave10-types with a source tag.
 */
export interface ToolMapping extends ToolTranslatorEntry {
  /** Origin of this mapping: which competitor system it was defined for. */
  source: 'openclaw' | 'hermes' | 'openjarvis' | 'custom';
}

/** Result of translating a single tool call. */
export interface ToolTranslationResult {
  /** SUDO-AI internal tool name (category.action format). */
  sudoName: string;
  /** Parameter name mapping from canonical to SUDO-AI param names. */
  paramMap: Record<string, string>;
  /** Whether a mapping was found. false means the tool name is unrecognized. */
  translated: boolean;
  /** Source system that provided the mapping. */
  source: string;
}

// ---------------------------------------------------------------------------
// Default mapping tables
// ---------------------------------------------------------------------------

const DEFAULT_OPENCLAW_MAPPINGS: ToolTranslatorEntry[] = [
  { canonical: 'Read',      sudoName: 'coder.read-file',  paramMap: { file_path: 'path' } },
  { canonical: 'Write',     sudoName: 'coder.write-file', paramMap: { file_path: 'path', content: 'content' } },
  { canonical: 'Edit',      sudoName: 'coder.edit-file',  paramMap: { file_path: 'path', old_string: 'old_string', new_string: 'new_string' } },
  { canonical: 'Bash',      sudoName: 'system.shell',     paramMap: { command: 'command' } },
  { canonical: 'Glob',      sudoName: 'coder.glob',       paramMap: { pattern: 'pattern' } },
  { canonical: 'Grep',      sudoName: 'coder.search',    paramMap: { pattern: 'pattern', path: 'path' } },
  { canonical: 'WebFetch',  sudoName: 'net.fetch',       paramMap: { url: 'url', prompt: 'prompt' } },
  { canonical: 'WebSearch', sudoName: 'net.search',      paramMap: { query: 'query' } },
  { canonical: 'NotebookEdit', sudoName: 'coder.notebook-edit', paramMap: { notebook_path: 'notebook_path', cell_id: 'cell_id', new_source: 'new_source' } },
  { canonical: 'Task',      sudoName: 'agent.task-create', paramMap: {} },
];

const DEFAULT_HERMES_MAPPINGS: ToolTranslatorEntry[] = [
  { canonical: 'memory_read',   sudoName: 'memory.read',   paramMap: {} },
  { canonical: 'memory_write',  sudoName: 'memory.write',  paramMap: {} },
  { canonical: 'memory_search', sudoName: 'memory.search', paramMap: {} },
  { canonical: 'memory_delete', sudoName: 'memory.delete', paramMap: {} },
  { canonical: 'file_read',     sudoName: 'coder.read-file',  paramMap: { path: 'path' } },
  { canonical: 'file_write',    sudoName: 'coder.write-file', paramMap: { path: 'path', content: 'content' } },
  { canonical: 'shell_exec',    sudoName: 'system.shell',     paramMap: { command: 'command' } },
  { canonical: 'web_fetch',     sudoName: 'net.fetch',       paramMap: { url: 'url' } },
  { canonical: 'web_search',   sudoName: 'net.search',      paramMap: { query: 'query' } },
  { canonical: 'list_dir',     sudoName: 'coder.glob',      paramMap: { pattern: 'pattern' } },
];

const DEFAULT_OPENJARVIS_MAPPINGS: ToolTranslatorEntry[] = [
  { canonical: 'read_file',   sudoName: 'coder.read-file',  paramMap: { path: 'path' } },
  { canonical: 'write_file',  sudoName: 'coder.write-file', paramMap: { path: 'path', content: 'content' } },
  { canonical: 'edit_file',   sudoName: 'coder.edit-file',  paramMap: { path: 'path' } },
  { canonical: 'list_files',   sudoName: 'coder.glob',       paramMap: { pattern: 'pattern' } },
  { canonical: 'search_files', sudoName: 'coder.search',    paramMap: { pattern: 'pattern' } },
  { canonical: 'execute',     sudoName: 'system.shell',     paramMap: { command: 'command' } },
  { canonical: 'fetch_url',   sudoName: 'net.fetch',       paramMap: { url: 'url' } },
  { canonical: 'search_web',  sudoName: 'net.search',      paramMap: { query: 'query' } },
];

// ---------------------------------------------------------------------------
// ToolTranslator class
// ---------------------------------------------------------------------------

/**
 * Translates competitor tool names and parameters into SUDO-AI equivalents.
 *
 * Mappings are stored in a lookup table keyed by (source, canonical) for O(1)
 * access. Custom mappings can be added at runtime via addMapping().
 */
export class ToolTranslator {
  private readonly _mappings: Map<string, ToolMapping> = new Map();

  constructor() {
    // Seed default mappings from all three competitor systems.
    for (const entry of DEFAULT_OPENCLAW_MAPPINGS) {
      this._store(entry, 'openclaw');
    }
    for (const entry of DEFAULT_HERMES_MAPPINGS) {
      this._store(entry, 'hermes');
    }
    for (const entry of DEFAULT_OPENJARVIS_MAPPINGS) {
      this._store(entry, 'openjarvis');
    }

    log.info(
      { openclaw: DEFAULT_OPENCLAW_MAPPINGS.length, hermes: DEFAULT_HERMES_MAPPINGS.length, openjarvis: DEFAULT_OPENJARVIS_MAPPINGS.length },
      'ToolTranslator initialized with default mappings',
    );
  }

  // -------------------------------------------------------------------------
  // Core API
  // -------------------------------------------------------------------------

  /**
   * Translate a competitor tool name to the SUDO-AI equivalent.
   *
   * Looks up the canonical tool name in all registered sources.
   * If no mapping is found, returns a result with `translated: false` and
   * the original name passed through as sudoName.
   *
   * @param canonicalName - The competitor's tool name (e.g. "Read", "memory_read").
   * @param source        - Optional source hint to narrow the lookup.
   * @returns Translation result with SUDO-AI tool name and parameter mappings.
   */
  translate(canonicalName: string, source?: string): ToolTranslationResult {
    // Try source-scoped lookup first.
    if (source) {
      const key = this._key(source, canonicalName);
      const mapping = this._mappings.get(key);
      if (mapping) {
        log.debug({ canonicalName, source, sudoName: mapping.sudoName }, 'Tool translated (source-scoped)');
        return {
          sudoName: mapping.sudoName,
          paramMap: mapping.paramMap ?? {},
          translated: true,
          source: mapping.source,
        };
      }
    }

    // Fallback: scan all sources for the canonical name.
    for (const mapping of this._mappings.values()) {
      if (mapping.canonical === canonicalName) {
        log.debug({ canonicalName, source: mapping.source, sudoName: mapping.sudoName }, 'Tool translated (global scan)');
        return {
          sudoName: mapping.sudoName,
          paramMap: mapping.paramMap ?? {},
          translated: true,
          source: mapping.source,
        };
      }
    }

    // No mapping found -- pass through with translated: false.
    log.debug({ canonicalName }, 'No translation found -- passing through');
    return {
      sudoName: canonicalName,
      paramMap: {},
      translated: false,
      source: 'none',
    };
  }

  /**
   * Translate input parameters from canonical names to SUDO-AI names.
   *
   * Applies the parameter mapping from the matched ToolMapping.
   * Unmapped parameters are passed through unchanged.
   *
   * @param canonicalName - The competitor's tool name.
   * @param input         - Key-value input parameters from the competitor tool call.
   * @param source       - Optional source hint.
   * @returns Translated parameters with SUDO-AI parameter names.
   */
  translateInput(
    canonicalName: string,
    input: Record<string, unknown>,
    source?: string,
  ): Record<string, unknown> {
    const result = this.translate(canonicalName, source);
    if (!result.translated || Object.keys(result.paramMap).length === 0) {
      return { ...input };
    }

    const translated: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      const sudoKey = result.paramMap[key] ?? key;
      translated[sudoKey] = value;
    }

    log.debug({ canonicalName, paramMap: result.paramMap }, 'Input parameters translated');
    return translated;
  }

  /**
   * Translate result fields from SUDO-AI names back to canonical names.
   *
   * Reverses the parameter mapping so that results from SUDO-AI tools
   * are presented in the competitor's expected shape.
   *
   * @param canonicalName - The competitor's tool name.
   * @param sudoResult    - Result object from the SUDO-AI tool.
   * @param source       - Optional source hint.
   * @returns Result with keys mapped back to canonical names.
   */
  translateResult(
    canonicalName: string,
    sudoResult: Record<string, unknown>,
    source?: string,
  ): Record<string, unknown> {
    const result = this.translate(canonicalName, source);
    if (!result.translated || Object.keys(result.paramMap).length === 0) {
      return { ...sudoResult };
    }

    // Build reverse mapping: sudoName -> canonical
    const reverseMap: Record<string, string> = {};
    for (const [canonical, sudo] of Object.entries(result.paramMap)) {
      reverseMap[sudo] = canonical;
    }

    const translated: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(sudoResult)) {
      const canonicalKey = reverseMap[key] ?? key;
      translated[canonicalKey] = value;
    }

    log.debug({ canonicalName, reverseMap }, 'Result parameters translated');
    return translated;
  }

  /**
   * Add or override a tool mapping at runtime.
   *
   * @param entry  - The tool translation entry to register.
   * @param source - The source system this mapping belongs to (default: 'custom').
   */
  addMapping(entry: ToolTranslatorEntry, source: ToolMapping['source'] = 'custom'): void {
    this._store(entry, source);
    log.info({ canonical: entry.canonical, sudoName: entry.sudoName, source }, 'Custom mapping added');
  }

  /**
   * Return the set of canonical tool names that have mappings, grouped by source.
   */
  getSupportedTools(): Record<string, string[]> {
    const bySource: Record<string, string[]> = {};

    for (const mapping of this._mappings.values()) {
      const src = mapping.source;
      if (!bySource[src]) bySource[src] = [];
      if (!bySource[src].includes(mapping.canonical)) {
        bySource[src].push(mapping.canonical);
      }
    }

    return bySource;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _key(source: string, canonical: string): string {
    return `${source}::${canonical}`;
  }

  private _store(entry: ToolTranslatorEntry, source: ToolMapping['source']): void {
    const mapping: ToolMapping = { ...entry, source };
    this._mappings.set(this._key(source, entry.canonical), mapping);
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** Default singleton ToolTranslator instance. */
export const toolTranslator = new ToolTranslator();