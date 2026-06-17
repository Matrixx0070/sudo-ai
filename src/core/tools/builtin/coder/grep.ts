/**
 * coder.grep — Content search with regex support.
 * Tries ripgrep (rg) first for speed, falls back to pure-JS search.
 * Never uses shell string interpolation — all args are passed as arrays.
 */

import { execFile as execFileCb } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { resolve, join, relative } from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';

const execFile = promisify(execFileCb);

interface GrepMatch {
  file: string;
  line: number;
  column: number;
  text: string;
  contextBefore: string[];
  contextAfter: string[];
}

async function rgSearch(
  pattern: string,
  searchPath: string,
  include: string | undefined,
  exclude: string | undefined,
  contextLines: number,
  maxResults: number,
  signal?: AbortSignal,
): Promise<GrepMatch[]> {
  const args: string[] = [
    '--json',
    '--max-count', String(maxResults),
    '--context', String(contextLines),
    pattern,
    searchPath,
  ];
  if (include) args.push('--glob', include);
  if (exclude) args.push('--glob', `!${exclude}`);

  const { stdout } = await execFile('rg', args, { signal, maxBuffer: 10 * 1024 * 1024 });

  const matches: GrepMatch[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if ((obj['type'] as string) === 'match') {
        const data = obj['data'] as Record<string, unknown>;
        const path = (data['path'] as Record<string, unknown>)['text'] as string;
        const lineNumber = (data['line_number'] as number) ?? 0;
        const text = ((data['lines'] as Record<string, unknown>)['text'] as string ?? '').replace(/\n$/, '');
        const submatches = data['submatches'] as Array<Record<string, unknown>>;
        const col = submatches?.[0] ? ((submatches[0]['start'] as number) + 1) : 1;
        matches.push({ file: path, line: lineNumber, column: col, text, contextBefore: [], contextAfter: [] });
      }
    } catch {
      // skip malformed JSON lines
    }
  }
  return matches;
}

async function jsSearch(
  pattern: string,
  searchPath: string,
  contextLines: number,
  maxResults: number,
  signal?: AbortSignal,
): Promise<GrepMatch[]> {
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'g');
  } catch {
    throw new Error(`Invalid regex pattern: ${pattern}`);
  }

  const matches: GrepMatch[] = [];
  const filesToSearch: string[] = [];

  async function collectFiles(dir: string): Promise<void> {
    if (signal?.aborted) return;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch { return; }
    for (const entry of entries) {
      if (signal?.aborted) return;
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
      const fullPath = join(dir, entry);
      let s;
      try { s = await stat(fullPath); } catch { continue; }
      if (s.isDirectory()) {
        await collectFiles(fullPath);
      } else {
        filesToSearch.push(fullPath);
      }
    }
  }

  const s = await stat(searchPath);
  if (s.isFile()) {
    filesToSearch.push(searchPath);
  } else {
    await collectFiles(searchPath);
  }

  outer: for (const filePath of filesToSearch) {
    if (signal?.aborted) break;
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch { continue; }

    const lines = content.split('\n');
    re.lastIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= maxResults) break outer;
      const lineText = lines[i] ?? '';
      re.lastIndex = 0;
      const m = re.exec(lineText);
      if (m) {
        const contextBefore = lines.slice(Math.max(0, i - contextLines), i);
        const contextAfter = lines.slice(i + 1, i + 1 + contextLines);
        matches.push({
          file: relative(searchPath, filePath),
          line: i + 1,
          column: m.index + 1,
          text: lineText,
          contextBefore,
          contextAfter,
        });
      }
    }
  }
  return matches;
}

function formatMatches(matches: GrepMatch[]): string {
  if (matches.length === 0) return 'No matches found.';
  const parts: string[] = [];
  for (const m of matches) {
    if (m.contextBefore.length > 0) {
      for (let i = 0; i < m.contextBefore.length; i++) {
        const ln = m.line - m.contextBefore.length + i;
        parts.push(`${m.file}:${ln}-  ${m.contextBefore[i]}`);
      }
    }
    parts.push(`${m.file}:${m.line}:${m.column}  ${m.text}`);
    for (let i = 0; i < m.contextAfter.length; i++) {
      parts.push(`${m.file}:${m.line + 1 + i}-  ${m.contextAfter[i]}`);
    }
    if (m.contextBefore.length > 0 || m.contextAfter.length > 0) parts.push('--');
  }
  return parts.join('\n');
}

export const grepTool: ToolDefinition = {
  name: 'coder.grep',
  description:
    'Search file contents using a regex pattern. Uses ripgrep for maximum speed. ' +
    'MANDATORY before any edit: use to find all usages, imports, callers, and type definitions. ' +
    'Use BEFORE editing to understand impact. Use AFTER editing to confirm changes propagated. ' +
    'Power patterns: find all usages of a function, find all imports of a module, ' +
    'find hardcoded secrets (password|api_key|secret), find all TODOs, find error patterns. ' +
    'Returns file:line:column with context lines.',
  category: 'coder',
  timeout: 60_000,
  parameters: {
    pattern: {
      type: 'string',
      required: true,
      description: 'Regex pattern to search for.',
    },
    path: {
      type: 'string',
      required: false,
      description: 'File or directory to search. Defaults to session working directory.',
    },
    include: {
      type: 'string',
      required: false,
      description: 'Glob pattern to restrict search to matching files, e.g. "*.ts".',
    },
    exclude: {
      type: 'string',
      required: false,
      description: 'Glob pattern to exclude files from search.',
    },
    contextLines: {
      type: 'number',
      required: false,
      default: 0,
      description: 'Number of context lines before and after each match (like grep -C).',
    },
    maxResults: {
      type: 'number',
      required: false,
      default: 50,
      description: 'Maximum number of matches to return. Defaults to 50.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const log = ctx.logger as { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

    const pattern = params['pattern'];
    if (typeof pattern !== 'string' || pattern.trim() === '') {
      return { success: false, output: 'coder.grep: "pattern" parameter is required.' };
    }

    // searchPath resolution:
    //  - No path param → search ctx.workingDir directly (existing behaviour).
    //  - Path provided → resolve against ctx.workingDir first.
    //  - Fallback: if the workingDir is a workspace session sandbox and the
    //    resolved path doesn't exist there, retry against the host project
    //    root. Mirrors the #223 coder.read-file fix — without this, every
    //    bot attempt to grep host source from inside the sandbox hits
    //    ENOENT and the call falls through to the catch (level:50 "Grep
    //    failed", observed live 2026-06-17 01:12).
    const rawPath = params['path'];
    let searchPath: string;
    if (typeof rawPath !== 'string') {
      searchPath = ctx.workingDir;
    } else {
      searchPath = resolve(ctx.workingDir, rawPath);
      try {
        await stat(searchPath);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        const inSandbox = /\/workspace\/sessions\//.test(ctx.workingDir);
        if (code === 'ENOENT' && inSandbox) {
          const projectRoot = ctx.workingDir.replace(/\/workspace\/sessions\/.*/, '');
          const fallback = resolve(projectRoot, rawPath);
          try {
            await stat(fallback);
            searchPath = fallback;
          } catch {
            // Fallback also missing — keep the original path so the
            // downstream stat() emits the same error users would have
            // seen before, no behaviour change for genuinely-missing paths.
          }
        }
      }
    }
    const include = typeof params['include'] === 'string' ? params['include'] : undefined;
    const exclude = typeof params['exclude'] === 'string' ? params['exclude'] : undefined;
    const contextLines = typeof params['contextLines'] === 'number' ? Math.max(0, params['contextLines']) : 0;
    const maxResults = typeof params['maxResults'] === 'number' ? Math.max(1, params['maxResults']) : 50;

    try {
      let matches: GrepMatch[];
      let engine = 'ripgrep';

      try {
        matches = await rgSearch(pattern, searchPath, include, exclude, contextLines, maxResults, ctx.signal);
      } catch (rgErr) {
        // rg not found or failed — fall back to JS
        engine = 'js';
        matches = await jsSearch(pattern, searchPath, contextLines, maxResults, ctx.signal);
      }

      log.info({ tool: 'coder.grep', pattern, count: matches.length, engine }, 'Grep complete');

      const truncated = matches.length >= maxResults;
      const header = `${matches.length} match(es) for /${pattern}/ in ${searchPath} [engine: ${engine}]${truncated ? ` (limit: ${maxResults})` : ''}`;

      return {
        success: true,
        output: `${header}\n${'─'.repeat(60)}\n${formatMatches(matches)}`,
        data: { pattern, searchPath, count: matches.length, engine, truncated, matches },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ tool: 'coder.grep', pattern, err }, 'Grep failed');
      return { success: false, output: `coder.grep error: ${msg}` };
    }
  },
};

export default grepTool;
