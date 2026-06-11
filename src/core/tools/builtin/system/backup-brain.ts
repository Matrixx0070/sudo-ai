/**
 * system.backup-brain — Backup all SUDO-AI databases to a timestamped directory.
 *
 * Copies each .db file found in data/ to data/backups/{label}/.
 * Uses synchronous fs ops for simplicity and atomicity within a single tick.
 */

import { mkdirSync, readdirSync, copyFileSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createLogger } from '../../../shared/logger.js';
import { DATA_DIR } from '../../../shared/paths.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';

const logger = createLogger('system.backup-brain');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(): string {
  const now = new Date();
  const pad = (n: number, len = 2): string => String(n).padStart(len, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function dataDir(): string {
  return DATA_DIR;
}

// ---------------------------------------------------------------------------
// Core backup logic
// ---------------------------------------------------------------------------

interface BackupFile {
  name: string;
  src: string;
  dest: string;
  sizeBytes: number;
}

function runBackup(label: string): { files: BackupFile[]; backupDir: string; totalBytes: number } {
  const data = dataDir();
  const backupRoot = join(data, 'backups');
  const backupDir = join(backupRoot, label);

  // Create destination directory (parents included).
  mkdirSync(backupDir, { recursive: true });
  logger.info({ backupDir }, 'Backup directory created');

  // Find all .db files in data/ (top-level only, not sub-dirs like backups/).
  let entries: string[] = [];
  try {
    entries = readdirSync(data);
  } catch (err) {
    throw new Error(`Cannot read data directory: ${String(err)}`);
  }

  const dbFiles = entries.filter((name) => name.endsWith('.db') && !name.startsWith('.'));

  if (dbFiles.length === 0) {
    logger.warn({ dataDir: data }, 'No .db files found in data/');
  }

  const files: BackupFile[] = [];
  let totalBytes = 0;

  for (const name of dbFiles) {
    const src = join(data, name);
    const dest = join(backupDir, name);

    // Skip if src doesn't exist (race condition guard).
    if (!existsSync(src)) {
      logger.warn({ src }, 'Source DB file disappeared — skipping');
      continue;
    }

    let sizeBytes = 0;
    try {
      sizeBytes = statSync(src).size;
    } catch {
      /* non-fatal — size will be 0 */
    }

    copyFileSync(src, dest);
    totalBytes += sizeBytes;
    files.push({ name, src, dest, sizeBytes });
    logger.info({ name, sizeBytes: humanBytes(sizeBytes) }, 'DB file backed up');
  }

  return { files, backupDir, totalBytes };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const backupBrainTool: ToolDefinition = {
  name: 'system.backup-brain',
  description:
    'Backup all SUDO-AI databases (mind, consciousness, wisdom, knowledge). ' +
    'Creates timestamped copies in data/backups/. Safe to run at any time.',
  category: 'system',
  parameters: {
    label: {
      type: 'string',
      required: false,
      description:
        'Optional label for the backup directory name. ' +
        'Default: auto-generated timestamp (backup-YYYY-MM-DD-HHmmss).',
    },
  },

  async execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const rawLabel = params['label'];
    const label =
      typeof rawLabel === 'string' && rawLabel.trim().length > 0
        ? `backup-${rawLabel.trim().replace(/[^a-zA-Z0-9_-]/g, '_')}`
        : `backup-${formatTimestamp()}`;

    logger.info({ label }, 'Brain backup started');

    let result: ReturnType<typeof runBackup>;
    try {
      result = runBackup(label);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, label }, 'Brain backup failed');
      return {
        success: false,
        output: `Brain backup failed: ${msg}`,
        data: { label, error: msg },
      };
    }

    const { files, backupDir, totalBytes } = result;
    const summary =
      `Backed up ${files.length} database(s) (${humanBytes(totalBytes)}) ` +
      `to data/backups/${label}/`;

    logger.info({ label, fileCount: files.length, totalBytes }, 'Brain backup complete');

    return {
      success: true,
      output: summary,
      data: {
        label,
        backupDir,
        fileCount: files.length,
        totalSizeBytes: totalBytes,
        totalSizeHuman: humanBytes(totalBytes),
        files: files.map((f) => ({
          name: f.name,
          dest: f.dest,
          sizeBytes: f.sizeBytes,
          sizeHuman: humanBytes(f.sizeBytes),
        })),
      },
      artifacts: files.map((f) => ({
        path: f.dest,
        action: 'created' as const,
        size: f.sizeBytes,
      })),
    };
  },
};
