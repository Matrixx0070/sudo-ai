/**
 * @file daily-log.ts
 * @description DailyLogManager — append-only daily activity logs.
 *
 * Logs are stored as workspace/memory/YYYY-MM-DD.md files.
 * Each run of SUDO-AI appends timestamped entries to today's log.
 * Old logs can be pruned by calling cleanup().
 */

import {
  appendFile,
  readFile,
  readdir,
  unlink,
  stat,
} from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/index.js';
import { PATHS } from '../shared/index.js';
import { todayISO } from '../shared/index.js';

const log = createLogger('workspace:daily-log');

/** Default number of days to retain log files. */
const DEFAULT_KEEP_DAYS = 30;

/** Directory where daily logs are stored (workspace/memory/). */
const MEMORY_SUBDIR = 'memory';

/**
 * Manages per-day activity log files stored in workspace/memory/.
 *
 * @example
 * ```ts
 * const dlm = new DailyLogManager();
 * await dlm.append('## Tool use\nCalled search_web with query "latest AI news"');
 * const today = await dlm.read();
 * const recent = await dlm.getRecent(7);
 * await dlm.cleanup(30);
 * ```
 */
export class DailyLogManager {
  private readonly logDir: string;

  /**
   * @param workspaceDir - Root workspace directory (default: PATHS.WORKSPACE, absolute).
   */
  constructor(workspaceDir: string = PATHS.WORKSPACE) {
    this.logDir = path.resolve(workspaceDir, MEMORY_SUBDIR);
    this._ensureDir(this.logDir);
    log.info({ logDir: this.logDir }, 'DailyLogManager initialized');
  }

  // ---------------------------------------------------------------------------
  // Write
  // ---------------------------------------------------------------------------

  /**
   * Append content to today's log file with a timestamp header.
   * Creates the file if it does not exist.
   *
   * @param content - Markdown content to append.
   */
  async append(content: string): Promise<void> {
    if (typeof content !== 'string' || content.trim().length === 0) {
      log.warn('append: empty content — skipping');
      return;
    }

    const date = todayISO();
    const filePath = this._logPath(date);
    const timestamp = new Date().toISOString();
    const entry = `\n\n<!-- ${timestamp} -->\n${content.trim()}\n`;

    try {
      await appendFile(filePath, entry, 'utf-8');
      log.debug({ date, bytes: entry.length }, 'daily log entry appended');
    } catch (err) {
      log.error({ date, filePath, err }, 'Failed to append to daily log');
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  /**
   * Read a specific date's log file (or today if omitted).
   *
   * @param date - ISO date string (YYYY-MM-DD). Defaults to today.
   * @returns File content, or empty string if no log exists for that date.
   */
  async read(date?: string): Promise<string> {
    const target = date ?? todayISO();
    this._assertValidDate(target);
    const filePath = this._logPath(target);

    try {
      return await readFile(filePath, 'utf-8');
    } catch (err: unknown) {
      if (this._isNotFoundError(err)) return '';
      log.error({ date: target, err }, 'Failed to read daily log');
      throw err;
    }
  }

  /**
   * Read the last N days of logs (most recent first).
   *
   * @param days - Number of recent days to include (default: 7).
   * @returns Array of { date, content } objects, newest first.
   */
  async getRecent(days = 7): Promise<Array<{ date: string; content: string }>> {
    if (days < 1) throw new RangeError('getRecent: days must be >= 1');

    const results: Array<{ date: string; content: string }> = [];

    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const date = d.toISOString().split('T')[0] as string;
      const content = await this.read(date);
      if (content.trim().length > 0) {
        results.push({ date, content });
      }
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  /**
   * Delete log files older than `keepDays` days.
   * Does not touch files that do not match the YYYY-MM-DD.md naming scheme.
   *
   * @param keepDays - Number of days to keep (default: 30).
   * @returns Number of files deleted.
   */
  async cleanup(keepDays = DEFAULT_KEEP_DAYS): Promise<number> {
    if (keepDays < 1) throw new RangeError('cleanup: keepDays must be >= 1');

    let entries: string[];
    try {
      entries = await readdir(this.logDir);
    } catch (err) {
      log.error({ err, logDir: this.logDir }, 'cleanup: failed to read log directory');
      return 0;
    }

    const cutoffMs = Date.now() - keepDays * 24 * 60 * 60 * 1_000;
    let deleted = 0;

    for (const entry of entries) {
      if (!this._isLogFile(entry)) continue;

      const filePath = path.join(this.logDir, entry);
      try {
        const { mtime } = await stat(filePath);
        if (mtime.getTime() < cutoffMs) {
          await unlink(filePath);
          deleted++;
          log.debug({ file: entry }, 'old log file deleted');
        }
      } catch (err) {
        log.warn({ file: entry, err }, 'cleanup: failed to stat/delete file (skipped)');
      }
    }

    log.info({ deleted, keepDays }, 'daily log cleanup complete');
    return deleted;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private _logPath(date: string): string {
    return path.join(this.logDir, `${date}.md`);
  }

  private _isLogFile(filename: string): boolean {
    return /^\d{4}-\d{2}-\d{2}\.md$/.test(filename);
  }

  private _assertValidDate(date: string): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new TypeError(`Invalid date format: "${date}". Expected YYYY-MM-DD.`);
    }
  }

  private _isNotFoundError(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as NodeJS.ErrnoException).code === 'ENOENT'
    );
  }

  private _ensureDir(dir: string): void {
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch (err) {
        log.warn({ dir, err }, 'Could not create log directory');
      }
    }
  }
}
