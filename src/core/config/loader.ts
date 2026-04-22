/**
 * ConfigLoader — loads, validates, and hot-reloads sudo-ai.json5.
 *
 * Lifecycle:
 *   const cfg = new ConfigLoader();
 *   await cfg.load();          // Must be called before get()
 *   cfg.onReload(newCfg => {}); // Optional hot-reload callback
 *   cfg.close();               // Stop file watcher
 *
 * Wave 10 addition: loadConfig5Pillar() — loads TOML overlay (sudo-ai.toml)
 * and returns a Config5Pillar object. Missing file returns empty {}.
 * Merge order: JSON5 base → TOML overlay → env vars (env wins).
 */

import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import JSON5 from 'json5';
import { config as loadDotenv } from 'dotenv';
import { Value } from '@sinclair/typebox/value';
import { createLogger } from '../shared/logger.js';
import { ConfigError } from '../shared/errors.js';
import { PATHS, CONFIG_RELOAD_DEBOUNCE_MS } from '../shared/constants.js';
import { debounce } from '../shared/utils.js';
import { SudoConfigSchema } from './schema.js';
import type { SudoConfig } from './types.js';
import type { Config5Pillar } from '../shared/wave10-types.js';

const log = createLogger('config');

// Default TOML overlay path (relative to project root)
const TOML_CONFIG_NAME = 'config/sudo-ai.toml';

// ---------------------------------------------------------------------------
// loadConfig5Pillar — Wave 10 standalone function
// ---------------------------------------------------------------------------

/**
 * Load the TOML 5-pillar overlay configuration.
 *
 * If the file does not exist, returns an empty Config5Pillar (all fields undefined).
 * This is the preferred entry point for Wave 10 recipe and operator bootstrap.
 *
 * Config merge order (caller's responsibility):
 *   1. JSON5 base (SudoConfig) — loaded by ConfigLoader.load()
 *   2. TOML overlay (Config5Pillar) — loaded here
 *   3. env vars — always win
 *
 * @param tomlPath - Absolute path to the TOML file.
 *                   Defaults to <cwd>/config/sudo-ai.toml.
 * @returns Parsed Config5Pillar, or empty object if file absent.
 */
export async function loadConfig5Pillar(tomlPath?: string): Promise<Config5Pillar> {
  const resolvedPath = tomlPath ?? path.resolve(process.cwd(), TOML_CONFIG_NAME);

  if (!fs.existsSync(resolvedPath)) {
    log.debug({ tomlPath: resolvedPath }, 'No TOML overlay found — returning empty Config5Pillar');
    return {};
  }

  let raw: string;
  try {
    raw = fs.readFileSync(resolvedPath, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ tomlPath: resolvedPath, err: message }, 'Failed to read TOML overlay — skipping');
    return {};
  }

  // Dynamically import smol-toml to avoid top-level dep if TOML not used
  let parsed: Record<string, unknown>;
  try {
    const { parse } = await import('smol-toml');
    parsed = parse(raw) as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ tomlPath: resolvedPath, err: message }, 'TOML parse error in overlay — skipping');
    return {};
  }

  // Map TOML sections to Config5Pillar shape
  const pillar: Config5Pillar = {};

  if (isObject(parsed['intelligence'])) {
    pillar.intelligence = parsed['intelligence'] as Config5Pillar['intelligence'];
  }
  if (isObject(parsed['agent'])) {
    pillar.agent = parsed['agent'] as Config5Pillar['agent'];
  }
  if (isObject(parsed['tools'])) {
    pillar.tools = parsed['tools'] as Config5Pillar['tools'];
  }
  if (isObject(parsed['engine'])) {
    pillar.engine = parsed['engine'] as Config5Pillar['engine'];
  }
  if (isObject(parsed['learning'])) {
    pillar.learning = parsed['learning'] as Config5Pillar['learning'];
  }

  log.info({ tomlPath: resolvedPath, sections: Object.keys(pillar) }, 'TOML overlay loaded');
  return pillar;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// ConfigLoader
// ---------------------------------------------------------------------------

export class ConfigLoader extends EventEmitter {
  private config: SudoConfig | null = null;
  private watcher: fs.FSWatcher | null = null;
  private readonly configPath: string;
  private readonly envPath: string;

  /**
   * @param root - Project root directory (defaults to cwd).
   */
  constructor(root: string = process.cwd()) {
    super();
    this.configPath = path.resolve(root, PATHS.CONFIG);
    this.envPath = path.resolve(root, PATHS.ENV);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Load the config file and .env, validate against the schema, and start the
   * file watcher for hot-reload.
   *
   * @throws ConfigError if the file is missing or fails schema validation.
   */
  async load(): Promise<void> {
    this.loadEnv();
    this.config = this.readAndValidate();
    this.startWatcher();
    log.info({ configPath: this.configPath }, 'Config loaded successfully');
  }

  /**
   * Return the current validated config.
   *
   * @throws ConfigError if `load()` has not been called yet.
   */
  get(): SudoConfig {
    if (this.config === null) {
      throw new ConfigError(
        'Config not loaded — call load() before get()',
        'config_not_loaded',
      );
    }
    return this.config;
  }

  /**
   * Manually trigger a config reload from disk.
   * Emits 'reload' with the new config on success.
   * Logs and swallows errors so the running process is not destabilised.
   */
  reload(): void {
    log.debug('Manual reload triggered');
    this.handleFileChange();
  }

  /**
   * Register a callback that fires whenever the config is successfully
   * reloaded from disk.
   *
   * @param cb - Receives the fresh SudoConfig.
   * @returns `this` for chaining.
   */
  onReload(cb: (config: SudoConfig) => void): this {
    this.on('reload', cb);
    return this;
  }

  /**
   * Stop the file watcher and release all listeners.
   */
  close(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      log.debug('Config watcher closed');
    }
    this.removeAllListeners();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Load .env into process.env (non-destructive — existing vars take priority). */
  private loadEnv(): void {
    if (!fs.existsSync(this.envPath)) {
      log.warn({ envPath: this.envPath }, '.env file not found — skipping dotenv load');
      return;
    }

    const result = loadDotenv({ path: this.envPath, override: false });

    if (result.error) {
      // Non-fatal: some deployments inject env vars directly.
      log.warn({ err: result.error.message }, 'dotenv load warning');
    } else {
      log.debug({ envPath: this.envPath }, '.env loaded');
    }
  }

  /**
   * Read the JSON5 config file, expand any ${ENV_VAR} placeholders, and
   * validate against the TypeBox schema.
   *
   * @throws ConfigError on missing file, parse error, or validation failure.
   */
  private readAndValidate(): SudoConfig {
    // -- Read --
    let raw: string;
    try {
      raw = fs.readFileSync(this.configPath, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ConfigError(
        `Cannot read config file: ${this.configPath} — ${message}`,
        'config_read_error',
        { configPath: this.configPath },
      );
    }

    // -- Env substitution: replace ${VAR_NAME} with process.env value --
    const interpolated = raw.replace(/\$\{([^}]+)\}/g, (_match, key: string) => {
      const val = process.env[key];
      if (val === undefined) {
        log.warn({ key }, 'Config references undefined env var');
        return '';
      }
      return val;
    });

    // -- Parse JSON5 --
    let parsed: unknown;
    try {
      parsed = JSON5.parse(interpolated);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ConfigError(
        `Config parse error in ${this.configPath}: ${message}`,
        'config_parse_error',
        { configPath: this.configPath },
      );
    }

    // -- Validate with TypeBox --
    if (!Value.Check(SudoConfigSchema, parsed)) {
      const errors = [...Value.Errors(SudoConfigSchema, parsed)].map((e) => ({
        path: e.path,
        message: e.message,
        value: e.value,
      }));

      log.error({ errors }, 'Config validation failed');

      throw new ConfigError(
        `Config validation failed: ${errors.map((e) => `${e.path} — ${e.message}`).join('; ')}`,
        'config_validation_error',
        { errors },
      );
    }

    return parsed as SudoConfig;
  }

  /**
   * Start an fs.Watcher on the config file.
   * Changes are debounced by CONFIG_RELOAD_DEBOUNCE_MS to coalesce rapid
   * editor saves.
   */
  private startWatcher(): void {
    if (!fs.existsSync(this.configPath)) {
      log.warn({ configPath: this.configPath }, 'Config file not found — watcher not started');
      return;
    }

    const debouncedChange = debounce(() => {
      this.handleFileChange();
    }, CONFIG_RELOAD_DEBOUNCE_MS);

    try {
      this.watcher = fs.watch(this.configPath, { persistent: false }, (eventType) => {
        if (eventType === 'change' || eventType === 'rename') {
          log.debug({ eventType }, 'Config file change detected');
          (debouncedChange as () => void)();
        }
      });

      this.watcher.on('error', (err) => {
        log.error({ err: err.message }, 'Config watcher error');
      });

      log.debug({ configPath: this.configPath }, 'Config watcher started');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err: message }, 'Could not start config watcher — hot-reload disabled');
    }
  }

  /** Attempt to reload and emit 'reload' event; log errors without crashing. */
  private handleFileChange(): void {
    try {
      const next = this.readAndValidate();
      this.config = next;
      log.info('Config hot-reloaded successfully');
      this.emit('reload', next);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message }, 'Config reload failed — keeping previous config');
    }
  }
}
