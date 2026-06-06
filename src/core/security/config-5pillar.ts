/**
 * @file security/config-5pillar.ts
 * @description Config5Pillar — TOML overlay for the 5 security/operational pillars.
 *
 * The five pillars are:
 *   1. permissions  — allowed/denied capabilities, approval requirements
 *   2. memory       — storage backend, TTL, capacity limits
 *   3. tools        — enabled/disabled tool lists, MCP server references
 *   4. hooks        — lifecycle hook registrations (before/after tool call, etc.)
 *   5. plugins      — plugin registry, auto-update, enablement
 *
 * Each pillar can be loaded from a TOML file, merged additively with defaults,
 * and validated against a schema. The merge is deep-merge: arrays are unioned,
 * scalars from the overlay replace defaults.
 *
 * @module security/config-5pillar
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import { genId, contentHash } from '../shared/utils.js';

const log = createLogger('security:config-5pillar');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Permissions pillar: capability allow/deny/approval policy. */
export interface PermissionsPillar {
  allowed?: string[];
  denied?: string[];
  requireApproval?: string[];
}

/** Memory pillar: storage backend and capacity configuration. */
export interface MemoryPillar {
  maxEntries?: number;
  ttlSeconds?: number;
  backend?: 'sqlite' | 'file' | 'redis';
}

/** Tools pillar: tool enablement and MCP server configuration. */
export interface ToolsPillar {
  enabled?: string[];
  disabled?: string[];
  mcpServers?: string[];
}

/** Hooks pillar: lifecycle hook registration lists. */
export interface HooksPillar {
  beforeToolCall?: string[];
  afterToolCall?: string[];
  beforeLLMCall?: string[];
  afterLLMCall?: string[];
  onSessionStart?: string[];
  onSessionEnd?: string[];
}

/** Plugins pillar: plugin management and registry configuration. */
export interface PluginsPillar {
  enabled?: string[];
  registry?: string;
  autoUpdate?: boolean;
}

/** Single pillar configuration (union of all pillar shapes). */
export type PillarConfig =
  | PermissionsPillar
  | MemoryPillar
  | ToolsPillar
  | HooksPillar
  | PluginsPillar;

/** Complete 5-pillar configuration with all pillars present. */
export interface FivePillarConfig {
  permissions: PermissionsPillar;
  memory: MemoryPillar;
  tools: ToolsPillar;
  hooks: HooksPillar;
  plugins: PluginsPillar;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: FivePillarConfig = {
  permissions: {
    allowed: ['fs.read', 'net.fetch'],
    denied: [],
    requireApproval: ['shell.exec', 'fs.write'],
  },
  memory: {
    maxEntries: 10000,
    ttlSeconds: 86400,
    backend: 'sqlite',
  },
  tools: {
    enabled: [],
    disabled: [],
    mcpServers: [],
  },
  hooks: {
    beforeToolCall: [],
    afterToolCall: [],
    beforeLLMCall: [],
    afterLLMCall: [],
    onSessionStart: [],
    onSessionEnd: [],
  },
  plugins: {
    enabled: [],
    registry: 'https://agentskills.io',
    autoUpdate: false,
  },
};

// ---------------------------------------------------------------------------
// TOML parser (minimal — handles the 5-pillar subset)
// ---------------------------------------------------------------------------

/**
 * Minimal TOML parser that supports the subset needed for 5-pillar config:
 *   - Sections: [permissions], [memory], [tools], [hooks], [plugins]
 *   - String values: key = "value"
 *   - Integer values: key = 42
 *   - Boolean values: key = true / key = false
 *   - Arrays of strings: key = ["a", "b"]
 *
 * Does NOT support: nested tables, inline tables, multiline strings,
 * datetime values, float values, arrays of non-strings.
 */
function parseToml(text: string): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  let currentSection: string | null = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    // Section header: [name]
    const sectionMatch = line.match(/^\[([a-zA-Z_][a-zA-Z0-9_]*)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      if (!result[currentSection]) result[currentSection] = {};
      continue;
    }

    if (!currentSection) continue;
    if (!result[currentSection]) result[currentSection] = {};

    // Key = value
    const kvMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/);
    if (!kvMatch) continue;

    const key = kvMatch[1];
    const rawValue = kvMatch[2].trim();

    result[currentSection][key] = parseTomlValue(rawValue);
  }

  return result;
}

function parseTomlValue(raw: string): unknown {
  // Boolean
  if (raw === 'true') return true;
  if (raw === 'false') return false;

  // Integer
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);

  // Quoted string
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }

  // Array of strings: ["a", "b"]
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (inner.length === 0) return [];

    const items: string[] = [];
    for (const item of inner.split(',')) {
      const trimmed = item.trim();
      if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        items.push(trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
      }
    }
    return items;
  }

  // Bare string (fallback)
  return raw;
}

// ---------------------------------------------------------------------------
// Deep merge helper
// ---------------------------------------------------------------------------

function mergeArrays(a: string[] | undefined, b: string[] | undefined): string[] {
  const set = new Set([...(a ?? []), ...(b ?? [])]);
  return [...set];
}

function mergePillarPartial<T extends object>(
  base: T,
  overlay: Partial<T>,
): T {
  const merged = { ...base } as Record<string, unknown>;

  for (const [key, overlayVal] of Object.entries(overlay)) {
    const baseVal = (base as Record<string, unknown>)[key];

    if (Array.isArray(baseVal) && Array.isArray(overlayVal)) {
      // Arrays are unioned (additive merge).
      (merged as Record<string, unknown>)[key] = mergeArrays(
        baseVal as string[],
        overlayVal as string[],
      );
    } else if (overlayVal !== undefined) {
      // Scalars: overlay wins.
      (merged as Record<string, unknown>)[key] = overlayVal;
    }
  }

  return merged as T;
}

// ---------------------------------------------------------------------------
// Config5Pillar class
// ---------------------------------------------------------------------------

/**
 * Loads, merges, and validates the 5-pillar TOML overlay configuration.
 *
 * Usage:
 *   const cfg = new Config5Pillar();
 *   cfg.loadPillarConfig('/path/to/sudo-5pillar.toml');
 *   const full = cfg.getConfig();  // merged with defaults
 */
export class Config5Pillar {
  private _config: FivePillarConfig;
  private _overlays: string[] = [];

  constructor(base?: Partial<FivePillarConfig>) {
    this._config = this._cloneDefaults();
    if (base) {
      this.mergePillarConfig(base);
    }
    log.info('Config5Pillar initialized');
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  /**
   * Load a 5-pillar TOML configuration file and merge it into the current config.
   *
   * @param tomlPath - Path to the TOML configuration file.
   * @throws Error if the file cannot be read or parsed.
   */
  loadPillarConfig(tomlPath: string): void {
    if (!tomlPath || typeof tomlPath !== 'string') {
      throw new TypeError('Config5Pillar.loadPillarConfig: tomlPath must be a non-empty string');
    }

    const raw = fs.readFileSync(tomlPath, 'utf8');
    const parsed = parseToml(raw);

    log.info({ path: tomlPath, sections: Object.keys(parsed) }, 'Loading 5-pillar TOML config');

    const partial: Partial<FivePillarConfig> = {};

    if (parsed['permissions']) {
      partial.permissions = this._coercePermissions(parsed['permissions']);
    }
    if (parsed['memory']) {
      partial.memory = this._coerceMemory(parsed['memory']);
    }
    if (parsed['tools']) {
      partial.tools = this._coerceTools(parsed['tools']);
    }
    if (parsed['hooks']) {
      partial.hooks = this._coerceHooks(parsed['hooks']);
    }
    if (parsed['plugins']) {
      partial.plugins = this._coercePlugins(parsed['plugins']);
    }

    this.mergePillarConfig(partial);
    this._overlays.push(tomlPath);
  }

  // -------------------------------------------------------------------------
  // Merging
  // -------------------------------------------------------------------------

  /**
   * Merge a partial config into the current 5-pillar configuration.
   *
   * Merge rules:
   *   - Arrays: unioned (additive, deduplicated).
   *   - Scalars: overlay value replaces base value.
   *   - Missing keys: left unchanged.
   *
   * @param overlay - Partial config to merge on top of the current config.
   */
  mergePillarConfig(overlay: Partial<FivePillarConfig>): void {
    if (overlay.permissions) {
      this._config.permissions = mergePillarPartial(this._config.permissions, overlay.permissions);
    }
    if (overlay.memory) {
      this._config.memory = mergePillarPartial(this._config.memory, overlay.memory);
    }
    if (overlay.tools) {
      this._config.tools = mergePillarPartial(this._config.tools, overlay.tools);
    }
    if (overlay.hooks) {
      this._config.hooks = mergePillarPartial(this._config.hooks, overlay.hooks);
    }
    if (overlay.plugins) {
      this._config.plugins = mergePillarPartial(this._config.plugins, overlay.plugins);
    }

    log.debug({ overlayKeys: Object.keys(overlay) }, 'Pillar config merged');
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  /**
   * Validate the current 5-pillar configuration.
   *
   * Checks for:
   *   - No capability appears in both 'allowed' and 'denied'.
   *   - Memory TTL and maxEntries are positive integers.
   *   - Plugin registry is a valid URL when present.
   *   - No tool appears in both 'enabled' and 'disabled'.
   *
   * @returns Array of validation error strings. Empty if valid.
   */
  validatePillarConfig(): string[] {
    const errors: string[] = [];
    const c = this._config;

    // Permissions: no overlap between allowed and denied.
    const allowedSet = new Set(c.permissions.allowed ?? []);
    const deniedSet = new Set(c.permissions.denied ?? []);
    for (const cap of allowedSet) {
      if (deniedSet.has(cap)) {
        errors.push(`permissions: "${cap}" appears in both allowed and denied`);
      }
    }

    // Memory: positive integers.
    if (c.memory.maxEntries !== undefined && c.memory.maxEntries < 0) {
      errors.push('memory: maxEntries must be >= 0');
    }
    if (c.memory.ttlSeconds !== undefined && c.memory.ttlSeconds < 0) {
      errors.push('memory: ttlSeconds must be >= 0');
    }
    if (c.memory.backend && !['sqlite', 'file', 'redis'].includes(c.memory.backend)) {
      errors.push(`memory: invalid backend "${c.memory.backend}" (expected sqlite|file|redis)`);
    }

    // Tools: no overlap between enabled and disabled.
    const enabledSet = new Set(c.tools.enabled ?? []);
    const disabledSet = new Set(c.tools.disabled ?? []);
    for (const tool of enabledSet) {
      if (disabledSet.has(tool)) {
        errors.push(`tools: "${tool}" appears in both enabled and disabled`);
      }
    }

    // Plugins: registry URL format.
    if (c.plugins.registry && !/^https?:\/\//.test(c.plugins.registry)) {
      errors.push(`plugins: registry "${c.plugins.registry}" is not a valid URL`);
    }

    if (errors.length > 0) {
      log.warn({ errors }, 'Pillar config validation failed');
    } else {
      log.debug('Pillar config validation passed');
    }

    return errors;
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  /** Get a deep copy of the current merged 5-pillar configuration. */
  getConfig(): FivePillarConfig {
    return JSON.parse(JSON.stringify(this._config));
  }

  /** Get the list of TOML file paths that have been loaded. */
  get loadedOverlays(): string[] {
    return [...this._overlays];
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _cloneDefaults(): FivePillarConfig {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }

  private _coercePermissions(raw: Record<string, unknown>): PermissionsPillar {
    const result: PermissionsPillar = {};
    if (Array.isArray(raw['allowed'])) result.allowed = raw['allowed'] as string[];
    if (Array.isArray(raw['denied'])) result.denied = raw['denied'] as string[];
    if (Array.isArray(raw['requireApproval'])) result.requireApproval = raw['requireApproval'] as string[];
    return result;
  }

  private _coerceMemory(raw: Record<string, unknown>): MemoryPillar {
    const result: MemoryPillar = {};
    if (typeof raw['maxEntries'] === 'number') result.maxEntries = raw['maxEntries'];
    if (typeof raw['ttlSeconds'] === 'number') result.ttlSeconds = raw['ttlSeconds'];
    if (typeof raw['backend'] === 'string') result.backend = raw['backend'] as MemoryPillar['backend'];
    return result;
  }

  private _coerceTools(raw: Record<string, unknown>): ToolsPillar {
    const result: ToolsPillar = {};
    if (Array.isArray(raw['enabled'])) result.enabled = raw['enabled'] as string[];
    if (Array.isArray(raw['disabled'])) result.disabled = raw['disabled'] as string[];
    if (Array.isArray(raw['mcpServers'])) result.mcpServers = raw['mcpServers'] as string[];
    return result;
  }

  private _coerceHooks(raw: Record<string, unknown>): HooksPillar {
    const result: HooksPillar = {};
    if (Array.isArray(raw['beforeToolCall'])) result.beforeToolCall = raw['beforeToolCall'] as string[];
    if (Array.isArray(raw['afterToolCall'])) result.afterToolCall = raw['afterToolCall'] as string[];
    if (Array.isArray(raw['beforeLLMCall'])) result.beforeLLMCall = raw['beforeLLMCall'] as string[];
    if (Array.isArray(raw['afterLLMCall'])) result.afterLLMCall = raw['afterLLMCall'] as string[];
    if (Array.isArray(raw['onSessionStart'])) result.onSessionStart = raw['onSessionStart'] as string[];
    if (Array.isArray(raw['onSessionEnd'])) result.onSessionEnd = raw['onSessionEnd'] as string[];
    return result;
  }

  private _coercePlugins(raw: Record<string, unknown>): PluginsPillar {
    const result: PluginsPillar = {};
    if (Array.isArray(raw['enabled'])) result.enabled = raw['enabled'] as string[];
    if (typeof raw['registry'] === 'string') result.registry = raw['registry'];
    if (typeof raw['autoUpdate'] === 'boolean') result.autoUpdate = raw['autoUpdate'];
    return result;
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** Default singleton Config5Pillar instance. */
export const config5Pillar = new Config5Pillar();