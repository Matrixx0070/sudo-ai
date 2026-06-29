/**
 * ToolDiscovery — AST-based tool auto-discovery for SUDO-AI v4.
 *
 * Inspired by Hermes Agent's auto-discovery that scans for registry.register()
 * calls.  Instead of requiring manual registration, this module walks tool
 * source directories, reads each file, and extracts @Tool() decorator metadata
 * using lightweight regex/AST pattern matching (no full TypeScript parser).
 *
 * Flow:
 *   1. Recursively find all .ts/.js files in configured scan directories.
 *   2. Read each file's source text.
 *   3. Match the @Tool('name', 'description', { ...metadata }) decorator pattern.
 *   4. Match the `extends BaseTool` class pattern.
 *   5. Return a list of DiscoveredTool objects ready for registration.
 *
 * Supports hot-reload via fs.watch: re-scan on demand when files change.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { ToolRegistry } from './registry.js';
import type { ToolCategory } from './types.js';
import type { ToolMetadata } from './base-tool.js';
import { createLogger } from '../shared/logger.js';

const logger = createLogger('tool-discovery');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Metadata extracted from a @Tool() decorator in a scanned source file.
 * Mirrors the fields that the decorator accepts at authoring time.
 */
export interface DiscoveredTool {
  /** Absolute path to the source file that declares the tool. */
  filePath: string;
  /** Class name that extends BaseTool (e.g. 'FileReadTool'). */
  className: string;
  /** Dot-namespaced tool identifier from @Tool() (e.g. 'fs.read'). */
  toolName: string;
  /** Human-readable description from the @Tool() decorator. */
  description: string;
  /** Category inferred from the class body or decorator metadata. */
  category: ToolCategory;
  /** Cost / latency / confirmation metadata extracted from the decorator. */
  metadata: ToolMetadata;
}

/** Result of a full directory scan. */
export interface DiscoveryResult {
  /** Successfully discovered tools. */
  discovered: DiscoveredTool[];
  /** Files that could not be parsed or lacked valid decorator patterns. */
  errors: Array<{ file: string; error: string }>;
  /** Wall-clock time for the scan in milliseconds. */
  scanTimeMs: number;
}

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

/**
 * Match the @Tool('name', 'description', { ...metadata }) decorator.
 * Supports single, double, and backtick-quoted strings for the first two args.
 * The third argument (metadata object) is optional.
 *
 * Capture groups:
 *   1 — tool name (string)
 *   2 — description (string)
 *   3 — metadata object body (optional, may be empty)
 */
// NOTE: no `g` flag — `.exec()` is read once per file in scanFile(); a global
// regex would persist `lastIndex` across files and silently skip decorators in
// later/smaller files.
const TOOL_DECORATOR_RE =
  /@Tool\(\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)\s*,\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)\s*(?:,\s*(\{[^}]*\}))?\s*\)/s;

/**
 * Match a class declaration that extends BaseTool.
 * Capture group 1 is the class name.
 */
const EXTENDS_BASE_TOOL_RE = /class\s+(\w+)\s+extends\s+BaseTool\b/;

/**
 * Extract a `category: ToolCategory = '...'` assignment from the class body.
 * Capture group 1 is the category string literal.
 */
const CATEGORY_ASSIGN_RE = /category\s*:\s*ToolCategory\s*=\s*(?:'([^']*)'|"([^"]*)")/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Valid ToolCategory values used for validation during extraction. */
const VALID_CATEGORIES = new Set<ToolCategory>([
  'coder', 'system', 'browser', 'knowledge', 'business', 'comms',
  'content', 'superpowers', 'media', 'memory', 'channel', 'pipeline',
  'voice', 'earning', 'social', 'research', 'dev', 'marketing',
  'finance', 'data', 'pm', 'personal', 'legal', 'meta', 'document',
  'spreadsheet', 'code', 'custom',
]);

/** Default category when none can be inferred from the class body. */
const DEFAULT_CATEGORY: ToolCategory = 'custom';

/** Default metadata applied when decorator omits the metadata argument. */
const DEFAULT_METADATA: ToolMetadata = {
  costEstimate: 'free',
  latencyEstimate: 'instant',
  requiresConfirmation: false,
  profile: 'minimal',
};

/**
 * Recursively collect all .ts and .js file paths under a root directory.
 * Skips node_modules, .git, and dist/build output directories.
 */
async function collectSourceFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];
  // Skip directories that never contain tool sources.
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.turbo']);

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
      } else if (entry.isFile() && /\.(?:ts|js)$/.test(entry.name)) {
        files.push(path.join(dir, entry.name));
      }
    }
  }

  await walk(rootDir);
  return files;
}

/**
 * Attempt to parse a metadata object literal from the third @Tool() argument.
 * Only extracts a handful of known keys — does not attempt full JSON parsing.
 * Returns a partial ToolMetadata merged over the defaults.
 */
function parseMetadataObject(raw: string | undefined): ToolMetadata {
  if (!raw) return { ...DEFAULT_METADATA };

  const meta: Partial<ToolMetadata> = {};

  // costEstimate: 'free' | 'low' | 'medium' | 'high'
  const costMatch = raw.match(/costEstimate\s*:\s*(?:'([^']*)'|"([^"]*)")/);
  if (costMatch) {
    const val = costMatch[1] ?? costMatch[2];
    if (val && ['free', 'low', 'medium', 'high'].includes(val)) {
      meta.costEstimate = val as ToolMetadata['costEstimate'];
    }
  }

  // latencyEstimate: 'instant' | 'fast' | 'medium' | 'slow'
  const latencyMatch = raw.match(/latencyEstimate\s*:\s*(?:'([^']*)'|"([^"]*)")/);
  if (latencyMatch) {
    const val = latencyMatch[1] ?? latencyMatch[2];
    if (val && ['instant', 'fast', 'medium', 'slow'].includes(val)) {
      meta.latencyEstimate = val as ToolMetadata['latencyEstimate'];
    }
  }

  // requiresConfirmation: true | false
  const confirmMatch = raw.match(/requiresConfirmation\s*:\s*(true|false)/);
  if (confirmMatch) {
    meta.requiresConfirmation = confirmMatch[1] === 'true';
  }

  // profile: 'minimal' | 'coding' | 'full'
  const profileMatch = raw.match(/profile\s*:\s*(?:'([^']*)'|"([^"]*)")/);
  if (profileMatch) {
    const val = profileMatch[1] ?? profileMatch[2];
    if (val && ['minimal', 'coding', 'full'].includes(val)) {
      meta.profile = val as ToolMetadata['profile'];
    }
  }

  // deprecated: true | false
  const deprecMatch = raw.match(/deprecated\s*:\s*(true|false)/);
  if (deprecMatch) {
    meta.deprecated = deprecMatch[1] === 'true';
  }

  // replacement: '...'
  const replacementMatch = raw.match(/replacement\s*:\s*(?:'([^']*)'|"([^"]*)")/);
  if (replacementMatch) {
    meta.replacement = replacementMatch[1] ?? replacementMatch[2];
  }

  return { ...DEFAULT_METADATA, ...meta };
}

/**
 * Extract the first non-undefined value from a set of regex capture groups.
 * Used because the decorator regex supports multiple quote styles.
 */
function firstCapture(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    if (v !== undefined) return v;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// ToolDiscovery class
// ---------------------------------------------------------------------------

/**
 * Scans tool source directories for classes decorated with @Tool(),
 * extracts metadata, and registers discovered tools with a ToolRegistry.
 *
 * Designed for hot-reload: call scan() at any time to re-read the filesystem,
 * or use watchForChanges() to get automatic callbacks when files change.
 */
export class ToolDiscovery {
  /** Directories to scan recursively for tool source files. */
  private readonly scanDirs: string[];
  /** Running stats across all scan() calls. */
  private totalScans = 0;
  private toolsDiscovered = 0;
  private errors = 0;
  /** Active fs.watch watchers (cleaned up on watchForChanges stop). */
  private watchers: Array<{ watcher: import('node:fs').FSWatcher; dir: string }> = [];
  /** Most recent scan result, used for diffing on re-scan. */
  private lastDiscovered: Map<string, DiscoveredTool> = new Map();

  constructor(scanDirs: string[]) {
    if (!scanDirs.length) {
      logger.warn('ToolDiscovery created with no scan directories');
    }
    this.scanDirs = scanDirs;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Perform a full scan of all configured directories.
   *
   * 1. Recursively find every .ts/.js file.
   * 2. Read and parse each file for @Tool() decorators.
   * 3. Return a DiscoveryResult with discovered tools and any errors.
   */
  async scan(): Promise<DiscoveryResult> {
    const start = Date.now();
    const discovered: DiscoveredTool[] = [];
    const errors: Array<{ file: string; error: string }> = [];

    // Collect all candidate source files across every scan directory.
    let allFiles: string[] = [];
    for (const dir of this.scanDirs) {
      try {
        const files = await collectSourceFiles(dir);
        allFiles = allFiles.concat(files);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({ file: dir, error: `Failed to scan directory: ${msg}` });
      }
    }

    // Deduplicate by absolute path (in case dirs overlap).
    allFiles = [...new Set(allFiles)];

    // Parse each file for @Tool() decorator patterns.
    for (const filePath of allFiles) {
      try {
        const tool = await this.scanFile(filePath);
        if (tool) {
          discovered.push(tool);
          this.lastDiscovered.set(tool.toolName, tool);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({ file: filePath, error: msg });
      }
    }

    const scanTimeMs = Date.now() - start;

    // Update cumulative stats.
    this.totalScans++;
    this.toolsDiscovered += discovered.length;
    this.errors += errors.length;

    logger.info(
      { discovered: discovered.length, errors: errors.length, scanTimeMs },
      'Tool discovery scan complete',
    );

    return { discovered, errors, scanTimeMs };
  }

  /**
   * Scan a single file for @Tool() decorator metadata.
   *
   * @param filePath - Absolute path to a .ts or .js source file.
   * @returns A DiscoveredTool if the file contains a valid decorator, or null.
   */
  async scanFile(filePath: string): Promise<DiscoveredTool | null> {
    const content = await fs.readFile(filePath, 'utf-8');

    // 1. Find the @Tool('name', 'description', { ...metadata }) decorator.
    const decoratorMatch = TOOL_DECORATOR_RE.exec(content);
    if (!decoratorMatch) return null;

    // Extract tool name and description — try each quote-style capture group.
    const toolName = firstCapture(decoratorMatch[1], decoratorMatch[2], decoratorMatch[3]);
    const description = firstCapture(decoratorMatch[4], decoratorMatch[5], decoratorMatch[6]);
    if (!toolName || !description) {
      logger.debug({ filePath }, 'Found @Tool() but could not extract name/description');
      return null;
    }

    // Extract optional metadata object literal (capture group 7).
    const metadataRaw = decoratorMatch[7];
    const metadata = parseMetadataObject(metadataRaw);

    // 2. Find the class declaration that extends BaseTool.
    const classMatch = EXTENDS_BASE_TOOL_RE.exec(content);
    const className = classMatch?.[1] ?? path.basename(filePath, path.extname(filePath));

    // 3. Try to infer category from the class body.
    const categoryMatch = CATEGORY_ASSIGN_RE.exec(content);
    let category: ToolCategory = DEFAULT_CATEGORY;
    if (categoryMatch) {
      const candidate = firstCapture(categoryMatch[1], categoryMatch[2]);
      if (candidate && VALID_CATEGORIES.has(candidate as ToolCategory)) {
        category = candidate as ToolCategory;
      }
    }

    return {
      filePath,
      className,
      toolName,
      description,
      category,
      metadata,
    };
  }

  /**
   * Register all discovered tools with the given ToolRegistry.
   * Re-scans directories first, then creates minimal ToolDefinition stubs
   * for each discovered tool and registers them.
   *
   * Note: this registers lightweight stub definitions. For full tool execution
   * the actual tool modules must be imported so their BaseTool subclasses are
   * instantiated and auto-registered by the @Tool() decorator.
   *
   * @param registry - The ToolRegistry to register discovered tools into.
   * @returns Number of tools successfully registered.
   */
  async registerAll(registry: ToolRegistry): Promise<number> {
    const { discovered, errors } = await this.scan();

    if (errors.length) {
      logger.warn({ errorCount: errors.length }, 'Some files had discovery errors during registerAll');
    }

    let registered = 0;
    for (const tool of discovered) {
      try {
        // Build a minimal ToolDefinition from the discovered metadata.
        // This is useful for pre-populating the registry before the actual
        // modules are imported — the @Tool() decorator will overwrite with
        // the full definition when the module is loaded.
        registry.register({
          name: tool.toolName,
          description: tool.description,
          category: tool.category,
          parameters: {}, // Parameters are only available after full import.
          requiresConfirmation: tool.metadata.requiresConfirmation,
          execute: async () => ({
            success: false,
            output: `Tool "${tool.toolName}" discovered but not yet loaded. Import its module to enable execution.`,
          }),
        });
        registered++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ tool: tool.toolName, error: msg }, 'Failed to register discovered tool');
      }
    }

    logger.info({ registered, total: discovered.length }, 'Discovered tools registered');
    return registered;
  }

  /**
   * Watch all scan directories for file changes using fs.watch.
   * On any change, re-scan and invoke the callback with lists of
   * newly added and removed tools.
   *
   * The watcher is debounced: rapid successive changes within 300 ms
   * are coalesced into a single re-scan.
   *
   * @param callback - Invoked with (added, removedToolNames) after each re-scan.
   * @returns A stop function that closes all watchers.
   */
  watchForChanges(
    callback: (added: DiscoveredTool[], removed: string[]) => void,
  ): () => void {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const DEBOUNCE_MS = 300;

    const handleChange = (): void => {
      // Debounce: coalesce rapid filesystem events into a single re-scan.
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        debounceTimer = null;
        try {
          // Snapshot the prior state BEFORE scan() — scan() mutates
          // this.lastDiscovered in place, so diffing against it afterwards
          // would always yield empty added/removed and never fire the callback.
          const prev = new Map(this.lastDiscovered);
          const { discovered } = await this.scan();
          const currentNames = new Set(discovered.map((t) => t.toolName));

          // Determine newly added tools (present now, absent before).
          const added: DiscoveredTool[] = discovered.filter(
            (t) => !prev.has(t.toolName),
          );

          // Determine removed tools (present before, absent now).
          const removed: string[] = [...prev.keys()].filter(
            (name) => !currentNames.has(name),
          );

          // scan() already refreshed this.lastDiscovered; keep it authoritative.
          this.lastDiscovered = new Map(discovered.map((t) => [t.toolName, t]));

          if (added.length || removed.length) {
            callback(added, removed);
          }
        } catch (err) {
          logger.error({ err }, 'Error during watch re-scan');
        }
      }, DEBOUNCE_MS);
    };

    // Attach an fs watcher to each scan directory.
    for (const dir of this.scanDirs) {
      try {
        // Use recursive: true to watch subdirectories (Linux uses recursive polling).
        const watcher = require('node:fs').watch(dir, { recursive: true }, () => {
          handleChange();
        });
        this.watchers.push({ watcher, dir });
        logger.debug({ dir }, 'Watching directory for tool changes');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ dir, error: msg }, 'Failed to watch directory');
      }
    }

    // Return a cleanup function.
    const stopWatching = (): void => {
      for (const { watcher, dir } of this.watchers) {
        watcher.close();
        logger.debug({ dir }, 'Stopped watching directory');
      }
      this.watchers = [];
      if (debounceTimer) clearTimeout(debounceTimer);
    };

    return stopWatching;
  }

  /**
   * Return cumulative statistics across all scans.
   */
  getStats(): { totalScans: number; toolsDiscovered: number; errors: number } {
    return {
      totalScans: this.totalScans,
      toolsDiscovered: this.toolsDiscovered,
      errors: this.errors,
    };
  }
}