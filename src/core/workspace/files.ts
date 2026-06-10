/**
 * @file files.ts
 * @description WorkspaceManager — read, write, and watch workspace Markdown files.
 *
 * All workspace files live under workspace/{NAME}.md relative to the project root.
 * This class extends EventEmitter to notify consumers of file changes.
 *
 * Events:
 *  - 'changed' (name: WorkspaceFileName, content: string)
 *  - 'error'   (err: Error)
 */

import { EventEmitter } from 'node:events';
import {
  readFile,
  writeFile,
  readdir,
  stat,
} from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/index.js';
import { PATHS } from '../shared/index.js';
import type { WorkspaceFile, WorkspaceFileName } from './types.js';

const log = createLogger('workspace:files');

/** All valid workspace file names. */
const VALID_NAMES = new Set<WorkspaceFileName>([
  'SOUL',
  'AGENTS',
  'USER',
  'IDENTITY',
  'HEARTBEAT',
  'BOOTSTRAP',
  'TOOLS',
  'GROWTH_TRACKER',
  'LEARNING_JOURNAL',
]);

/** Debounce window for fs.watch events (avoids duplicate change notifications). */
const WATCH_DEBOUNCE_MS = 200;

/**
 * WorkspaceManager manages the workspace Markdown files used by SUDO-AI.
 *
 * @example
 * ```ts
 * const ws = new WorkspaceManager();
 * const soul = await ws.readFile('SOUL');
 * await ws.writeFile('IDENTITY', updatedContent);
 * ws.on('changed', (name, content) => console.log(name, 'changed'));
 * ws.watchForChanges();
 * ```
 */
export class WorkspaceManager extends EventEmitter {
  private readonly workspaceDir: string;
  private watcher: FSWatcher | null = null;
  /** Per-filename debounce timers so concurrent changes to distinct files are not collapsed. */
  private readonly changeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * @param workspaceDir - Absolute or relative path to the workspace directory.
   *                       Defaults to PATHS.WORKSPACE (<project-root>/workspace).
   */
  constructor(workspaceDir: string = PATHS.WORKSPACE) {
    super();
    this.workspaceDir = path.resolve(workspaceDir);
    this._ensureDir(this.workspaceDir);
    log.info({ workspaceDir: this.workspaceDir }, 'WorkspaceManager initialized');
  }

  // ---------------------------------------------------------------------------
  // Read / Write
  // ---------------------------------------------------------------------------

  /**
   * Read a workspace file by name.
   *
   * @param name - Canonical workspace file name.
   * @returns WorkspaceFile with content and mtime.
   * @throws Error if the file does not exist.
   */
  async readFile(name: WorkspaceFileName): Promise<WorkspaceFile> {
    this._assertValidName(name);
    const filePath = this._filePath(name);

    const [content, stats] = await Promise.all([
      readFile(filePath, 'utf-8'),
      stat(filePath),
    ]);

    return { name, content, lastModified: stats.mtime };
  }

  /**
   * Write content to a workspace file, creating it if necessary.
   *
   * @param name    - Canonical workspace file name.
   * @param content - Markdown content to write.
   */
  async writeFile(name: WorkspaceFileName, content: string): Promise<void> {
    this._assertValidName(name);
    if (typeof content !== 'string') {
      throw new TypeError(`writeFile: content must be a string, got ${typeof content}`);
    }

    const filePath = this._filePath(name);
    await writeFile(filePath, content, 'utf-8');
    log.debug({ name, bytes: content.length }, 'workspace file written');
  }

  /**
   * Check whether a workspace file currently exists on disk.
   *
   * @param name - Canonical workspace file name.
   */
  exists(name: WorkspaceFileName): boolean {
    this._assertValidName(name);
    return existsSync(this._filePath(name));
  }

  /**
   * Read all workspace files that currently exist on disk.
   *
   * @returns Array of WorkspaceFile objects (may be empty if workspace is bare).
   */
  async listAll(): Promise<WorkspaceFile[]> {
    let entries: string[];
    try {
      entries = await readdir(this.workspaceDir);
    } catch (err) {
      log.error({ err, dir: this.workspaceDir }, 'Failed to read workspace directory');
      return [];
    }

    const results: WorkspaceFile[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const nameWithoutExt = entry.slice(0, -3) as WorkspaceFileName;
      if (!VALID_NAMES.has(nameWithoutExt)) continue;

      try {
        const file = await this.readFile(nameWithoutExt);
        results.push(file);
      } catch (err) {
        log.warn({ name: nameWithoutExt, err }, 'Failed to read workspace file — skipping');
      }
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Watching
  // ---------------------------------------------------------------------------

  /**
   * Begin watching the workspace directory for file changes.
   * Emits 'changed' events (debounced) when a workspace file is modified.
   * Emits 'error' if the watcher fails.
   *
   * Safe to call multiple times — duplicate calls are no-ops.
   */
  watchForChanges(): void {
    if (this.watcher) {
      log.debug('watchForChanges: already watching');
      return;
    }

    try {
      this.watcher = watch(this.workspaceDir, { persistent: false }, (_event, filename) => {
        this._debounceFileChange(filename);
      });

      this.watcher.on('error', (err) => {
        log.error({ err }, 'Workspace watcher error');
        this.emit('error', err);
      });

      log.info({ dir: this.workspaceDir }, 'Workspace watcher started');
    } catch (err) {
      log.error({ err }, 'Failed to start workspace watcher');
      this.emit('error', err);
    }
  }

  /** Stop watching for changes and release the FSWatcher. */
  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      log.info('Workspace watcher stopped');
    }
    for (const timer of this.changeTimers.values()) clearTimeout(timer);
    this.changeTimers.clear();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Debounce change events per filename so that concurrent changes to distinct
   * files within WATCH_DEBOUNCE_MS are not collapsed into a single notification.
   */
  private _debounceFileChange(filename: string | null): void {
    const key = filename ?? '';
    const existing = this.changeTimers.get(key);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.changeTimers.delete(key);
      void this._onFileChange(filename);
    }, WATCH_DEBOUNCE_MS);
    this.changeTimers.set(key, timer);
  }

  private async _onFileChange(filename: string | null): Promise<void> {
    if (!filename || !filename.endsWith('.md')) return;

    const name = filename.slice(0, -3) as WorkspaceFileName;
    if (!VALID_NAMES.has(name)) return;

    try {
      const file = await this.readFile(name);
      log.debug({ name }, 'workspace file changed');
      this.emit('changed', name, file.content);
    } catch {
      // File may have been deleted — not an error worth surfacing
    }
  }

  private _filePath(name: WorkspaceFileName): string {
    return path.join(this.workspaceDir, `${name}.md`);
  }

  private _assertValidName(name: WorkspaceFileName): void {
    if (!VALID_NAMES.has(name)) {
      throw new TypeError(`Invalid workspace file name: "${String(name)}"`);
    }
  }

  private _ensureDir(dir: string): void {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      log.warn({ dir, err }, 'Could not ensure workspace directory exists');
    }
  }
}
