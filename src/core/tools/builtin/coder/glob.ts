/**
 * coder.glob — Fast recursive file pattern matching.
 * Uses Node 22's built-in node:fs glob API.
 * Falls back to a manual recursive walk if the built-in is unavailable.
 */

import { glob as nodeGlob, readdir, stat } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';

/**
 * Convert a glob pattern to a RegExp for simple fallback matching.
 * Handles * ** ? and character classes.
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000DSTAR\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000DSTAR\u0000/g, '.*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${escaped}$`);
}

async function walkDir(
  dir: string,
  ignorePatterns: RegExp[],
  results: string[],
  base: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (signal?.aborted) return;
    const fullPath = join(dir, entry);
    const relPath = relative(base, fullPath);
    const shouldIgnore = ignorePatterns.some((re) => re.test(relPath) || re.test(entry));
    if (shouldIgnore) continue;
    let s;
    try {
      s = await stat(fullPath);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      await walkDir(fullPath, ignorePatterns, results, base, signal);
    } else {
      results.push(relPath);
    }
  }
}

export const globTool: ToolDefinition = {
  name: 'coder.glob',
  description:
    'Find files matching a glob pattern. ALWAYS use this before editing — never guess file paths. ' +
    'Use to discover: all TypeScript files (**/*.ts), all tests (**/*.test.ts), all configs (**/*.json), ' +
    'all files in a module (src/core/tools/**/*), or a specific file by name (**/agent/loop.ts). ' +
    'Returns sorted relative paths. Run in parallel with coder.grep and coder.project-map during reconnaissance.',
  category: 'coder',
  timeout: 30_000,
  parameters: {
    pattern: {
      type: 'string',
      required: true,
      description: 'Glob pattern to match, e.g. "**/*.ts" or "src/**/*.{js,ts}".',
    },
    cwd: {
      type: 'string',
      required: false,
      description: 'Directory to search in. Defaults to the session working directory.',
    },
    ignore: {
      type: 'array',
      required: false,
      description: 'Array of glob patterns to exclude, e.g. ["node_modules/**", "dist/**"].',
      items: { type: 'string', description: 'Glob pattern to exclude.' },
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const log = ctx.logger as { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

    const pattern = params['pattern'];
    if (typeof pattern !== 'string' || pattern.trim() === '') {
      return { success: false, output: 'coder.glob: "pattern" parameter is required.' };
    }

    const searchDir = typeof params['cwd'] === 'string'
      ? resolve(ctx.workingDir, params['cwd'])
      : ctx.workingDir;

    const ignoreRaw = Array.isArray(params['ignore']) ? (params['ignore'] as unknown[]) : [];
    const ignorePatterns = ignoreRaw
      .filter((p): p is string => typeof p === 'string')
      .map(globToRegex);

    // Always ignore node_modules and .git by default.
    ignorePatterns.push(globToRegex('node_modules'), globToRegex('node_modules/**'));
    ignorePatterns.push(globToRegex('.git'), globToRegex('.git/**'));

    try {
      let files: string[] = [];

      // Attempt Node 22 built-in glob first.
      try {
        const gen = nodeGlob(pattern, {
          cwd: searchDir,
          exclude: (f: string | { name?: string }) => {
            const name = typeof f === 'string' ? f : (f.name ?? String(f));
            return ignorePatterns.some((re) => re.test(name));
          },
        } as Parameters<typeof nodeGlob>[1]);
        for await (const f of gen) {
          files.push(typeof f === 'string' ? f : (f as { path?: string }).path ?? String(f));
        }
      } catch (globErr) {
        // Fallback: recursive walk + pattern match.
        const patternRe = globToRegex(pattern);
        const rawResults: string[] = [];
        await walkDir(searchDir, ignorePatterns, rawResults, searchDir, ctx.signal);
        files = rawResults.filter((f) => patternRe.test(f));
      }

      files.sort();
      log.info({ tool: 'coder.glob', pattern, count: files.length }, 'Glob complete');

      const output = files.length > 0
        ? `Found ${files.length} file(s) matching "${pattern}":\n${files.join('\n')}`
        : `No files found matching "${pattern}" in ${searchDir}`;

      return {
        success: true,
        output,
        data: { pattern, cwd: searchDir, count: files.length, files },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ tool: 'coder.glob', pattern, err }, 'Glob failed');
      return { success: false, output: `coder.glob error: ${msg}` };
    }
  },
};

export default globTool;
