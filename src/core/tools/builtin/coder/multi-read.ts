/**
 * coder.multi-read — Read up to 20 files in a single tool call.
 *
 * Much faster than calling coder.read-file repeatedly when you need to
 * understand how multiple files relate to each other. Supports line
 * numbers, truncation limits, and glob patterns to auto-discover files.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { PROJECT_ROOT, WORKSPACE_DIR, projectPath } from '../../../shared/paths.js';

const logger = createLogger('coder.multi-read');

const MAX_FILES = 20;
const DEFAULT_MAX_LINES = 500;

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.json5', '.jsonc',
  '.md', '.mdx', '.txt', '.log',
  '.yaml', '.yml', '.toml', '.ini', '.env',
  '.sh', '.bash', '.zsh',
  '.css', '.scss', '.less',
  '.html', '.htm', '.xml', '.svg',
  '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h',
  '.sql', '.graphql', '.prisma',
]);

function isBinary(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return !TEXT_EXTENSIONS.has(ext);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function readOneFile(
  rawPath: string,
  maxLines: number,
  showLineNumbers: boolean,
): string {
  // Resolve path
  const abs = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(PROJECT_ROOT, rawPath);

  // Security: must be within project root
  if (!abs.startsWith(PROJECT_ROOT)) {
    return `⚠ BLOCKED: path resolves outside project root: ${rawPath}`;
  }

  if (!existsSync(abs)) {
    return `⚠ NOT FOUND: ${rawPath}`;
  }

  const stat = statSync(abs);
  if (stat.isDirectory()) {
    return `⚠ IS A DIRECTORY: ${rawPath}`;
  }

  if (isBinary(abs)) {
    return `⚠ BINARY FILE: ${rawPath} (${formatSize(stat.size)})`;
  }

  let content: string;
  try {
    content = readFileSync(abs, 'utf-8');
  } catch (err) {
    return `⚠ READ ERROR: ${rawPath} — ${err instanceof Error ? err.message : String(err)}`;
  }

  const allLines = content.split('\n');
  const totalLines = allLines.length;
  const truncated = maxLines > 0 && totalLines > maxLines;
  const displayLines = truncated ? allLines.slice(0, maxLines) : allLines;

  const body = showLineNumbers
    ? displayLines.map((l, i) => `${String(i + 1).padStart(4)} | ${l}`).join('\n')
    : displayLines.join('\n');

  const rel = path.relative(PROJECT_ROOT, abs);
  const truncNote = truncated
    ? `\n... [truncated at ${maxLines} lines — file has ${totalLines} lines total]`
    : '';

  return `═══ ${rel} (${totalLines} lines) ═══\n${body}${truncNote}`;
}

export const multiReadTool: ToolDefinition = {
  name: 'coder.multi-read',
  description:
    'Read up to 20 files in a SINGLE tool call. Use this instead of coder.read-file when touching 2+ files. ' +
    'MANDATORY reconnaissance step: before any multi-file refactor or bug fix, read ALL relevant files at once. ' +
    'Read the target file + files it imports + files that import it — all in one call. ' +
    'Supports glob patterns to auto-discover related files. Shows line numbers for precise editing. ' +
    'This is your primary context-gathering weapon — use it aggressively.',
  category: 'coder',
  timeout: 30_000,
  parameters: {
    paths: {
      type: 'array',
      required: false,
      description:
        `List of file paths to read (up to 20). Absolute or relative to ${PROJECT_ROOT}/. ` +
        'Can be combined with globPattern.',
    },
    globPattern: {
      type: 'string',
      required: false,
      description:
        'Find files matching this name pattern and add them to paths. ' +
        'Example: "health-check.ts", "*.test.ts", "index.ts". ' +
        `Searches inside ${PROJECT_ROOT}/src/ and config/.`,
    },
    maxLinesPerFile: {
      type: 'number',
      required: false,
      description: `Max lines to show per file (default: ${DEFAULT_MAX_LINES}). Pass 0 for unlimited.`,
    },
    showLineNumbers: {
      type: 'boolean',
      required: false,
      description: 'Show line numbers (default: true).',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    logger.info({ session: ctx.sessionId }, 'coder.multi-read invoked');

    const maxLines: number =
      typeof params['maxLinesPerFile'] === 'number'
        ? Math.max(0, Math.floor(params['maxLinesPerFile']))
        : DEFAULT_MAX_LINES;

    const showLineNumbers =
      params['showLineNumbers'] === false ? false : true;

    // Collect paths
    const rawPaths: string[] = [];

    if (Array.isArray(params['paths'])) {
      for (const p of params['paths']) {
        if (typeof p === 'string' && p.trim()) rawPaths.push(p.trim());
      }
    }

    // Glob search
    const globPattern = typeof params['globPattern'] === 'string' ? params['globPattern'].trim() : '';
    if (globPattern) {
      try {
        const safePattern = globPattern.replace(/[`$(){}!;|&]/g, '');
        const findOut = execSync(
          `find ${projectPath('src')} ${projectPath('config')} ${WORKSPACE_DIR} -name "${safePattern}" 2>/dev/null | head -15`,
          { encoding: 'utf-8', timeout: 8_000 },
        ).trim();
        if (findOut) {
          for (const line of findOut.split('\n')) {
            if (line.trim()) rawPaths.push(line.trim());
          }
        }
      } catch {
        // ignore glob errors
      }
    }

    if (rawPaths.length === 0) {
      return {
        success: false,
        output: 'coder.multi-read: provide at least one path or a globPattern.',
        data: { filesRead: 0, totalLines: 0, filesMissing: 0, paths: [] },
      };
    }

    // Deduplicate + limit
    const seen = new Set<string>();
    const dedupedPaths: string[] = [];
    for (const p of rawPaths) {
      const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(PROJECT_ROOT, p);
      if (!seen.has(abs)) {
        seen.add(abs);
        dedupedPaths.push(p);
      }
      if (dedupedPaths.length >= MAX_FILES) break;
    }

    const parts: string[] = [];
    let filesRead = 0;
    let filesMissing = 0;
    let totalLines = 0;

    for (const rawPath of dedupedPaths) {
      const result = readOneFile(rawPath, maxLines, showLineNumbers);
      parts.push(result);

      if (result.startsWith('⚠ NOT FOUND') || result.startsWith('⚠ BLOCKED')) {
        filesMissing++;
      } else if (!result.startsWith('⚠')) {
        filesRead++;
        // Count lines from content (rough)
        totalLines += result.split('\n').length;
      }
    }

    const skipped = rawPaths.length > MAX_FILES ? rawPaths.length - MAX_FILES : 0;
    const header = `Read ${filesRead} file(s)${filesMissing > 0 ? `, ${filesMissing} not found` : ''}${skipped > 0 ? `, ${skipped} skipped (limit ${MAX_FILES})` : ''}\n${'─'.repeat(60)}\n`;

    return {
      success: filesRead > 0,
      output: header + parts.join('\n\n'),
      data: {
        filesRead,
        totalLines,
        filesMissing,
        paths: dedupedPaths,
      },
    };
  },
};
