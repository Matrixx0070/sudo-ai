/**
 * git.status — Run `git status --porcelain=v1 -b` in a given directory and
 * return structured branch, ahead/behind, and dirty-file information.
 */

import * as nodePath from 'node:path';
import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { runCmd } from '../system/exec.js';

const logger = createLogger('git.status');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DirtyFile {
  /** Two-character porcelain status code (e.g. ' M', '??', 'A '). */
  status: string;
  /** Path relative to the repo root. */
  path: string;
}

interface GitStatusData {
  branch: string;
  clean: boolean;
  ahead: number;
  behind: number;
  dirtyFiles: DirtyFile[];
  untrackedCount: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse `## main...origin/main [ahead 3, behind 1]` or `## HEAD (no branch)`. */
function parseBranchLine(line: string): { branch: string; ahead: number; behind: number } {
  // Strip leading "## "
  const rest = line.slice(3);

  // Detached HEAD
  if (rest.startsWith('HEAD (no branch)') || rest.startsWith('No commits yet on')) {
    return { branch: 'HEAD', ahead: 0, behind: 0 };
  }

  // Branch is everything before "..."
  const dotIndex = rest.indexOf('...');
  const branch = dotIndex >= 0 ? rest.slice(0, dotIndex) : rest.split(' ')[0] ?? rest;

  const ahead = parseInt(line.match(/\[.*?ahead (\d+)/)?.[1] ?? '0', 10);
  const behind = parseInt(line.match(/behind (\d+)/)?.[1] ?? '0', 10);

  return { branch: branch.trim(), ahead, behind };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const gitStatusTool: ToolDefinition = {
  name: 'git.status',
  description:
    'Return git status for a repository directory: branch, ahead/behind counts, and dirty files.',
  category: 'dev',
  safety: 'readonly',
  timeout: 10_000,
  parameters: {
    cwd: {
      type: 'string',
      description:
        'Absolute path to the git repository directory. Defaults to the current working directory.',
      required: false,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const cwdParam = params['cwd'];

      // --- Resolve working directory ---
      let resolvedCwd: string;

      if (cwdParam === undefined || cwdParam === null || cwdParam === '') {
        // Default to process.cwd()
        resolvedCwd = process.cwd();
      } else if (typeof cwdParam !== 'string') {
        return {
          success: false,
          output: 'git.status: cwd must be a string',
          data: { error: 'invalid_type' },
        };
      } else if (!nodePath.isAbsolute(cwdParam)) {
        return {
          success: false,
          output: `git.status: cwd must be absolute (got: ${cwdParam})`,
          data: { error: 'relative_cwd' },
        };
      } else {
        resolvedCwd = nodePath.resolve(cwdParam);
      }

      logger.info({ resolvedCwd, session: ctx.sessionId }, 'git.status');

      // --- Run git ---
      const { stdout, exitCode } = await runCmd(
        'git',
        ['status', '--porcelain=v1', '-b'],
        { cwd: resolvedCwd, signal: ctx.signal, allowFailure: true },
      );

      if (exitCode !== 0) {
        logger.warn({ resolvedCwd, exitCode }, 'git status failed');
        return {
          success: false,
          output: 'git status failed — not a git repo or git not installed',
          data: { exitCode, cwd: resolvedCwd },
        };
      }

      // --- Parse output ---
      const lines = stdout.split('\n').filter(Boolean);

      const branchLine = lines.find((l) => l.startsWith('## '));
      const { branch, ahead, behind } = branchLine
        ? parseBranchLine(branchLine)
        : { branch: 'unknown', ahead: 0, behind: 0 };

      const fileLines = lines.filter((l) => !l.startsWith('#'));
      const dirtyFiles: DirtyFile[] = fileLines.map((l) => ({
        status: l.slice(0, 2),
        path: l.slice(3),
      }));

      const untrackedCount = dirtyFiles.filter((f) => f.status === '??').length;
      const clean = dirtyFiles.length === 0;

      const data: GitStatusData = { branch, clean, ahead, behind, dirtyFiles, untrackedCount };

      const output = clean
        ? `${branch}: clean, ahead=${ahead}, behind=${behind}`
        : `${branch}: ${dirtyFiles.length} dirty file(s), ahead=${ahead}, behind=${behind}`;

      logger.info({ branch, clean, ahead, behind, dirtyCount: dirtyFiles.length }, 'git.status ok');

      return { success: true, output, data };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, session: ctx.sessionId }, 'git.status unexpected error');
      return {
        success: false,
        output: `git.status error: ${message}`,
        data: { error: 'unexpected' },
      };
    }
  },
};
