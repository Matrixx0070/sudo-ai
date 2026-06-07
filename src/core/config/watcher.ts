/**
 * ConfigWatcher — watches config/sudo-ai.json5 for file-system changes,
 * debounces rapid saves, classifies changes, and emits a 'reload' event.
 *
 * Change classification:
 *   'hot'     — apply immediately without restarting (models, tools, cron).
 *   'restart' — a full process restart is recommended (channels, gateway, plugins).
 *
 * Usage:
 *   const watcher = new ConfigWatcher('/path/to/project');
 *   watcher.on('reload', ({ config, changeKind }) => { ... });
 *   watcher.start();
 *   // later:
 *   watcher.stop();
 */

import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import JSON5 from 'json5';
import { createLogger } from '../shared/logger.js';
import { CONFIG_RELOAD_DEBOUNCE_MS } from '../shared/constants.js';
import { debounce } from '../shared/utils.js';

const log = createLogger('config:watcher');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChangeKind = 'hot' | 'restart';

export interface ReloadEvent {
  /** The freshly parsed (but not validated) config object. */
  config: Record<string, unknown>;
  /** Whether the change can be applied without a restart. */
  changeKind: ChangeKind;
  /** Top-level keys that changed. */
  changedKeys: string[];
}

// ---------------------------------------------------------------------------
// Constants — which top-level keys require a restart
// ---------------------------------------------------------------------------

const RESTART_KEYS: ReadonlySet<string> = new Set(['channels', 'gateway', 'plugins']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flatten a Record to a set of top-level keys that differ between a and b. */
function diffTopLevelKeys(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): string[] {
  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changed: string[] = [];
  for (const key of allKeys) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      changed.push(key);
    }
  }
  return changed;
}

/** Parse a JSON5 file. Returns null on error. */
function parseJson5File(filePath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON5.parse(raw) as Record<string, unknown>;
  } catch (err) {
    log.warn({ err: String(err), filePath }, 'ConfigWatcher: failed to parse config file');
    return null;
  }
}

// ---------------------------------------------------------------------------
// ConfigWatcher
// ---------------------------------------------------------------------------

export class ConfigWatcher extends EventEmitter {
  private readonly configPath: string;
  private watcher: fs.FSWatcher | null = null;
  private previousConfig: Record<string, unknown> | null = null;
  private started = false;

  /**
   * @param root - Project root. Config resolved as root/config/sudo-ai.json5.
   */
  constructor(root: string = process.cwd()) {
    super();
    this.configPath = path.resolve(root, 'config', 'sudo-ai.json5');
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start watching the config file.
   * Reads the current config as a baseline for change diffing.
   * Idempotent — calling start() twice is safe.
   */
  start(): void {
    if (this.started) {
      log.warn('ConfigWatcher already started — ignoring duplicate start()');
      return;
    }

    // Establish baseline.
    this.previousConfig = parseJson5File(this.configPath);

    if (!fs.existsSync(this.configPath)) {
      log.warn({ configPath: this.configPath }, 'ConfigWatcher: config file not found — watcher not started');
      return;
    }

    const debouncedHandler = debounce(
      () => this._handleChange(),
      CONFIG_RELOAD_DEBOUNCE_MS,
    ) as () => void;

    try {
      // Watch the parent directory rather than the file itself. Many editors
      // and config writers save via an atomic write-to-temp-then-rename, which
      // replaces the file's inode. A file-level fs.watch follows the original
      // inode and stops firing after the first such save; watching the directory
      // and filtering on the basename survives inode replacement.
      const configDir = path.dirname(this.configPath);
      const configFile = path.basename(this.configPath);
      this.watcher = fs.watch(configDir, { persistent: false }, (eventType, filename) => {
        if (filename !== null && filename !== configFile) {
          return;
        }
        if (eventType === 'change' || eventType === 'rename') {
          log.debug({ eventType, filename }, 'ConfigWatcher: file event detected');
          debouncedHandler();
        }
      });

      this.watcher.on('error', (err) => {
        log.error({ err: String(err) }, 'ConfigWatcher: fs.watch error');
      });

      this.started = true;
      log.info({ configPath: this.configPath, debouncems: CONFIG_RELOAD_DEBOUNCE_MS }, 'ConfigWatcher started');
    } catch (err) {
      log.error({ err: String(err) }, 'ConfigWatcher: could not start fs.watch');
    }
  }

  /**
   * Stop watching and release all listeners.
   * Safe to call multiple times.
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.started = false;
    this.removeAllListeners();
    log.info('ConfigWatcher stopped');
  }

  /** Whether the watcher is currently active. */
  get isRunning(): boolean {
    return this.started;
  }

  // -------------------------------------------------------------------------
  // Change handler
  // -------------------------------------------------------------------------

  private _handleChange(): void {
    const next = parseJson5File(this.configPath);
    if (!next) {
      log.warn('ConfigWatcher: skipping reload — parse failed');
      return;
    }

    const prev = this.previousConfig ?? {};
    const changedKeys = diffTopLevelKeys(prev, next);

    if (changedKeys.length === 0) {
      log.debug('ConfigWatcher: file changed but config content is identical — skipping');
      return;
    }

    const requiresRestart = changedKeys.some((k) => RESTART_KEYS.has(k));
    const changeKind: ChangeKind = requiresRestart ? 'restart' : 'hot';

    log.info(
      { changedKeys, changeKind },
      `ConfigWatcher: config changed — ${changeKind === 'restart' ? 'RESTART required' : 'hot-reload'}`,
    );

    this.previousConfig = next;

    const event: ReloadEvent = { config: next, changeKind, changedKeys };
    this.emit('reload', event);
  }
}
