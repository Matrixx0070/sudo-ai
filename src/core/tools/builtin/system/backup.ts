/**
 * system.backup — Backup and restore using tar + SHA-256 manifest.
 * Default destination: /root/backups/
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, stat, access } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { runCmd } from './exec.js';

const logger = createLogger('system.backup');

const DEFAULT_DEST = '/root/backups';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BackupManifest {
  name: string;
  created: string;
  paths: string[];
  archivePath: string;
  sha256: string;
  sizeBytes: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sha256File(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

async function ensureDir(dir: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function createBackup(
  paths: string[],
  destination: string,
  name: string,
  ctx: ToolContext,
): Promise<ToolResult> {
  logger.warn({ session: ctx.sessionId, paths, destination, name }, 'Creating backup');

  await ensureDir(destination);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const archiveName = `${name}-${timestamp}.tar.gz`;
  const archivePath = join(destination, archiveName);
  const manifestPath = join(destination, `${archiveName}.manifest.json`);

  // Validate all source paths exist.
  for (const p of paths) {
    try {
      await access(p);
    } catch {
      return { success: false, output: `Source path not found: ${p}`, data: { path: p } };
    }
  }

  await runCmd('tar', ['-czf', archivePath, ...paths], { signal: ctx.signal });

  const info = await stat(archivePath);
  const sha256 = await sha256File(archivePath);

  const manifest: BackupManifest = {
    name,
    created: new Date().toISOString(),
    paths,
    archivePath,
    sha256,
    sizeBytes: info.size,
  };

  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  return {
    success: true,
    output: `Backup created: ${archiveName} (${(info.size / 1024 / 1024).toFixed(2)} MB)`,
    data: { manifest },
    artifacts: [
      { path: archivePath, action: 'created', size: info.size },
      { path: manifestPath, action: 'created' },
    ],
  };
}

async function restoreBackup(
  backupName: string,
  destination: string,
  ctx: ToolContext,
): Promise<ToolResult> {
  logger.warn({ session: ctx.sessionId, backupName, destination }, 'Restoring backup');

  await ensureDir(destination);
  await runCmd('tar', ['-xzf', backupName, '-C', destination], { signal: ctx.signal });

  return {
    success: true,
    output: `Backup extracted to ${destination}`,
    data: { backupName, destination },
  };
}

async function listBackups(destination: string, ctx: ToolContext): Promise<ToolResult> {
  logger.info({ session: ctx.sessionId, destination }, 'Listing backups');

  let files: string[] = [];
  try {
    files = await readdir(destination);
  } catch {
    return { success: true, output: `No backups found at ${destination}`, data: { backups: [] } };
  }

  const archives = files.filter((f) => f.endsWith('.tar.gz'));
  const backups = await Promise.all(
    archives.map(async (file) => {
      const filePath = join(destination, file);
      const info = await stat(filePath).catch(() => null);
      const manifestPath = `${filePath}.manifest.json`;
      let manifest: Partial<BackupManifest> = {};
      try {
        manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as BackupManifest;
      } catch { /* no manifest */ }
      return {
        name: file,
        path: filePath,
        sizeBytes: info?.size ?? 0,
        created: manifest.created ?? info?.mtime.toISOString() ?? '',
        paths: manifest.paths ?? [],
      };
    }),
  );

  return {
    success: true,
    output: `${backups.length} backup(s) in ${destination}`,
    data: { destination, backups },
  };
}

async function verifyBackup(backupPath: string, ctx: ToolContext): Promise<ToolResult> {
  logger.info({ session: ctx.sessionId, backupPath }, 'Verifying backup integrity');

  const manifestPath = `${backupPath}.manifest.json`;
  let manifest: BackupManifest | null = null;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as BackupManifest;
  } catch {
    return { success: false, output: 'No manifest found — cannot verify', data: { backupPath } };
  }

  const actual = await sha256File(backupPath).catch(() => '');
  const valid = actual === manifest.sha256;

  // Also test the archive is readable.
  const { exitCode } = await runCmd('tar', ['-tzf', backupPath], { signal: ctx.signal, allowFailure: true });
  const readable = exitCode === 0;

  return {
    success: valid && readable,
    output: valid && readable
      ? `Backup integrity OK: ${basename(backupPath)}`
      : `Backup integrity FAILED (sha256Match=${valid}, readable=${readable})`,
    data: { backupPath, sha256Match: valid, readable, expected: manifest.sha256, actual },
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const backupTool: ToolDefinition = {
  name: 'system.backup',
  description: 'Create tar.gz backups with SHA-256 manifests, restore, list, and verify backup integrity.',
  category: 'system',
  requiresConfirmation: true,
  timeout: 300_000,
  parameters: {
    operation: {
      type: 'string',
      description: 'Operation: create | restore | list | verify',
      required: true,
      enum: ['create', 'restore', 'list', 'verify'],
    },
    paths: {
      type: 'array',
      description: 'Source paths to backup (create operation)',
      items: { type: 'string', description: 'Absolute path to include' },
    },
    destination: {
      type: 'string',
      description: 'Destination directory for backups (default /root/backups/)',
      default: DEFAULT_DEST,
    },
    backupName: {
      type: 'string',
      description: 'Name prefix for the archive, or full path for restore/verify',
      default: 'backup',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const op = params['operation'] as string;
    const paths = Array.isArray(params['paths']) ? (params['paths'] as string[]) : [];
    const destination = (params['destination'] as string | undefined) ?? DEFAULT_DEST;
    const backupName = (params['backupName'] as string | undefined) ?? 'backup';

    switch (op) {
      case 'create': {
        if (paths.length === 0) {
          return { success: false, output: 'create requires at least one path', data: {} };
        }
        return createBackup(paths, destination, backupName, ctx);
      }
      case 'restore':
        return restoreBackup(backupName, destination, ctx);
      case 'list':
        return listBackups(destination, ctx);
      case 'verify':
        return verifyBackup(backupName, ctx);
      default:
        return { success: false, output: `Unknown operation: ${op}`, data: {} };
    }
  },
};
