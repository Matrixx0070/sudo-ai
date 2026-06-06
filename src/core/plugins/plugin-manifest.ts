/**
 * @file plugin-manifest.ts
 * @description Plugin manifest types and validation for SUDO-AI v4.
 *
 * Every plugin ships a manifest.json that declares its identity, capabilities,
 * hooks, skills, MCP/LSP servers, and source provenance. This module defines
 * the canonical types and a runtime validator.
 *
 * The manifest is the single source of truth for:
 *   1. Plugin identity (name, version, author, category)
 *   2. Extension points (hooks, skills, mcpServers, lspServers)
 *   3. Provenance (local / url / github / marketplace)
 *   4. Dependencies (other plugins this plugin requires)
 */

import { createLogger } from '../shared/logger.js';
import { contentHash } from '../shared/utils.js';

const log = createLogger('plugin:manifest');

// ---------------------------------------------------------------------------
// Plugin category
// ---------------------------------------------------------------------------

/**
 * Functional categories a plugin may belong to.
 * Used for marketplace filtering and organisation.
 */
export type PluginCategory =
  | 'development'
  | 'productivity'
  | 'database'
  | 'security'
  | 'monitoring'
  | 'testing'
  | 'design'
  | 'communication'
  | 'math'
  | 'learning';

/** All valid plugin categories. */
export const PLUGIN_CATEGORIES: readonly PluginCategory[] = [
  'development',
  'productivity',
  'database',
  'security',
  'monitoring',
  'testing',
  'design',
  'communication',
  'math',
  'learning',
] as const;

// ---------------------------------------------------------------------------
// Plugin state
// ---------------------------------------------------------------------------

/**
 * Lifecycle states a plugin may be in.
 *
 * Transitions:
 *   uninstalled -> installed -> enabled -> disabled -> uninstalled
 *   any        -> error (on failure)
 */
export enum PluginState {
  Uninstalled = 'uninstalled',
  Installed = 'installed',
  Enabled = 'enabled',
  Disabled = 'disabled',
  Error = 'error',
}

// ---------------------------------------------------------------------------
// Plugin source
// ---------------------------------------------------------------------------

/**
 * Where a plugin was loaded from.
 * - local:  filesystem path (e.g. .sudo-ai/plugins/)
 * - url:    direct HTTP(S) download
 * - github: GitHub repo (owner/repo[@ref])
 * - marketplace: SUDO-AI plugin marketplace
 */
export type PluginSource = 'local' | 'url' | 'github' | 'marketplace';

/** Provenance metadata for a plugin source. */
export interface PluginSourceInfo {
  type: PluginSource;
  /** For 'local': absolute filesystem path. */
  path?: string;
  /** For 'url': the download URL. */
  url?: string;
  /** For 'github': 'owner/repo' or 'owner/repo@ref'. */
  repo?: string;
  /** For 'marketplace': marketplace listing ID. */
  marketplaceId?: string;
  /** SHA-256 of the source archive (integrity check). */
  integrity?: string;
}

// ---------------------------------------------------------------------------
// Plugin hook definition (manifest-level)
// ---------------------------------------------------------------------------

/**
 * A hook declared in the plugin manifest.
 * The PluginHooks bridge maps these onto the HookEngine at runtime.
 */
export interface PluginHookDecl {
  /** Hook event name (e.g. 'PreToolCall', 'after:tool-call'). */
  event: string;
  /** Hook type — command, http, or function. */
  type: 'command' | 'http' | 'function';
  /** For 'command': shell command string. */
  command?: string;
  /** For 'http': webhook URL. */
  url?: string;
  /** For 'function': name of an exported function from the plugin entry point. */
  functionName?: string;
  /** Execution timeout in milliseconds (default 30 000). */
  timeout?: number;
  /** Whether this hook is enabled by default. */
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Plugin skill definition (manifest-level)
// ---------------------------------------------------------------------------

/**
 * A skill declared in the plugin manifest.
 */
export interface PluginSkillDecl {
  /** Unique skill identifier within the plugin namespace. */
  id: string;
  /** Human-readable skill name. */
  name: string;
  /** Short description. */
  description: string;
  /** Skill category (maps to PluginCategory or free-form). */
  category?: string;
  /** Tags for search / filtering. */
  tags?: string[];
}

// ---------------------------------------------------------------------------
// MCP server definition (manifest-level)
// ---------------------------------------------------------------------------

/**
 * An MCP server declared in the plugin manifest.
 */
export interface PluginMcpServerDecl {
  /** Server identifier. */
  id: string;
  /** Command to start the MCP server. */
  command: string;
  /** Arguments passed to the command. */
  args?: string[];
  /** Environment variables for the server process. */
  env?: Record<string, string>;
  /** Working directory for the server process. */
  cwd?: string;
}

// ---------------------------------------------------------------------------
// LSP server definition (manifest-level)
// ---------------------------------------------------------------------------

/**
 * An LSP server declared in the plugin manifest.
 */
export interface PluginLspServerDecl {
  /** Server identifier. */
  id: string;
  /** Command to start the LSP server. */
  command: string;
  /** Arguments passed to the command. */
  args?: string[];
  /** Language IDs this server handles (e.g. ['typescript', 'javascript']). */
  languages: string[];
}

// ---------------------------------------------------------------------------
// Plugin manifest
// ---------------------------------------------------------------------------

/**
 * Schema of the manifest.json that every plugin must ship.
 * Extends the base PluginManifest with hooks, skills, MCP/LSP servers,
 * category, source provenance, and dependencies.
 */
export interface PluginManifest {
  /** Globally unique reverse-DNS plugin identifier, e.g. "ai.sudo.plugin.youtube". */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Semantic version string, e.g. "1.0.0". Must match /^\d+\.\d+\.\d+$/. */
  version: string;
  /** Short description shown in plugin listings. */
  description: string;
  /** Author string or email. */
  author: string;
  /** Plugin category for marketplace filtering. */
  category: PluginCategory;
  /** Hooks declared by this plugin. */
  hooks: PluginHookDecl[];
  /** Skills declared by this plugin. */
  skills: PluginSkillDecl[];
  /** MCP servers declared by this plugin. */
  mcpServers: PluginMcpServerDecl[];
  /** LSP servers declared by this plugin. */
  lspServers: PluginLspServerDecl[];
  /** Source provenance. */
  source: PluginSourceInfo;
  /** Plugin IDs this plugin depends on. */
  dependencies?: string[];
  /** Path to the ES-module entry point, relative to plugin root. */
  entryPoint?: string;
  /** Declared configuration keys the plugin reads. */
  config?: Record<
    string,
    {
      type: string;
      description: string;
      required?: boolean;
      default?: unknown;
    }
  >;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Semver-ish pattern: major.minor.patch */
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** Required top-level string fields in a manifest. */
const REQUIRED_STRING_FIELDS: ReadonlyArray<{ field: keyof PluginManifest; label: string }> = [
  { field: 'id', label: 'manifest.id' },
  { field: 'name', label: 'manifest.name' },
  { field: 'version', label: 'manifest.version' },
  { field: 'description', label: 'manifest.description' },
  { field: 'author', label: 'manifest.author' },
];

/**
 * Result of manifest validation.
 */
export interface ManifestValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  /** SHA-256 content hash of the raw manifest JSON. */
  hash: string;
}

/**
 * Validate a raw parsed manifest object.
 *
 * Checks:
 *  1. Required fields present and non-empty
 *  2. Version matches semver pattern
 *  3. Category is a known PluginCategory
 *  4. Source info has a valid type
 *  5. Hook declarations have required fields per type
 *  6. MCP / LSP server declarations have required fields
 *  7. Dependency IDs are non-empty strings
 *
 * @param raw - Parsed JSON object (type unknown).
 * @returns Validation result with errors/warnings and content hash.
 */
export function validateManifest(raw: unknown): ManifestValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const hash = contentHash(JSON.stringify(raw));

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('manifest.json must be a JSON object');
    return { valid: false, errors, warnings, hash };
  }

  const obj = raw as Record<string, unknown>;

  // -- Required string fields ------------------------------------------------
  for (const { field, label } of REQUIRED_STRING_FIELDS) {
    const value = obj[field];
    if (value === undefined || value === null) {
      errors.push(`${label} is required`);
    } else if (typeof value !== 'string' || (value as string).trim() === '') {
      errors.push(`${label} must be a non-empty string`);
    }
  }

  // -- Version format ---------------------------------------------------------
  if (typeof obj['version'] === 'string' && !VERSION_RE.test(obj['version'])) {
    errors.push(`manifest.version must match semver pattern (e.g. "1.0.0"), got: "${obj['version']}"`);
  }

  // -- Category ---------------------------------------------------------------
  if (obj['category'] !== undefined) {
    if (typeof obj['category'] !== 'string') {
      errors.push('manifest.category must be a string');
    } else if (!PLUGIN_CATEGORIES.includes(obj['category'] as PluginCategory)) {
      warnings.push(
        `manifest.category "${obj['category']}" is not a recognised PluginCategory. ` +
          `Expected one of: ${PLUGIN_CATEGORIES.join(', ')}`,
      );
    }
  } else {
    errors.push('manifest.category is required');
  }

  // -- Source -----------------------------------------------------------------
  if (obj['source'] === undefined || obj['source'] === null) {
    errors.push('manifest.source is required');
  } else if (typeof obj['source'] === 'object' && !Array.isArray(obj['source'])) {
    const src = obj['source'] as Record<string, unknown>;
    if (!src['type'] || typeof src['type'] !== 'string') {
      errors.push('manifest.source.type must be a non-empty string');
    } else if (!['local', 'url', 'github', 'marketplace'].includes(src['type'] as string)) {
      errors.push(`manifest.source.type must be one of: local, url, github, marketplace. Got: "${src['type']}"`);
    }
  } else {
    errors.push('manifest.source must be an object with a "type" field');
  }

  // -- Hooks ------------------------------------------------------------------
  if (obj['hooks'] !== undefined) {
    if (!Array.isArray(obj['hooks'])) {
      errors.push('manifest.hooks must be an array');
    } else {
      for (let i = 0; i < obj['hooks'].length; i++) {
        const hook = obj['hooks'][i] as Record<string, unknown> | null;
        if (!hook || typeof hook !== 'object') {
          errors.push(`manifest.hooks[${i}] must be an object`);
          continue;
        }
        if (!hook['event'] || typeof hook['event'] !== 'string') {
          errors.push(`manifest.hooks[${i}].event must be a non-empty string`);
        }
        if (!hook['type'] || !['command', 'http', 'function'].includes(hook['type'] as string)) {
          errors.push(`manifest.hooks[${i}].type must be one of: command, http, function`);
        }
        // Validate type-specific fields
        if (hook['type'] === 'command' && (!hook['command'] || typeof hook['command'] !== 'string')) {
          errors.push(`manifest.hooks[${i}].command is required for command hooks`);
        }
        if (hook['type'] === 'http' && (!hook['url'] || typeof hook['url'] !== 'string')) {
          errors.push(`manifest.hooks[${i}].url is required for http hooks`);
        }
        if (hook['type'] === 'function' && (!hook['functionName'] || typeof hook['functionName'] !== 'string')) {
          errors.push(`manifest.hooks[${i}].functionName is required for function hooks`);
        }
      }
    }
  } else {
    warnings.push('manifest.hooks is missing — plugin will not register any hooks');
  }

  // -- Skills -----------------------------------------------------------------
  if (obj['skills'] !== undefined && !Array.isArray(obj['skills'])) {
    errors.push('manifest.skills must be an array');
  }

  // -- MCP servers ------------------------------------------------------------
  if (obj['mcpServers'] !== undefined) {
    if (!Array.isArray(obj['mcpServers'])) {
      errors.push('manifest.mcpServers must be an array');
    } else {
      for (let i = 0; i < obj['mcpServers'].length; i++) {
        const mcp = obj['mcpServers'][i] as Record<string, unknown> | null;
        if (!mcp || typeof mcp !== 'object') {
          errors.push(`manifest.mcpServers[${i}] must be an object`);
          continue;
        }
        if (!mcp['id'] || typeof mcp['id'] !== 'string') {
          errors.push(`manifest.mcpServers[${i}].id must be a non-empty string`);
        }
        if (!mcp['command'] || typeof mcp['command'] !== 'string') {
          errors.push(`manifest.mcpServers[${i}].command must be a non-empty string`);
        }
      }
    }
  }

  // -- LSP servers ------------------------------------------------------------
  if (obj['lspServers'] !== undefined) {
    if (!Array.isArray(obj['lspServers'])) {
      errors.push('manifest.lspServers must be an array');
    } else {
      for (let i = 0; i < obj['lspServers'].length; i++) {
        const lsp = obj['lspServers'][i] as Record<string, unknown> | null;
        if (!lsp || typeof lsp !== 'object') {
          errors.push(`manifest.lspServers[${i}] must be an object`);
          continue;
        }
        if (!lsp['id'] || typeof lsp['id'] !== 'string') {
          errors.push(`manifest.lspServers[${i}].id must be a non-empty string`);
        }
        if (!lsp['command'] || typeof lsp['command'] !== 'string') {
          errors.push(`manifest.lspServers[${i}].command must be a non-empty string`);
        }
        if (!Array.isArray(lsp['languages']) || (lsp['languages'] as unknown[]).length === 0) {
          errors.push(`manifest.lspServers[${i}].languages must be a non-empty array`);
        }
      }
    }
  }

  // -- Dependencies -----------------------------------------------------------
  if (obj['dependencies'] !== undefined) {
    if (!Array.isArray(obj['dependencies'])) {
      errors.push('manifest.dependencies must be an array');
    } else {
      for (let i = 0; i < obj['dependencies'].length; i++) {
        if (typeof obj['dependencies'][i] !== 'string' || (obj['dependencies'][i] as string).trim() === '') {
          errors.push(`manifest.dependencies[${i}] must be a non-empty string`);
        }
      }
    }
  }

  const valid = errors.length === 0;

  if (valid) {
    log.debug({ id: obj['id'], version: obj['version'], hash }, 'Manifest validated successfully');
  } else {
    log.warn({ id: obj['id'], errorCount: errors.length, warningCount: warnings.length }, 'Manifest validation failed');
  }

  return { valid, errors, warnings, hash };
}