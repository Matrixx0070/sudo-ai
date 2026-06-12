/**
 * PluginLoader — discovers and dynamically imports SUDO-AI plugins.
 *
 * Responsibilities:
 *  - Scan a directory for plugin sub-directories containing manifest.json
 *  - Read and validate each manifest against required fields and version format
 *  - Dynamically import the plugin's entry-point ES module
 *  - Return a fully-typed PluginModule or throw a descriptive SudoError
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import { SudoError } from '../shared/errors.js';
import type { PluginManifest, PluginModule } from './types.js';

const log = createLogger('plugin:loader');

/** Semver-ish pattern: major.minor.patch */
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** Required top-level fields in a manifest.json. */
const REQUIRED_MANIFEST_FIELDS: ReadonlyArray<keyof PluginManifest> = [
  'id',
  'name',
  'version',
  'description',
  'entryPoint',
  'capabilities',
];

// ---------------------------------------------------------------------------
// PluginLoader
// ---------------------------------------------------------------------------

/**
 * Stateless helper that locates, validates, and imports plugin packages.
 * No mutable state is held — the PluginManager owns the registry.
 */
export class PluginLoader {
  /**
   * Scan `dir` for immediate sub-directories that contain a `manifest.json`.
   *
   * @param dir - Absolute path to the plugin root directory.
   * @returns Array of absolute plugin directory paths.
   */
  async scanDirectory(dir: string): Promise<string[]> {
    if (!dir || typeof dir !== 'string') {
      throw new SudoError(
        'scanDirectory: dir must be a non-empty string',
        'plugin_invalid_argument',
        { dir },
      );
    }

    log.info({ dir }, 'Scanning plugin directory');

    let entries: string[];
    try {
      const dirents = await readdir(dir, { withFileTypes: true });
      entries = dirents
        .filter((d) => d.isDirectory())
        .map((d) => path.join(dir, d.name));
    } catch (err) {
      throw new SudoError(
        `Cannot read plugin directory: ${String(err)}`,
        'plugin_scan_failed',
        { dir, cause: String(err) },
      );
    }

    const pluginDirs: string[] = [];
    for (const entry of entries) {
      const manifestPath = path.join(entry, 'manifest.json');
      try {
        await readFile(manifestPath, 'utf8');
        pluginDirs.push(entry);
        log.debug({ pluginDir: entry }, 'Found plugin directory');
      } catch {
        // No manifest.json — skip silently.
      }
    }

    log.info({ dir, found: pluginDirs.length }, 'Scan complete');
    return pluginDirs;
  }

  /**
   * Load a single plugin from `pluginPath`.
   *
   * Steps:
   *  1. Read and parse manifest.json
   *  2. Validate manifest fields
   *  3. Dynamically import the entry-point module
   *  4. Verify the module exports a conforming PluginModule
   *
   * @param pluginPath - Absolute path to the plugin root directory.
   * @returns Resolved PluginModule.
   * @throws SudoError with code `plugin_*` on any failure.
   */
  async loadPlugin(pluginPath: string): Promise<PluginModule> {
    if (!pluginPath || typeof pluginPath !== 'string') {
      throw new SudoError(
        'loadPlugin: pluginPath must be a non-empty string',
        'plugin_invalid_argument',
        { pluginPath },
      );
    }

    log.info({ pluginPath }, 'Loading plugin');

    // -- 1. Read manifest ---------------------------------------------------
    const manifestPath = path.join(pluginPath, 'manifest.json');
    let rawManifest: string;
    try {
      rawManifest = await readFile(manifestPath, 'utf8');
    } catch (err) {
      throw new SudoError(
        `Cannot read manifest.json at ${manifestPath}: ${String(err)}`,
        'plugin_manifest_not_found',
        { pluginPath, manifestPath, cause: String(err) },
      );
    }

    // -- 2. Parse manifest --------------------------------------------------
    let manifest: unknown;
    try {
      manifest = JSON.parse(rawManifest);
    } catch (err) {
      throw new SudoError(
        `Invalid JSON in manifest.json at ${manifestPath}: ${String(err)}`,
        'plugin_manifest_parse_error',
        { manifestPath, cause: String(err) },
      );
    }

    // -- 3. Validate manifest -----------------------------------------------
    const validated = this.validateManifest(manifest);
    log.debug({ id: validated.id, version: validated.version }, 'Manifest validated');

    // -- 4. Resolve entry point ---------------------------------------------
    const entryPointPath = path.resolve(pluginPath, validated.entryPoint);
    log.debug({ entryPointPath }, 'Importing plugin entry point');

    let mod: unknown;
    try {
      mod = await import(entryPointPath);
    } catch (err) {
      throw new SudoError(
        `Failed to import plugin entry point ${entryPointPath}: ${String(err)}`,
        'plugin_import_failed',
        { id: validated.id, entryPointPath, cause: String(err) },
      );
    }

    // -- 5. Validate module shape -------------------------------------------
    const pluginModule = this.extractModule(mod, validated);
    log.info({ id: validated.id, version: validated.version }, 'Plugin loaded successfully');
    return pluginModule;
  }

  // ---------------------------------------------------------------------------
  // Validation helpers
  // ---------------------------------------------------------------------------

  /**
   * Validate raw parsed manifest data.
   *
   * @param raw - Unknown parsed JSON value.
   * @returns Typed and validated PluginManifest.
   * @throws SudoError with code `plugin_manifest_invalid` on validation failure.
   */
  validateManifest(raw: unknown): PluginManifest {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new SudoError(
        'manifest.json must be a JSON object',
        'plugin_manifest_invalid',
        { received: typeof raw },
      );
    }

    const obj = raw as Record<string, unknown>;

    for (const field of REQUIRED_MANIFEST_FIELDS) {
      if (obj[field] === undefined || obj[field] === null) {
        throw new SudoError(
          `manifest.json is missing required field: "${field}"`,
          'plugin_manifest_invalid',
          { missingField: field },
        );
      }
    }

    if (typeof obj['id'] !== 'string' || obj['id'].trim() === '') {
      throw new SudoError('manifest.id must be a non-empty string', 'plugin_manifest_invalid', { field: 'id' });
    }

    if (typeof obj['name'] !== 'string' || obj['name'].trim() === '') {
      throw new SudoError('manifest.name must be a non-empty string', 'plugin_manifest_invalid', { field: 'name' });
    }

    if (typeof obj['version'] !== 'string' || !VERSION_RE.test(obj['version'])) {
      throw new SudoError(
        `manifest.version must match semver pattern (e.g. "1.0.0"), got: "${String(obj['version'])}"`,
        'plugin_manifest_invalid',
        { field: 'version', value: obj['version'] },
      );
    }

    if (!Array.isArray(obj['capabilities']) || obj['capabilities'].length === 0) {
      throw new SudoError(
        'manifest.capabilities must be a non-empty array',
        'plugin_manifest_invalid',
        { field: 'capabilities' },
      );
    }

    return obj as unknown as PluginManifest;
  }

  /**
   * Extract and verify the PluginModule from a dynamic import result.
   *
   * Supports both default exports and named exports named `plugin`.
   */
  private extractModule(mod: unknown, manifest: PluginManifest): PluginModule {
    const candidates = [
      (mod as Record<string, unknown>)['default'],
      (mod as Record<string, unknown>)['plugin'],
      mod,
    ];

    for (const candidate of candidates) {
      if (candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)) {
        const obj = candidate as Record<string, unknown>;
        if (typeof obj['activate'] === 'function') {
          // Ensure manifest is attached (module may omit it).
          if (!obj['manifest']) {
            obj['manifest'] = manifest;
          }
          return obj as unknown as PluginModule;
        }
      }
    }

    throw new SudoError(
      `Plugin entry point does not export a valid PluginModule (missing "activate" function). ` +
        `Expected a default export or "plugin" named export with activate().`,
      'plugin_invalid_module',
      { id: manifest.id },
    );
  }
}
