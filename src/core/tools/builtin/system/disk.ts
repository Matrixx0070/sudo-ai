/**
 * system.disk — Disk usage analysis and cleanup operations.
 * Parses df/du output into structured data; cleanup uses targeted commands.
 */

import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { runCmd, handleNotInstalled } from './exec.js';

const logger = createLogger('system.disk');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FilesystemUsage {
  filesystem: string;
  size: string;
  used: string;
  available: string;
  usePercent: number;
  mountpoint: string;
}

interface LargeEntry {
  size: string;
  path: string;
}

type CleanupType = 'apt' | 'journal' | 'logs' | 'all';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDfOutput(stdout: string): FilesystemUsage[] {
  const lines = stdout.split('\n').filter(Boolean);
  // Skip header line
  return lines.slice(1).map((line) => {
    const parts = line.trim().split(/\s+/);
    return {
      filesystem: parts[0] ?? '',
      size: parts[1] ?? '',
      used: parts[2] ?? '',
      available: parts[3] ?? '',
      usePercent: parseInt(parts[4]?.replace('%', '') ?? '0', 10),
      mountpoint: parts[5] ?? '',
    };
  });
}

function parseDuOutput(stdout: string): LargeEntry[] {
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t');
      return { size: parts[0]?.trim() ?? '', path: parts[1]?.trim() ?? '' };
    });
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function diskUsage(path: string, ctx: ToolContext): Promise<ToolResult> {
  logger.info({ session: ctx.sessionId, path }, 'Checking disk usage');
  const { stdout } = await runCmd('df', ['-h', path], { signal: ctx.signal });
  const filesystems = parseDfOutput(stdout);
  const summary = filesystems
    .map((f) => `${f.mountpoint}: ${f.used}/${f.size} (${f.usePercent}%)`)
    .join(', ');
  return { success: true, output: summary, data: { filesystems } };
}

async function largestItems(path: string, ctx: ToolContext): Promise<ToolResult> {
  logger.info({ session: ctx.sessionId, path }, 'Finding largest disk items');
  const { stdout } = await runCmd(
    'du',
    ['-h', '--max-depth=3', path],
    { signal: ctx.signal, allowFailure: true },
  );
  const all = parseDuOutput(stdout);

  // Sort by human-readable size is complex; use du -BM for numeric comparison.
  const { stdout: numOut } = await runCmd(
    'du',
    ['-BM', '--max-depth=3', path],
    { signal: ctx.signal, allowFailure: true },
  );
  const numEntries = parseDuOutput(numOut)
    .map((e) => ({ ...e, numSize: parseInt(e.size.replace('M', ''), 10) }))
    .sort((a, b) => b.numSize - a.numSize)
    .slice(0, 20);

  // Map back to human sizes.
  const humanMap = new Map(all.map((e) => [e.path, e.size]));
  const largest = numEntries.map((e) => ({ size: humanMap.get(e.path) ?? e.size, path: e.path }));

  return {
    success: true,
    output: `Top ${largest.length} largest items under ${path}`,
    data: { path, largest },
  };
}

async function cleanup(cleanupType: CleanupType, ctx: ToolContext): Promise<ToolResult> {
  logger.warn({ session: ctx.sessionId, cleanupType }, 'Running disk cleanup');
  const results: Record<string, string> = {};

  const runSafe = async (bin: string, args: string[]): Promise<string> => {
    try {
      const { stdout, stderr } = await runCmd(bin, args, { signal: ctx.signal, allowFailure: true });
      return stdout || stderr;
    } catch {
      return 'skipped (not available)';
    }
  };

  if (cleanupType === 'apt' || cleanupType === 'all') {
    results['apt-autoremove'] = await runSafe('apt-get', ['-y', 'autoremove']);
    results['apt-clean'] = await runSafe('apt-get', ['clean']);
  }

  if (cleanupType === 'journal' || cleanupType === 'all') {
    results['journal-vacuum'] = await runSafe('journalctl', ['--vacuum-time=7d']);
  }

  if (cleanupType === 'logs' || cleanupType === 'all') {
    // Rotate and compress logs older than 7 days in /var/log
    results['logrotate'] = await runSafe('logrotate', ['-f', '/etc/logrotate.conf']);
  }

  const actionCount = Object.keys(results).length;
  return {
    success: true,
    output: `Cleanup complete: ${actionCount} action(s) performed`,
    data: { cleanupType, results },
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const diskTool: ToolDefinition = {
  name: 'system.disk',
  description: 'Analyse disk usage (df), find largest files/dirs (du), or run system cleanup.',
  category: 'system',
  requiresConfirmation: true,
  timeout: 120_000,
  parameters: {
    operation: {
      type: 'string',
      description: 'Operation: usage | largest | cleanup',
      required: true,
      enum: ['usage', 'largest', 'cleanup'],
    },
    path: {
      type: 'string',
      description: 'Filesystem path to analyse (default /)',
      default: '/',
    },
    cleanupType: {
      type: 'string',
      description: 'Type of cleanup: apt | journal | logs | all (default all)',
      default: 'all',
      enum: ['apt', 'journal', 'logs', 'all'],
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const op = params['operation'] as string;
    const path = (params['path'] as string | undefined) ?? '/';
    const cleanupType = ((params['cleanupType'] as string | undefined) ?? 'all') as CleanupType;

    // Validate path to prevent directory traversal attacks.
    if (!path.startsWith('/')) {
      return { success: false, output: 'Path must be absolute', data: {} };
    }

    try {
      switch (op) {
        case 'usage':   return diskUsage(path, ctx);
        case 'largest': return largestItems(path, ctx);
        case 'cleanup': return cleanup(cleanupType, ctx);
        default:
          return { success: false, output: `Unknown operation: ${op}`, data: {} };
      }
    } catch (err) {
      return handleNotInstalled(err, 'df/du') as ToolResult;
    }
  },
};
