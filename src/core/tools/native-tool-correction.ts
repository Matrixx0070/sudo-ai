/**
 * @file tools/native-tool-correction.ts
 * @description NativeToolCorrection — when an MCP tool call fails or produces
 * suboptimal results, automatically corrects to the SUDO-AI native equivalent.
 *
 * Provides a mapping table from MCP tool names/patterns to native SUDO-AI
 * tools, argument conversion, and statistics tracking. Disabled globally when
 * the environment variable `SUDO_NATIVE_TOOL_CORRECTION` is set to `"0"`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Maps an MCP tool name or pattern to a native SUDO-AI tool.
 *
 * `mcpPattern` supports three matching strategies evaluated in priority order:
 *   1. **Exact match** — plain string, e.g. `"filesystem_read_file"`
 *   2. **Prefix match** — trailing `*`, e.g. `"grep_*"` matches `grep_search`
 *   3. **Glob match** — `*` in any position, e.g. `"bash_*"` matches `bash_run_cmd`
 *
 * `priority` breaks ties when multiple patterns match: higher number wins.
 */
export interface ToolMapping {
  /** MCP tool name or glob pattern (supports trailing `*` for prefix/glob). */
  mcpPattern: string;
  /** Name of the native SUDO-AI tool to fall back to. */
  nativeTool: string;
  /** Higher priority wins when multiple patterns match the same MCP tool. */
  priority: number;
}

// ---------------------------------------------------------------------------
// Default mappings
// ---------------------------------------------------------------------------

/**
 * Built-in mapping table from common MCP tool names to native SUDO-AI tools.
 * Custom mappings added at runtime override these defaults when they share
 * the same `mcpPattern`.
 */
export const DEFAULT_MCP_TO_NATIVE_MAPPINGS: ToolMapping[] = [
  { mcpPattern: 'filesystem_read_file', nativeTool: 'coder.read-file', priority: 10 },
  { mcpPattern: 'filesystem_write_file', nativeTool: 'coder.write-file', priority: 10 },
  { mcpPattern: 'filesystem_list_directory', nativeTool: 'system.exec', priority: 10 },
  { mcpPattern: 'shell_execute', nativeTool: 'system.exec', priority: 10 },
  { mcpPattern: 'search_web', nativeTool: 'browser.search', priority: 10 },
  { mcpPattern: 'fetch_url', nativeTool: 'browser.fetch', priority: 10 },
  { mcpPattern: 'code_search', nativeTool: 'coder.grep', priority: 10 },
  { mcpPattern: 'code_read', nativeTool: 'coder.read-file', priority: 10 },
  { mcpPattern: 'grep_*', nativeTool: 'coder.grep', priority: 5 },
  { mcpPattern: 'bash_*', nativeTool: 'system.exec', priority: 5 },
];

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** MCP tool name substrings that indicate known low-quality / unstable tools. */
const LOW_QUALITY_PATTERNS = ['experimental', 'beta', 'legacy'] as const;

/** Environment variable that disables native tool correction when set to `"0"`. */
const ENV_DISABLE_FLAG = 'SUDO_NATIVE_TOOL_CORRECTION';

// ---------------------------------------------------------------------------
// NativeToolCorrection
// ---------------------------------------------------------------------------

/**
 * Manages automatic correction of MCP tool calls to native SUDO-AI equivalents.
 *
 * When an MCP tool call fails (error provided) or the tool name signals low
 * quality, the correction engine looks up the best native equivalent and
 * converts the arguments accordingly.
 *
 * @example
 * ```ts
 * const correction = new NativeToolCorrection();
 * const result = correction.correct('filesystem_read_file', { path: '/tmp/x.txt' });
 * // result = { nativeTool: 'coder.read-file', convertedArgs: { path: '/tmp/x.txt' } }
 * ```
 */
export class NativeToolCorrection {
  /** Active mapping table (defaults + user customizations). */
  public mappings: ToolMapping[];

  /** Total number of corrections performed. */
  public correctionCount: number;

  /** Tracks how often each from->to pair has been used. */
  private correctionLog: Map<string, number>;

  constructor(customMappings: ToolMapping[] = []) {
    this.mappings = [...DEFAULT_MCP_TO_NATIVE_MAPPINGS];
    this.correctionCount = 0;
    this.correctionLog = new Map();

    for (const mapping of customMappings) {
      this.addMapping(mapping);
    }
  }

  // -------------------------------------------------------------------------
  // Mapping management
  // -------------------------------------------------------------------------

  /**
   * Add or override a mapping. If a mapping with the same `mcpPattern` already
   * exists, it is replaced; otherwise the new mapping is appended.
   */
  addMapping(mapping: ToolMapping): void {
    const idx = this.mappings.findIndex((m) => m.mcpPattern === mapping.mcpPattern);
    if (idx >= 0) {
      this.mappings[idx] = mapping;
    } else {
      this.mappings.push(mapping);
    }
  }

  /**
   * Remove a mapping by its MCP pattern name.
   */
  removeMapping(mcpPattern: string): void {
    this.mappings = this.mappings.filter((m) => m.mcpPattern !== mcpPattern);
  }

  // -------------------------------------------------------------------------
  // Lookup
  // -------------------------------------------------------------------------

  /**
   * Find the best native equivalent for an MCP tool name.
   *
   * Matching priority:
   *   1. Exact match (highest priority among exact matches)
   *   2. Prefix match — pattern ends with `*`, e.g. `grep_*`
   *   3. Glob match — pattern contains `*` anywhere
   *
   * Among all matches at the same level, the one with the highest `priority`
   * value wins. Returns `null` if no mapping matches.
   */
  findNativeEquivalent(mcpToolName: string): string | null {
    const exactMatches: ToolMapping[] = [];
    const prefixMatches: ToolMapping[] = [];
    const globMatches: ToolMapping[] = [];

    for (const mapping of this.mappings) {
      const pattern = mapping.mcpPattern;

      if (!pattern.includes('*')) {
        // Exact match candidate
        if (pattern === mcpToolName) {
          exactMatches.push(mapping);
        }
      } else if (pattern.endsWith('*') && !pattern.slice(0, -1).includes('*')) {
        // Prefix match: "grep_*" -> matches "grep_search", "grep_find"
        const prefix = pattern.slice(0, -1);
        if (mcpToolName.startsWith(prefix)) {
          prefixMatches.push(mapping);
        }
      } else {
        // Glob match: convert pattern to regex
        const regex = globToRegex(pattern);
        if (regex.test(mcpToolName)) {
          globMatches.push(mapping);
        }
      }
    }

    // Pick the best match: exact > prefix > glob, then by priority descending
    const bestExact = exactMatches.sort((a, b) => b.priority - a.priority)[0];
    if (bestExact) return bestExact.nativeTool;

    const bestPrefix = prefixMatches.sort((a, b) => b.priority - a.priority)[0];
    if (bestPrefix) return bestPrefix.nativeTool;

    const bestGlob = globMatches.sort((a, b) => b.priority - a.priority)[0];
    if (bestGlob) return bestGlob.nativeTool;

    return null;
  }

  // -------------------------------------------------------------------------
  // Decision
  // -------------------------------------------------------------------------

  /**
   * Determine whether an MCP tool call should be corrected to a native tool.
   *
   * Returns `true` when **all** of the following hold:
   *   1. A native equivalent exists for the MCP tool name.
   *   2. Either the MCP tool failed (`lastError` is provided) **or** the MCP
   *      tool name contains a known low-quality pattern (`experimental`,
   *      `beta`, `legacy`).
   *   3. The `SUDO_NATIVE_TOOL_CORRECTION` environment variable is not set
   *      to `"0"`.
   */
  shouldCorrect(mcpToolName: string, lastError?: string): boolean {
    // Check environment disable flag
    if (process.env[ENV_DISABLE_FLAG] === '0') {
      return false;
    }

    // Must have a native equivalent
    if (this.findNativeEquivalent(mcpToolName) === null) {
      return false;
    }

    // Correct if error was provided
    if (lastError !== undefined && lastError.length > 0) {
      return true;
    }

    // Correct if tool name contains low-quality patterns
    const nameLower = mcpToolName.toLowerCase();
    for (const pattern of LOW_QUALITY_PATTERNS) {
      if (nameLower.includes(pattern)) {
        return true;
      }
    }

    return false;
  }

  // -------------------------------------------------------------------------
  // Correction
  // -------------------------------------------------------------------------

  /**
   * Convert an MCP tool call (name + args) to the native equivalent.
   *
   * Returns `{ nativeTool, convertedArgs }` on success, or `null` if no
   * correction is available (no mapping found, or correction is disabled).
   *
   * Argument conversion rules (targets are real SUDO-AI tools):
   * - `filesystem_read_file` -> `coder.read-file`: `{ path: args.path ?? args.file_path }`
   * - `filesystem_write_file` -> `coder.write-file`: `{ path, content }`
   * - `filesystem_list_directory` -> `system.exec`: `{ command: "ls <args.path>" }`
   * - `shell_execute` -> `system.exec`: `{ command: args.command }`
   * - `search_web` -> `browser.search`: `{ query: args.query }`
   * - `fetch_url` -> `browser.fetch`: `{ url: args.url }`
   * - `code_search` -> `coder.grep`: `{ pattern: args.pattern ?? args.query ?? args.regex ?? args.q }`
   * - `code_read` -> `coder.read-file`: `{ path: args.path ?? args.file_path }`
   * - `grep_*` prefix match -> `coder.grep`: `{ pattern: ... }`
   * - `bash_*` prefix match -> `system.exec`: `{ command: args.command ?? args.cmd }`
   * - Any other match: args passed through unchanged
   */
  correct(
    mcpToolName: string,
    args: Record<string, unknown>,
  ): { nativeTool: string; convertedArgs: Record<string, unknown> } | null {
    // Check environment disable flag
    if (process.env[ENV_DISABLE_FLAG] === '0') {
      return null;
    }

    const nativeTool = this.findNativeEquivalent(mcpToolName);
    if (nativeTool === null) {
      return null;
    }

    const convertedArgs = this.convertArgs(mcpToolName, nativeTool, args);

    // Update stats
    this.correctionCount++;
    const key = `${mcpToolName}->${nativeTool}`;
    this.correctionLog.set(key, (this.correctionLog.get(key) ?? 0) + 1);

    return { nativeTool, convertedArgs };
  }

  // -------------------------------------------------------------------------
  // Statistics
  // -------------------------------------------------------------------------

  /**
   * Return correction statistics: total count and top corrections sorted by
   * frequency (descending).
   */
  getStats(): {
    correctionCount: number;
    topCorrections: Array<{ from: string; to: string; count: number }>;
  } {
    const topCorrections: Array<{ from: string; to: string; count: number }> = [];

    for (const [key, count] of this.correctionLog) {
      const [from, to] = key.split('->');
      topCorrections.push({ from, to, count });
    }

    topCorrections.sort((a, b) => b.count - a.count);

    return { correctionCount: this.correctionCount, topCorrections };
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Convert MCP tool arguments to native tool arguments based on the
   * source and target tool names.
   */
  private convertArgs(
    mcpToolName: string,
    nativeTool: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    // Explicit per-tool conversion. Targets are real SUDO-AI tools:
    // coder.read-file/write-file use `path`; system.exec uses `command`;
    // coder.grep uses `pattern`; browser.search uses `query`; browser.fetch `url`.
    if (mcpToolName === 'filesystem_read_file') {
      return { path: args.path ?? args.file_path };
    }

    if (mcpToolName === 'filesystem_write_file') {
      return { path: args.path ?? args.file_path, content: args.content };
    }

    if (mcpToolName === 'filesystem_list_directory') {
      const dir = (args.path ?? args.dir ?? '.').toString();
      // Single-quote the path so spaces / shell metacharacters in an
      // attacker-influenced MCP arg can't inject into the system.exec command.
      const quoted = `'${dir.replace(/'/g, `'\\''`)}'`;
      return { command: `ls -- ${quoted}` };
    }

    if (mcpToolName === 'shell_execute') {
      return { command: args.command ?? args.cmd };
    }

    if (mcpToolName === 'search_web') {
      return { query: args.query };
    }

    if (mcpToolName === 'fetch_url') {
      return { url: args.url };
    }

    if (mcpToolName === 'code_search') {
      return { pattern: args.pattern ?? args.query ?? args.regex ?? args.q };
    }

    if (mcpToolName === 'code_read') {
      return { path: args.path ?? args.file_path };
    }

    // Prefix / glob matches — generic conversions
    if (mcpToolName.startsWith('grep_')) {
      return { pattern: args.pattern ?? args.query ?? args.regex ?? args.q };
    }

    if (mcpToolName.startsWith('bash_')) {
      return { command: args.command ?? args.cmd };
    }

    // Fallback: pass args through unchanged
    return { ...args };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a simple glob pattern (containing `*`) to a RegExp.
 * Only `*` is supported; all other characters are escaped literally.
 */
function globToRegex(pattern: string): RegExp {
  const parts = pattern.split('*');
  const escaped = parts.map((part) => escapeRegex(part));
  return new RegExp('^' + escaped.join('.*') + '$');
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}