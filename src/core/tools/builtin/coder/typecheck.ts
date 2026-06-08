/**
 * coder.typecheck — Run TypeScript type checking (tsc --noEmit) on the project.
 * Parses tsc output into structured errors grouped by file with line numbers,
 * error codes, and messages.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { PROJECT_ROOT as RESOLVED_PROJECT_ROOT } from '../../../shared/paths.js';

const log = createLogger('coder.typecheck');

const PROJECT_ROOT = RESOLVED_PROJECT_ROOT;
const TSC = path.join(PROJECT_ROOT, 'node_modules/.bin/tsc');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ErrorItem {
  line: number;
  col: number;
  code: string;
  message: string;
}

interface TypecheckData {
  clean: boolean;
  errorCount: number;
  fileCount: number;
  errors: Record<string, ErrorItem[]>;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a single tsc error line.
 * Format: `path/file.ts(line,col): error TS1234: message here`
 */
function parseTscLine(line: string): { file: string; item: ErrorItem } | null {
  // Match the standard tsc diagnostic format
  const match = line.match(/^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/);
  if (!match) return null;

  const [, rawFile, rawLine, rawCol, code, message] = match;
  return {
    file: rawFile!.trim(),
    item: {
      line: parseInt(rawLine!, 10),
      col: parseInt(rawCol!, 10),
      code: code!,
      message: message!.trim(),
    },
  };
}

/**
 * Parse tsc stdout/stderr into a grouped error map.
 */
function parseTscOutput(output: string): Record<string, ErrorItem[]> {
  const grouped: Record<string, ErrorItem[]> = {};

  for (const line of output.split('\n')) {
    const parsed = parseTscLine(line);
    if (!parsed) continue;
    const { file, item } = parsed;
    if (!grouped[file]) grouped[file] = [];
    grouped[file].push(item);
  }

  return grouped;
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

function formatOutput(
  grouped: Record<string, ErrorItem[]>,
  errorCount: number,
  filterFile: string | undefined,
): string {
  if (errorCount === 0) {
    return filterFile
      ? `TypeScript: ✓ 0 errors — clean (filtered: ${filterFile})`
      : 'TypeScript: ✓ 0 errors — clean';
  }

  const fileCount = Object.keys(grouped).length;
  const lines: string[] = [
    `TypeScript: ✗ ${errorCount} ${errorCount === 1 ? 'error' : 'errors'} in ${fileCount} ${fileCount === 1 ? 'file' : 'files'}`,
    '',
  ];

  for (const [file, items] of Object.entries(grouped)) {
    lines.push(`${file} (${items.length} ${items.length === 1 ? 'error' : 'errors'}):`);
    for (const item of items) {
      lines.push(`  line ${item.line}: ${item.code} — ${item.message}`);
    }
    lines.push('');
  }

  // Remove trailing blank line
  if (lines[lines.length - 1] === '') lines.pop();

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const typecheckTool: ToolDefinition = {
  name: 'coder.typecheck',
  description:
    'Run TypeScript type checking (tsc --noEmit). MANDATORY after EVERY code change — no exceptions. ' +
    'Run BEFORE editing to get baseline error count. Run AFTER editing to confirm no new errors. ' +
    'Zero new errors = minimum bar to commit. If errors introduced: fix them before proceeding. ' +
    'Returns structured errors by file with line numbers, TS error codes, and messages. ' +
    'Use "file" param to focus on a specific file for faster targeted checks.',
  category: 'coder',
  timeout: 120_000,

  parameters: {
    file: {
      type: 'string',
      required: false,
      description:
        'If provided, only show errors for this specific file path (still runs full project check but ' +
        'filters output). Leave empty for all errors.',
    },
    fix: {
      type: 'boolean',
      required: false,
      default: false,
      description:
        'If true, attempt to auto-fix common errors using --fixAll where supported. Note: tsc does not ' +
        'auto-fix so this just reports suggestions.',
    },
    strict: {
      type: 'boolean',
      required: false,
      default: false,
      description: 'If true, add --strict flag to the check.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const ctxLog = (ctx.logger as typeof log | undefined) ?? log;

    const filterFile = typeof params['file'] === 'string' && params['file'].trim() !== ''
      ? params['file'].trim()
      : undefined;

    const useStrict = params['strict'] === true;

    // Build tsc command
    const args: string[] = ['--noEmit'];
    if (useStrict) args.push('--strict');

    const cmd = `${TSC} ${args.join(' ')}`;

    // Verify tsc binary exists
    try {
      execSync(`test -f "${TSC}"`, { stdio: 'ignore' });
    } catch {
      return {
        success: false,
        output: `coder.typecheck error: tsc binary not found at ${TSC}. Run 'npm install' first.`,
        data: {
          clean: false,
          errorCount: 0,
          fileCount: 0,
          errors: {},
          durationMs: 0,
        } satisfies TypecheckData,
      };
    }

    ctxLog.info({ tool: 'coder.typecheck', cmd, filterFile, useStrict }, 'Running tsc');

    const startMs = Date.now();
    let rawOutput = '';

    try {
      // tsc exits 0 on success — if no errors we land here
      execSync(cmd, {
        cwd: PROJECT_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: (ctx.signal ? undefined : 115_000),
        encoding: 'utf-8',
      });
      // No output means clean
      rawOutput = '';
    } catch (err) {
      // tsc exits non-zero on type errors; stdout/stderr carry the diagnostics
      const execErr = err as {
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        message?: string;
        code?: string | number;
        signal?: string;
      };

      // Timeout or signal
      if (execErr.signal === 'SIGTERM' || execErr.code === 'ETIMEDOUT') {
        return {
          success: false,
          output: 'coder.typecheck error: tsc timed out. The project may be too large or have a tsconfig issue.',
          data: {
            clean: false,
            errorCount: 0,
            fileCount: 0,
            errors: {},
            durationMs: Date.now() - startMs,
          } satisfies TypecheckData,
        };
      }

      // Collect output — tsc writes diagnostics to stdout
      const stdout = typeof execErr.stdout === 'string'
        ? execErr.stdout
        : execErr.stdout?.toString('utf-8') ?? '';
      const stderr = typeof execErr.stderr === 'string'
        ? execErr.stderr
        : execErr.stderr?.toString('utf-8') ?? '';

      rawOutput = [stdout, stderr].filter(Boolean).join('\n');

      // If no parseable errors in output, it might be a launch failure
      if (!rawOutput.includes('error TS')) {
        const message = execErr.message ?? String(err);
        ctxLog.error({ tool: 'coder.typecheck', err }, 'tsc failed to launch');
        return {
          success: false,
          output: `coder.typecheck error: tsc failed to run.\n${message}\n${rawOutput}`.trim(),
          data: {
            clean: false,
            errorCount: 0,
            fileCount: 0,
            errors: {},
            durationMs: Date.now() - startMs,
          } satisfies TypecheckData,
        };
      }
    }

    const durationMs = Date.now() - startMs;

    // Parse all errors
    let allErrors = parseTscOutput(rawOutput);

    // Filter by file if requested
    if (filterFile) {
      const filtered: Record<string, ErrorItem[]> = {};
      for (const [file, items] of Object.entries(allErrors)) {
        if (file.includes(filterFile)) {
          filtered[file] = items;
        }
      }
      allErrors = filtered;
    }

    const errorCount = Object.values(allErrors).reduce((sum, items) => sum + items.length, 0);
    const fileCount = Object.keys(allErrors).length;
    const clean = errorCount === 0;

    const data: TypecheckData = {
      clean,
      errorCount,
      fileCount,
      errors: allErrors,
      durationMs,
    };

    ctxLog.info(
      { tool: 'coder.typecheck', clean, errorCount, fileCount, durationMs },
      clean ? 'Type check passed' : 'Type errors found',
    );

    return {
      success: clean,
      output: formatOutput(allErrors, errorCount, filterFile),
      data,
    };
  },
};

export default typecheckTool;
