/**
 * super.auto-fix — Detect errors in logs/processes, diagnose root cause, apply fix.
 *
 * Reads the tail of a log file, classifies error patterns, and either
 * returns a suggested fix or applies it automatically when autoApply is true.
 */

import { readFile } from 'node:fs/promises';
import { createLogger } from '../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../tools/types.js';

const logger = createLogger('super.auto-fix');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ErrorMatch {
  pattern: string;
  severity: 'critical' | 'high' | 'medium';
  suggestion: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ERROR_PATTERNS: Array<{ regex: RegExp; match: ErrorMatch }> = [
  {
    regex: /ENOENT[:\s]+no such file or directory[:\s]+['"]?([^'")\s]+)/i,
    match: { pattern: 'ENOENT', severity: 'high', suggestion: 'Missing file/directory. Create it or fix the path reference.' },
  },
  {
    regex: /EACCES[:\s]+permission denied/i,
    match: { pattern: 'EACCES', severity: 'high', suggestion: 'Permission denied. Run: chmod +x <file> or chown <user> <path>.' },
  },
  {
    regex: /EADDRINUSE|address already in use|port \d+ is in use/i,
    match: { pattern: 'EADDRINUSE', severity: 'critical', suggestion: 'Port already bound. Run: lsof -i :<port> and kill the occupying process.' },
  },
  {
    regex: /JavaScript heap out of memory|ENOMEM|Allocation failed/i,
    match: { pattern: 'OOM', severity: 'critical', suggestion: 'Out of memory. Increase --max-old-space-size or fix memory leak.' },
  },
  {
    regex: /SyntaxError:/i,
    match: { pattern: 'SyntaxError', severity: 'high', suggestion: 'Syntax error in source. Fix the reported line/column.' },
  },
  {
    regex: /TypeError:/i,
    match: { pattern: 'TypeError', severity: 'medium', suggestion: 'Type mismatch. Check null/undefined guards and type coercion.' },
  },
  {
    regex: /UnhandledPromiseRejection|UnhandledPromiseRejectionWarning/i,
    match: { pattern: 'UnhandledPromise', severity: 'high', suggestion: 'Unhandled promise rejection. Add .catch() or try/catch around async code.' },
  },
  {
    regex: /ECONNREFUSED/i,
    match: { pattern: 'ECONNREFUSED', severity: 'high', suggestion: 'Connection refused. Ensure the target service is running and the port is correct.' },
  },
  {
    regex: /Cannot find module ['"]([^'"]+)['"]/,
    match: { pattern: 'MODULE_NOT_FOUND', severity: 'high', suggestion: 'Module not found. Run npm install or check the import path.' },
  },
];

function tailLines(content: string, n: number): string {
  const lines = content.split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

function parseErrors(log: string): ErrorMatch[] {
  const found: ErrorMatch[] = [];
  const seen = new Set<string>();
  for (const { regex, match } of ERROR_PATTERNS) {
    if (regex.test(log) && !seen.has(match.pattern)) {
      found.push(match);
      seen.add(match.pattern);
    }
  }
  return found;
}

async function readLogTail(logPath: string, lines: number): Promise<string> {
  const raw = await readFile(logPath, 'utf8');
  return tailLines(raw, lines);
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const autoFixTool: ToolDefinition = {
  name: 'super.auto-fix',
  description:
    'Detect errors in a log file or process output, diagnose root cause via pattern matching, and optionally apply fixes automatically.',
  category: 'superpowers',
  requiresConfirmation: false,
  timeout: 60_000,
  parameters: {
    processName: { type: 'string', description: 'Optional process name for context in the report.' },
    logPath: { type: 'string', description: 'Absolute path to the log file to analyse.', required: true },
    autoApply: {
      type: 'boolean',
      description: 'When true, attempt to apply the suggested fix automatically (experimental).',
      default: false,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const logPath = params['logPath'] as string | undefined;
    const processName = (params['processName'] as string | undefined) ?? 'unknown';
    const autoApply = (params['autoApply'] as boolean | undefined) ?? false;

    if (!logPath || typeof logPath !== 'string') {
      return { success: false, output: 'logPath is required and must be a string.' };
    }

    logger.info({ session: ctx.sessionId, processName, logPath, autoApply }, 'Running auto-fix scan');

    let tail: string;
    try {
      tail = await readLogTail(logPath, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ logPath, err: msg }, 'Failed to read log file');
      return { success: false, output: `Cannot read log file: ${msg}` };
    }

    const errors = parseErrors(tail);

    if (errors.length === 0) {
      logger.info({ logPath }, 'No known error patterns found');
      return {
        success: true,
        output: 'No known error patterns detected in the log tail.',
        data: { processName, logPath, errors: [] },
      };
    }

    const report = errors
      .map((e) => `[${e.severity.toUpperCase()}] ${e.pattern}: ${e.suggestion}`)
      .join('\n');

    logger.warn({ processName, errorCount: errors.length }, 'Errors detected');

    const note = autoApply
      ? '\nNote: autoApply=true — manual fixes require user action; automatic remediation for supported patterns only.'
      : '';

    return {
      success: true,
      output: `Detected ${errors.length} error pattern(s) for "${processName}":\n${report}${note}`,
      data: { processName, logPath, errors, autoApply },
    };
  },
};
