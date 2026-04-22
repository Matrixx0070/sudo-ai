/**
 * log.search — Search log files for pattern matches with time-window filtering.
 * Enforces allowed-roots boundary, regex safety, and multi-level size caps.
 */

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';

const logger = createLogger('log.search');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_PATTERN_LEN = 200;
const MAX_LINES = 50_000;
const SCAN_BUDGET_MS = 3_000;
const MAX_LINE_CHARS = 500;
const MAX_TOTAL_CHARS = 8_000;
const DEFAULT_SINCE_MINUTES = 30;
const DEFAULT_MAX_MATCHES = 50;
const HARD_MAX_MATCHES = 200;

// ISO8601 prefix: 2024-01-02T03:04:05.678Z or 2024-01-02 03:04:05+00:00
const ISO_PREFIX_RE =
  /^(\d{4}-\d{2}-\d{2}[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildAllowedRoots(workingDir: string): string[] {
  return [
    path.join(os.homedir(), '.sudo-ai'),
    '/tmp',
    '/var/log',
    workingDir,
    process.cwd(),
  ];
}

function expandPath(input: string): string {
  if (input.startsWith('~/')) {
    return os.homedir() + input.slice(1);
  }
  return input;
}

function isInsideAllowedRoots(resolved: string, roots: string[]): boolean {
  return roots.some((r) => resolved === r || resolved.startsWith(r + '/'));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MatchEntry {
  line: number;
  text: string;
  timestamp?: string;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const logSearchTool: ToolDefinition = {
  name: 'log.search',
  description:
    'Search a log file for lines matching a regex pattern, optionally filtered to a recent time window. ' +
    'Returns matched lines with 1-based line numbers and parsed timestamps.',
  category: 'system',
  safety: 'readonly',
  timeout: 10_000,
  parameters: {
    path: {
      type: 'string',
      description: 'Absolute path to the log file (~/... expansion supported).',
      required: true,
    },
    pattern: {
      type: 'string',
      description: 'Regex pattern to search for (case-insensitive, max 200 chars).',
      required: true,
    },
    sinceMinutes: {
      type: 'number',
      description:
        'Only include log lines with an ISO8601 timestamp newer than this many minutes ago. ' +
        'Lines without a timestamp are always included. Default 30.',
      default: DEFAULT_SINCE_MINUTES,
    },
    maxMatches: {
      type: 'number',
      description: 'Maximum number of matches to return (default 50, max 200).',
      default: DEFAULT_MAX_MATCHES,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      // -----------------------------------------------------------------------
      // 1. Extract & validate path
      // -----------------------------------------------------------------------
      const rawPath = params['path'];
      if (typeof rawPath !== 'string' || rawPath.trim() === '') {
        return {
          success: false,
          output: 'log.search: path is required',
          data: { error: 'missing_path' },
        };
      }
      if (rawPath.includes('\0')) {
        return {
          success: false,
          output: 'log.search: path contains null byte',
          data: { error: 'null_byte' },
        };
      }

      const expanded = expandPath(rawPath);
      if (!path.isAbsolute(expanded)) {
        return {
          success: false,
          output: `log.search: path must be absolute (got: ${rawPath})`,
          data: { error: 'relative_path' },
        };
      }

      const resolved = path.resolve(expanded);

      // -----------------------------------------------------------------------
      // 2. Enforce allowed-roots boundary
      // -----------------------------------------------------------------------
      const allowedRoots = buildAllowedRoots(ctx.workingDir);
      if (!isInsideAllowedRoots(resolved, allowedRoots)) {
        logger.warn({ session: ctx.sessionId, resolved }, 'log.search: path outside allowed directories');
        return {
          success: false,
          output: 'log.search: path outside allowed directories',
          data: { error: 'disallowed_path', resolved },
        };
      }

      // -----------------------------------------------------------------------
      // 3. Validate pattern
      // -----------------------------------------------------------------------
      const rawPattern = params['pattern'];
      if (typeof rawPattern !== 'string' || rawPattern.trim() === '') {
        return {
          success: false,
          output: 'log.search: pattern is required',
          data: { error: 'missing_pattern' },
        };
      }
      if (rawPattern.length > MAX_PATTERN_LEN) {
        return {
          success: false,
          output: `log.search: pattern exceeds ${MAX_PATTERN_LEN} char limit`,
          data: { error: 'pattern_too_long' },
        };
      }

      let re: RegExp;
      try {
        re = new RegExp(rawPattern, 'i');
      } catch {
        return {
          success: false,
          output: `log.search: invalid regex: ${rawPattern}`,
          data: { error: 'invalid_regex' },
        };
      }

      // -----------------------------------------------------------------------
      // 4. Parse optional params
      // -----------------------------------------------------------------------
      const sinceMinutes =
        typeof params['sinceMinutes'] === 'number' && params['sinceMinutes'] >= 0
          ? params['sinceMinutes']
          : DEFAULT_SINCE_MINUTES;

      const rawMax = params['maxMatches'];
      const maxMatches = Math.min(
        typeof rawMax === 'number' && rawMax > 0 ? rawMax : DEFAULT_MAX_MATCHES,
        HARD_MAX_MATCHES,
      );

      const cutoff = new Date(Date.now() - sinceMinutes * 60_000);

      logger.info(
        { session: ctx.sessionId, resolved, pattern: rawPattern, sinceMinutes, maxMatches },
        'log.search',
      );

      // -----------------------------------------------------------------------
      // 5. Read file
      // -----------------------------------------------------------------------
      let fileText: string;
      try {
        fileText = await readFile(resolved, { encoding: 'utf-8', signal: ctx.signal ?? undefined });
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          return {
            success: false,
            output: `log.search: file not found: ${resolved}`,
            data: { error: 'enoent' },
          };
        }
        if (code === 'EACCES') {
          return {
            success: false,
            output: `log.search: permission denied: ${resolved}`,
            data: { error: 'eacces' },
          };
        }
        return {
          success: false,
          output: `log.search: cannot read file: ${resolved}`,
          data: { error: 'read_error' },
        };
      }

      // -----------------------------------------------------------------------
      // 6. Scan lines
      // -----------------------------------------------------------------------
      const allLines = fileText.split('\n').slice(0, MAX_LINES);
      const matches: MatchEntry[] = [];
      let truncated = false;
      let totalChars = 0;
      const scanStart = Date.now();

      for (let i = 0; i < allLines.length; i++) {
        // Wall-clock budget
        if (Date.now() - scanStart > SCAN_BUDGET_MS) {
          truncated = true;
          break;
        }

        // Abort signal
        if (ctx.signal?.aborted) {
          truncated = true;
          break;
        }

        const rawLine = allLines[i] ?? '';

        // Parse optional ISO8601 timestamp prefix
        const tsMatch = ISO_PREFIX_RE.exec(rawLine);
        let timestamp: string | undefined;
        if (tsMatch) {
          timestamp = tsMatch[1];
          // Apply time-window filter only when sinceMinutes > 0
          if (sinceMinutes > 0) {
            const tsDate = new Date(timestamp);
            if (!isNaN(tsDate.getTime()) && tsDate < cutoff) {
              continue; // line is too old
            }
          }
        }

        if (!re.test(rawLine)) {
          continue;
        }

        // Truncate line to max chars
        const text = rawLine.length > MAX_LINE_CHARS ? rawLine.slice(0, MAX_LINE_CHARS) : rawLine;

        // Total output chars cap
        if (totalChars + text.length > MAX_TOTAL_CHARS) {
          truncated = true;
          break;
        }
        totalChars += text.length;

        const entry: MatchEntry = { line: i + 1, text };
        if (timestamp !== undefined) {
          entry.timestamp = timestamp;
        }
        matches.push(entry);

        // maxMatches cap
        if (matches.length >= maxMatches) {
          // Check if there are more matching lines
          truncated = i + 1 < allLines.length;
          break;
        }
      }

      const count = matches.length;
      const output = `${count} match(es) in ${resolved} (pattern: ${rawPattern}), truncated=${truncated}`;

      return {
        success: true,
        output,
        data: { matches, count, truncated },
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, session: ctx.sessionId }, 'log.search unexpected error');
      return {
        success: false,
        output: `log.search: unexpected error: ${msg}`,
        data: { error: 'unexpected' },
      };
    }
  },
};
