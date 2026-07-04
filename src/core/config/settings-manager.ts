/**
 * SettingsManager — layered settings with project and local scopes.
 *
 * Scopes:
 *   project  — `settings.toml`, checked into version control, shared by team.
 *   local    — `settings.local.toml`, git-ignored, personal overrides.
 *
 * Merge order: project → local (local wins on conflict).
 *
 * Features:
 *   - Per-tool allow / deny rules
 *   - Scoped get / set / delete
 *   - TOML-based persistence
 *   - Lazy load on first access
 */

import fs from 'fs';
import { writeFileAtomic } from '../shared/atomic-write.js';
import path from 'path';
import { createLogger } from '../shared/logger.js';
import { ConfigError } from '../shared/errors.js';

const log = createLogger('config:settings');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Setting scopes — determines which file is read / written. */
export type SettingsScope = 'project' | 'local';

/** A single settings entry with optional scope metadata. */
export interface SettingsEntry {
  /** The setting value — can be any JSON-compatible value. */
  value: unknown;
  /** Which scope this entry came from (set during load / merge). */
  scope: SettingsScope;
}

/** The in-memory representation of a settings file. */
export interface SettingsFile {
  /** Flat key → value map (dot-notation keys). */
  settings: Record<string, unknown>;
  /** Per-tool allow rules: toolName → array of action patterns. */
  toolAllow: Record<string, string[]>;
  /** Per-tool deny rules: toolName → array of action patterns. */
  toolDeny: Record<string, string[]>;
}

/** Constructor options. */
export interface SettingsManagerConfig {
  /** Project root directory. Defaults to cwd. */
  rootDir?: string;
  /** Custom filename for the project settings file. Defaults to `settings.toml`. */
  projectFilename?: string;
  /** Custom filename for the local settings file. Defaults to `settings.local.toml`. */
  localFilename?: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_PROJECT_FILENAME = 'settings.toml';
const DEFAULT_LOCAL_FILENAME = 'settings.local.toml';

const EMPTY_FILE: SettingsFile = {
  settings: {},
  toolAllow: {},
  toolDeny: {},
};

// ---------------------------------------------------------------------------
// SettingsManager
// ---------------------------------------------------------------------------

export class SettingsManager {
  private readonly rootDir: string;
  private readonly projectPath: string;
  private readonly localPath: string;

  private projectFile: SettingsFile | null = null;
  private localFile: SettingsFile | null = null;

  /** Merged view (project + local). Built lazily, invalidated on mutation. */
  private mergedCache: SettingsFile | null = null;

  constructor(config?: SettingsManagerConfig) {
    this.rootDir = path.resolve(config?.rootDir ?? process.cwd());
    this.projectPath = path.join(this.rootDir, config?.projectFilename ?? DEFAULT_PROJECT_FILENAME);
    this.localPath = path.join(this.rootDir, config?.localFilename ?? DEFAULT_LOCAL_FILENAME);
  }

  // -------------------------------------------------------------------------
  // Public API — reading
  // -------------------------------------------------------------------------

  /**
   * Get a setting value by key (dot-notation supported).
   *
   * Resolution order: local → project → undefined.
   *
   * @param key - Dot-notation key, e.g. "agent.maxIterations".
   * @returns The value, or `undefined` if not found.
   */
  getSetting(key: string): unknown {
    this.ensureLoaded();
    const merged = this.getMerged();

    // Local overrides project
    if (key in merged.settings) {
      return merged.settings[key];
    }

    return undefined;
  }

  /**
   * Get a setting value with explicit scope.
   *
   * @param key   - Dot-notation key.
   * @param scope - Which scope to read from.
   * @returns The value, or `undefined` if not found in that scope.
   */
  getSettingScoped(key: string, scope: SettingsScope): unknown {
    this.ensureLoaded();
    const file = scope === 'local' ? this.localFile : this.projectFile;
    return file?.settings[key] ?? undefined;
  }

  /**
   * Return all project-scope settings as a flat key-value map.
   */
  getProjectSettings(): Record<string, unknown> {
    this.ensureLoaded();
    return { ...(this.projectFile?.settings ?? {}) };
  }

  /**
   * Return all local-scope settings as a flat key-value map.
   */
  getLocalSettings(): Record<string, unknown> {
    this.ensureLoaded();
    return { ...(this.localFile?.settings ?? {}) };
  }

  /**
   * Return the merged settings (project + local, local wins on conflict).
   */
  getMergedSettings(): Record<string, unknown> {
    this.ensureLoaded();
    return { ...this.getMerged().settings };
  }

  /**
   * Check whether a tool action is allowed per the allow/deny rules.
   *
   * Resolution:
   *   1. If the tool has a matching deny rule → denied.
   *   2. If the tool has a matching allow rule → allowed.
   *   3. If neither allow nor deny rules exist → allowed (permissive default).
   *   4. If allow rules exist but no match → denied.
   *
   * @param toolName - Name of the tool.
   * @param action   - Action pattern (e.g. "read", "write", "shell:*").
   * @returns `true` if the action is allowed.
   */
  isToolActionAllowed(toolName: string, action: string): boolean {
    this.ensureLoaded();
    const merged = this.getMerged();

    const denyPatterns = merged.toolDeny[toolName] ?? [];
    const allowPatterns = merged.toolAllow[toolName] ?? [];

    // Step 1: deny takes priority
    if (matchesAnyPattern(action, denyPatterns)) {
      return false;
    }

    // Step 2: explicit allow
    if (matchesAnyPattern(action, allowPatterns)) {
      return true;
    }

    // Step 3: no rules at all → permissive
    if (denyPatterns.length === 0 && allowPatterns.length === 0) {
      return true;
    }

    // Step 4: allow rules exist but no match → denied
    if (allowPatterns.length > 0) {
      return false;
    }

    // Only deny rules exist and nothing matched → allowed
    return true;
  }

  /**
   * Return the allow/deny rules for a specific tool from the merged view.
   */
  getToolRules(toolName: string): { allow: string[]; deny: string[] } {
    this.ensureLoaded();
    const merged = this.getMerged();
    return {
      allow: [...(merged.toolAllow[toolName] ?? [])],
      deny: [...(merged.toolDeny[toolName] ?? [])],
    };
  }

  // -------------------------------------------------------------------------
  // Public API — writing
  // -------------------------------------------------------------------------

  /**
   * Set a setting value in the given scope.
   *
   * @param key   - Dot-notation key.
   * @param value - Value to set (must be JSON-compatible).
   * @param scope - Which scope to write to. Defaults to `project`.
   */
  setSetting(key: string, value: unknown, scope: SettingsScope = 'project'): void {
    this.ensureLoaded();
    validateKey(key);

    const file = this.getOrCreateFile(scope);
    file.settings[key] = value;

    this.invalidateMergeCache();
    log.info({ key, scope }, 'Setting updated');

    this.saveSettings(scope);
  }

  /**
   * Delete a setting from the given scope.
   *
   * @param key   - Dot-notation key to delete.
   * @param scope - Which scope to delete from. Defaults to `project`.
   * @returns `true` if the key existed and was deleted; `false` if not found.
   */
  deleteSetting(key: string, scope: SettingsScope = 'project'): boolean {
    this.ensureLoaded();

    const file = scope === 'local' ? this.localFile : this.projectFile;
    if (!file || !(key in file.settings)) {
      return false;
    }

    delete file.settings[key];
    this.invalidateMergeCache();
    log.info({ key, scope }, 'Setting deleted');
    this.saveSettings(scope);
    return true;
  }

  /**
   * Add an allow rule for a tool in the given scope.
   */
  addToolAllow(toolName: string, pattern: string, scope: SettingsScope = 'project'): void {
    this.ensureLoaded();
    const file = this.getOrCreateFile(scope);

    if (!file.toolAllow[toolName]) {
      file.toolAllow[toolName] = [];
    }

    if (!file.toolAllow[toolName].includes(pattern)) {
      file.toolAllow[toolName].push(pattern);
      this.invalidateMergeCache();
      this.saveSettings(scope);
      log.info({ toolName, pattern, scope }, 'Tool allow rule added');
    }
  }

  /**
   * Add a deny rule for a tool in the given scope.
   */
  addToolDeny(toolName: string, pattern: string, scope: SettingsScope = 'project'): void {
    this.ensureLoaded();
    const file = this.getOrCreateFile(scope);

    if (!file.toolDeny[toolName]) {
      file.toolDeny[toolName] = [];
    }

    if (!file.toolDeny[toolName].includes(pattern)) {
      file.toolDeny[toolName].push(pattern);
      this.invalidateMergeCache();
      this.saveSettings(scope);
      log.info({ toolName, pattern, scope }, 'Tool deny rule added');
    }
  }

  /**
   * Remove an allow rule for a tool.
   *
   * @returns `true` if the rule was found and removed.
   */
  removeToolAllow(toolName: string, pattern: string, scope: SettingsScope = 'project'): boolean {
    this.ensureLoaded();
    const file = scope === 'local' ? this.localFile : this.projectFile;
    if (!file?.toolAllow[toolName]) return false;

    const idx = file.toolAllow[toolName].indexOf(pattern);
    if (idx === -1) return false;

    file.toolAllow[toolName].splice(idx, 1);
    if (file.toolAllow[toolName].length === 0) {
      delete file.toolAllow[toolName];
    }

    this.invalidateMergeCache();
    this.saveSettings(scope);
    return true;
  }

  /**
   * Remove a deny rule for a tool.
   *
   * @returns `true` if the rule was found and removed.
   */
  removeToolDeny(toolName: string, pattern: string, scope: SettingsScope = 'project'): boolean {
    this.ensureLoaded();
    const file = scope === 'local' ? this.localFile : this.projectFile;
    if (!file?.toolDeny[toolName]) return false;

    const idx = file.toolDeny[toolName].indexOf(pattern);
    if (idx === -1) return false;

    file.toolDeny[toolName].splice(idx, 1);
    if (file.toolDeny[toolName].length === 0) {
      delete file.toolDeny[toolName];
    }

    this.invalidateMergeCache();
    this.saveSettings(scope);
    return true;
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /**
   * Load settings from both TOML files.
   *
   * This is called lazily on first access, but can also be called explicitly
   * to re-read from disk.
   */
  loadSettings(): void {
    this.projectFile = this.loadTomlFile(this.projectPath, 'project');
    this.localFile = this.loadTomlFile(this.localPath, 'local');
    this.invalidateMergeCache();
    log.info('Settings loaded from disk');
  }

  /**
   * Save the current in-memory state for a scope to its TOML file.
   */
  saveSettings(scope: SettingsScope): void {
    const filePath = scope === 'local' ? this.localPath : this.projectPath;
    const file = scope === 'local' ? this.localFile : this.projectFile;

    if (!file) {
      // Nothing to save — file was never loaded or created.
      return;
    }

    try {
      const toml = serializeSettingsFile(file);
      writeFileAtomic(filePath, toml); // atomic: a torn write would corrupt settings
      log.debug({ path: filePath, scope }, 'Settings saved');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message, path: filePath, scope }, 'Failed to save settings');
    }
  }

  /**
   * Return the file paths being managed (useful for diagnostics).
   */
  getPaths(): { project: string; local: string } {
    return { project: this.projectPath, local: this.localPath };
  }

  // -------------------------------------------------------------------------
  // Merge
  // -------------------------------------------------------------------------

  /**
   * Merge project and local settings.
   *
   * Local values override project values on key collision.
   * Tool rules are merged (both allow and deny lists are concatenated;
   * deny takes priority in isToolActionAllowed).
   */
  mergeSettings(): SettingsFile {
    this.ensureLoaded();
    return this.getMerged();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private ensureLoaded(): void {
    if (this.projectFile === null || this.localFile === null) {
      this.loadSettings();
    }
  }

  private getOrCreateFile(scope: SettingsScope): SettingsFile {
    if (scope === 'local') {
      if (!this.localFile) {
        this.localFile = { settings: {}, toolAllow: {}, toolDeny: {} };
      }
      return this.localFile;
    }

    if (!this.projectFile) {
      this.projectFile = { settings: {}, toolAllow: {}, toolDeny: {} };
    }
    return this.projectFile;
  }

  private invalidateMergeCache(): void {
    this.mergedCache = null;
  }

  private getMerged(): SettingsFile {
    if (this.mergedCache) return this.mergedCache;

    const proj = this.projectFile ?? EMPTY_FILE;
    const loc = this.localFile ?? EMPTY_FILE;

    const merged: SettingsFile = {
      settings: { ...proj.settings, ...loc.settings }, // local wins
      toolAllow: mergeToolRules(proj.toolAllow, loc.toolAllow),
      toolDeny: mergeToolRules(proj.toolDeny, loc.toolDeny),
    };

    this.mergedCache = merged;
    return merged;
  }

  /**
   * Load and parse a TOML settings file.
   * Returns an empty SettingsFile if the file does not exist or is invalid.
   */
  private loadTomlFile(filePath: string, scope: SettingsScope): SettingsFile {
    if (!fs.existsSync(filePath)) {
      log.debug({ path: filePath, scope }, 'Settings file not found — using empty');
      return { settings: {}, toolAllow: {}, toolDeny: {} };
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      return parseSettingsToml(raw, filePath, scope);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err: message, path: filePath, scope }, 'Failed to read settings file — using empty');
      return { settings: {}, toolAllow: {}, toolDeny: {} };
    }
  }
}

// ---------------------------------------------------------------------------
// TOML parsing (sync, lightweight — avoids top-level smol-toml import)
// ---------------------------------------------------------------------------

/**
 * Parse a simple TOML file into a SettingsFile.
 *
 * Supported structures:
 *   [settings]
 *   key = "value"
 *   key2 = 42
 *
 *   [toolAllow.toolName]
 *   patterns = ["read", "write"]
 *
 *   [toolDeny.toolName]
 *   patterns = ["destructive:*"]
 *
 * This is a hand-rolled parser for the subset we need.  For full TOML
 * support with edge cases, use `smol-toml`.
 */
function parseSettingsToml(raw: string, filePath: string, scope: SettingsScope): SettingsFile {
  // Try smol-toml first for full spec compliance
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { parse } = require('smol-toml');
    const parsed = parse(raw) as Record<string, unknown>;

    return extractSettingsFromParsed(parsed);
  } catch {
    // Fall back to the hand-rolled lightweight parser
  }

  // Lightweight fallback parser
  const result: SettingsFile = { settings: {}, toolAllow: {}, toolDeny: {} };
  let currentSection: string | null = null;
  let currentToolName: string | null = null;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();

    // Skip blanks and comments
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    // Section headers: [settings], [toolAllow.shell], [toolDeny.browser]
    const sectionMatch = trimmed.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      const section = sectionMatch[1];
      if (section === 'settings') {
        currentSection = 'settings';
        currentToolName = null;
      } else if (section.startsWith('toolAllow.')) {
        currentSection = 'toolAllow';
        currentToolName = section.slice('toolAllow.'.length);
        if (currentToolName && !result.toolAllow[currentToolName]) {
          result.toolAllow[currentToolName] = [];
        }
      } else if (section.startsWith('toolDeny.')) {
        currentSection = 'toolDeny';
        currentToolName = section.slice('toolDeny.'.length);
        if (currentToolName && !result.toolDeny[currentToolName]) {
          result.toolDeny[currentToolName] = [];
        }
      } else {
        currentSection = null;
        currentToolName = null;
      }
      continue;
    }

    // Key = value lines (supports quoted keys with dots like "agent.name")
    const kvMatch = trimmed.match(/^(?:"([^"]+)"|([a-zA-Z0-9_.-]+))\s*=\s*(.+)$/);
    if (kvMatch && currentSection) {
      const key = kvMatch[1] ?? kvMatch[2]; // quoted key or bare key
      const rawValue = kvMatch[3].trim(); // capture group 3 is the value

      if (currentSection === 'settings') {
        result.settings[key] = parseTomlValue(rawValue);
      } else if ((currentSection === 'toolAllow' || currentSection === 'toolDeny') && currentToolName) {
        if (key === 'patterns') {
          const arr = parseTomlArray(rawValue);
          const target = currentSection === 'toolAllow'
            ? result.toolAllow[currentToolName]
            : result.toolDeny[currentToolName];
          if (target && arr) {
            target.push(...arr);
          }
        }
      }
    }
  }

  log.debug({ path: filePath, scope }, 'Settings parsed (lightweight parser)');
  return result;
}

/**
 * Extract settings from smol-toml parsed output.
 * Nested objects are flattened into dot-notation keys so that
 * `agent: { name: "x" }` becomes `settings["agent.name"] = "x"`.
 */
function extractSettingsFromParsed(parsed: Record<string, unknown>): SettingsFile {
  const result: SettingsFile = { settings: {}, toolAllow: {}, toolDeny: {} };

  if (isObject(parsed['settings'])) {
    const s = parsed['settings'] as Record<string, unknown>;
    for (const [k, v] of Object.entries(s)) {
      // Flatten nested objects into dot-notation keys
      if (isObject(v) && !Array.isArray(v)) {
        flattenToDotNotation(v as Record<string, unknown>, k, result.settings);
      } else {
        result.settings[k] = v;
      }
    }
  }

  if (isObject(parsed['toolAllow'])) {
    const ta = parsed['toolAllow'] as Record<string, unknown>;
    for (const [toolName, val] of Object.entries(ta)) {
      if (isObject(val)) {
        const entry = val as Record<string, unknown>;
        if (Array.isArray(entry['patterns'])) {
          result.toolAllow[toolName] = entry['patterns'] as string[];
        }
      }
    }
  }

  if (isObject(parsed['toolDeny'])) {
    const td = parsed['toolDeny'] as Record<string, unknown>;
    for (const [toolName, val] of Object.entries(td)) {
      if (isObject(val)) {
        const entry = val as Record<string, unknown>;
        if (Array.isArray(entry['patterns'])) {
          result.toolDeny[toolName] = entry['patterns'] as string[];
        }
      }
    }
  }

  return result;
}

/**
 * Serialize a SettingsFile to a simple TOML string.
 */
/**
 * Serialize a key for TOML output. Keys containing dots are quoted to
 * prevent TOML parsers from treating them as nested table paths.
 */
function serializeTomlKey(key: string): string {
  if (key.includes('.') || key.includes('-') || key.includes(' ')) {
    return `"${key}"`;
  }
  return key;
}

function serializeSettingsFile(file: SettingsFile): string {
  const lines: string[] = [];

  // [settings]
  if (Object.keys(file.settings).length > 0) {
    lines.push('[settings]');
    for (const [key, value] of Object.entries(file.settings)) {
      lines.push(`${serializeTomlKey(key)} = ${serializeTomlValue(value)}`);
    }
    lines.push('');
  }

  // [toolAllow.toolName]
  for (const [toolName, patterns] of Object.entries(file.toolAllow)) {
    if (patterns.length > 0) {
      lines.push(`[toolAllow.${toolName}]`);
      lines.push(`patterns = ${serializeTomlArray(patterns)}`);
      lines.push('');
    }
  }

  // [toolDeny.toolName]
  for (const [toolName, patterns] of Object.entries(file.toolDeny)) {
    if (patterns.length > 0) {
      lines.push(`[toolDeny.${toolName}]`);
      lines.push(`patterns = ${serializeTomlArray(patterns)}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// TOML value helpers
// ---------------------------------------------------------------------------

function parseTomlValue(raw: string): unknown {
  // String
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }

  // Boolean
  if (raw === 'true') return true;
  if (raw === 'false') return false;

  // Integer
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);

  // Float
  if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw);

  // Array
  if (raw.startsWith('[')) return parseTomlArray(raw);

  // Fallback: string
  return raw;
}

function parseTomlArray(raw: string): string[] | null {
  if (!raw.startsWith('[') || !raw.endsWith(']')) return null;

  const inner = raw.slice(1, -1).trim();
  if (inner === '') return [];

  return inner
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      // Strip quotes
      if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        return s.slice(1, -1);
      }
      return s;
    });
}

function serializeTomlValue(value: unknown): string {
  if (typeof value === 'string') return `"${value.replace(/"/g, '\\"')}"`;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return serializeTomlArray(value as string[]);
  return `"${String(value)}"`;
}

function serializeTomlArray(arr: string[]): string {
  const items = arr.map((s) => `"${s.replace(/"/g, '\\"')}"`);
  return `[${items.join(', ')}]`;
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateKey(key: string): void {
  if (!key || typeof key !== 'string') {
    throw new ConfigError('Setting key must be a non-empty string', 'config_invalid_key');
  }
}

function matchesAnyPattern(action: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern === action) return true;

    // Wildcard support: "shell:*" matches "shell:rm", "shell:delete", etc.
    if (pattern.endsWith(':*')) {
      const prefix = pattern.slice(0, -1); // e.g. "shell:"
      return action.startsWith(prefix);
    }

    // Glob-style wildcard: "read*" matches "readFile", "readDir", etc.
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      return action.startsWith(prefix);
    }

    return false;
  });
}

/**
 * Recursively flatten a nested object into dot-notation keys.
 * e.g. { name: "x", nested: { deep: "y" } } with prefix "agent"
 *      → { "agent.name": "x", "agent.nested.deep": "y" }
 */
function flattenToDotNotation(
  obj: Record<string, unknown>,
  prefix: string,
  target: Record<string, unknown>,
): void {
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = `${prefix}.${k}`;
    if (isObject(v) && !Array.isArray(v)) {
      flattenToDotNotation(v as Record<string, unknown>, fullKey, target);
    } else {
      target[fullKey] = v;
    }
  }
}

function mergeToolRules(
  projectRules: Record<string, string[]>,
  localRules: Record<string, string[]>,
): Record<string, string[]> {
  const merged: Record<string, string[]> = {};

  for (const [tool, patterns] of Object.entries(projectRules)) {
    merged[tool] = [...patterns];
  }

  for (const [tool, patterns] of Object.entries(localRules)) {
    if (!merged[tool]) {
      merged[tool] = [];
    }
    // Append local patterns, deduplicating
    for (const p of patterns) {
      if (!merged[tool].includes(p)) {
        merged[tool].push(p);
      }
    }
  }

  return merged;
}