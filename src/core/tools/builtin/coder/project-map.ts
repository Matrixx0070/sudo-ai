/**
 * coder.project-map — Comprehensive codebase structure and intelligence.
 *
 * Gives SUDO-AI instant understanding of where everything lives in the project
 * without manually exploring file by file. Essential first step before any
 * coding task.
 *
 * Actions:
 *   overview      — Directory tree + file counts + package.json summary
 *   exports       — All exported names from TypeScript files in a directory
 *   entry-points  — All main entry files (index.ts, cli.ts, main.ts, app.ts)
 *   dependencies  — Import graph for a specific file (what it imports + what imports it)
 *   large-files   — 20 largest TypeScript files (likely most complex)
 *   recent        — Files modified in the last N hours
 *   find-symbol   — Find where a class/function/interface/type is defined
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const logger = createLogger('coder.project-map');

const PROJECT_ROOT = '/root/sudo-ai-v4';
const SRC_DIR = path.join(PROJECT_ROOT, 'src');

function run(cmd: string, timeoutMs = 15_000): string {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      cwd: PROJECT_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    return ((e.stdout ?? '') + (e.stderr ?? '')).trim();
  }
}

function trim(s: string, max = 4000): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return s.slice(0, half) + '\n...[truncated]...\n' + s.slice(-half);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function doOverview(targetDir: string, depth: number): string {
  const dir = targetDir || SRC_DIR;

  // File count
  const fileCount = run(`find "${dir}" -type f -name "*.ts" ! -name "*.d.ts" 2>/dev/null | wc -l`);

  // Tree (prefer tree command, fallback to find)
  let tree = run(`tree -L ${depth} --dirsfirst -I "node_modules|dist|*.d.ts|*.js.map" "${dir}" 2>/dev/null`, 10_000);
  if (!tree || tree.startsWith('Command \'tree\'') || tree.startsWith('bash:')) {
    tree = run(`find "${dir}" -type d | head -50 | sed 's|${PROJECT_ROOT}/||g' | sort`);
  }

  // Package.json summary
  let pkgSummary = '';
  const pkgPath = path.join(PROJECT_ROOT, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
        name?: string; version?: string; scripts?: Record<string, string>;
        dependencies?: Record<string, string>; devDependencies?: Record<string, string>;
      };
      const scripts = Object.keys(pkg.scripts ?? {}).join(', ');
      const depCount = Object.keys(pkg.dependencies ?? {}).length;
      const devCount = Object.keys(pkg.devDependencies ?? {}).length;
      pkgSummary = `\npackage.json: ${pkg.name}@${pkg.version ?? '?'} | scripts: ${scripts} | ${depCount} deps, ${devCount} devDeps`;
    } catch { /* ignore */ }
  }

  return `Project Overview — ${path.relative(PROJECT_ROOT, dir) || 'root'}
${'─'.repeat(50)}
TypeScript files: ${fileCount.trim()}
${pkgSummary}

Directory tree (depth ${depth}):
${tree}`;
}

function doExports(targetDir: string): string {
  const dir = targetDir || SRC_DIR;
  const result = run(
    `grep -rn "^export " "${dir}" --include="*.ts" ! --include="*.d.ts" 2>/dev/null | head -150`,
    10_000,
  );
  if (!result) return `No exports found in ${path.relative(PROJECT_ROOT, dir)}`;

  // Group by file
  const byFile: Record<string, string[]> = {};
  for (const line of result.split('\n')) {
    const m = /^([^:]+):(\d+):(export .+)$/.exec(line);
    if (!m) continue;
    const [, file, , exportLine] = m;
    if (!file || !exportLine) continue;
    const rel = file.replace(PROJECT_ROOT + '/', '');
    if (!byFile[rel]) byFile[rel] = [];
    byFile[rel].push(exportLine.trim());
  }

  const lines: string[] = [`Exports in ${path.relative(PROJECT_ROOT, dir)}:\n`];
  for (const [file, exports] of Object.entries(byFile)) {
    lines.push(`${file}:`);
    for (const exp of exports) lines.push(`  ${exp}`);
    lines.push('');
  }
  return trim(lines.join('\n'));
}

function doEntryPoints(): string {
  const result = run(
    `find "${PROJECT_ROOT}/src" -name "index.ts" -o -name "cli.ts" -o -name "main.ts" -o -name "app.ts" 2>/dev/null | head -20`,
  );
  if (!result) return 'No entry point files found.';

  const parts: string[] = ['Entry point files:\n'];
  for (const file of result.split('\n').filter(Boolean)) {
    const rel = file.replace(PROJECT_ROOT + '/', '');
    parts.push(`── ${rel}`);
    try {
      const content = readFileSync(file, 'utf-8');
      const preview = content.split('\n').slice(0, 8).join('\n');
      parts.push(preview.split('\n').map(l => '   ' + l).join('\n'));
    } catch { /* ignore */ }
    parts.push('');
  }
  return trim(parts.join('\n'));
}

function doDependencies(filePath: string): string {
  if (!filePath) return 'coder.project-map: "file" parameter required for dependencies action.';

  const abs = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(PROJECT_ROOT, filePath);

  if (!existsSync(abs)) return `File not found: ${filePath}`;

  const content = readFileSync(abs, 'utf-8');
  const rel = abs.replace(PROJECT_ROOT + '/', '');

  // What this file imports
  const importMatches = [...content.matchAll(/^import\s.*?\sfrom\s+['"]([^'"]+)['"]/gm)];
  const imports = importMatches.map(m => m[1]).filter(Boolean);

  // What imports this file (by filename stem)
  const stem = path.basename(abs, '.ts');
  const whoImports = run(
    `grep -rn "from.*['\"].*${stem}['\"]\\|require.*['\"].*${stem}['\"]" "${SRC_DIR}" --include="*.ts" 2>/dev/null | grep -v "^${rel}:" | head -30`,
    10_000,
  );

  const parts = [
    `Dependencies map for: ${rel}\n`,
    `This file imports (${imports.length}):`,
    ...imports.map(i => `  ${i}`),
    '',
    `Files that import this file:`,
    whoImports || '  (none found)',
  ];
  return parts.join('\n');
}

function doLargeFiles(targetDir: string): string {
  const dir = targetDir || SRC_DIR;
  const result = run(
    `find "${dir}" -name "*.ts" ! -name "*.d.ts" ! -name "*.test.ts" -exec wc -l {} \\; 2>/dev/null | sort -rn | head -20`,
    15_000,
  );
  if (!result) return 'No TypeScript files found.';

  const lines = result.split('\n').filter(l => l.trim() && !l.includes('total'));
  const formatted = lines.map(l => {
    const m = /^\s*(\d+)\s+(.+)$/.exec(l);
    if (!m) return l;
    const [, count, file] = m;
    return `${String(count).padStart(5)} lines  ${file?.replace(PROJECT_ROOT + '/', '') ?? file}`;
  });

  return `20 largest TypeScript files in ${path.relative(PROJECT_ROOT, dir) || 'src'}:\n\n${formatted.join('\n')}`;
}

function doRecent(targetDir: string, hours: number): string {
  const dir = targetDir || SRC_DIR;
  const mins = Math.ceil(hours * 60);
  const result = run(
    `find "${dir}" -name "*.ts" ! -name "*.d.ts" -mmin -${mins} 2>/dev/null | head -30`,
    10_000,
  );
  if (!result) return `No TypeScript files modified in the last ${hours}h.`;

  const files = result.split('\n').filter(Boolean).map(f => f.replace(PROJECT_ROOT + '/', ''));
  return `Files modified in the last ${hours}h (${files.length}):\n\n${files.join('\n')}`;
}

function doFindSymbol(symbol: string, targetDir: string): string {
  if (!symbol) return 'coder.project-map: "symbol" parameter required for find-symbol action.';
  const dir = targetDir || SRC_DIR;
  const safe = symbol.replace(/[`$(){}!|;&]/g, '');

  // Search for definition patterns: export class Foo, export function foo, export interface Foo, export type Foo
  const result = run(
    `grep -rn "\\(export\\s\\+\\(class\\|function\\|interface\\|type\\|const\\|enum\\)\\s\\+${safe}\\|export.*{.*${safe}.*}\\)" "${dir}" --include="*.ts" 2>/dev/null | head -20`,
    10_000,
  );
  if (!result) {
    // Fallback: just grep for the name
    const fallback = run(
      `grep -rn "${safe}" "${dir}" --include="*.ts" 2>/dev/null | grep -E "^[^:]+:[0-9]+:(export|class|interface|type|function|const)" | head -15`,
      10_000,
    );
    if (!fallback) return `Symbol "${symbol}" not found in ${path.relative(PROJECT_ROOT, dir)}`;
    return `Definition(s) of "${symbol}":\n\n${fallback.split('\n').map(l => '  ' + l.replace(PROJECT_ROOT + '/', '')).join('\n')}`;
  }

  return `Definition(s) of "${symbol}":\n\n${result.split('\n').map(l => '  ' + l.replace(PROJECT_ROOT + '/', '')).join('\n')}`;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const projectMapTool: ToolDefinition = {
  name: 'coder.project-map',
  description:
    'Generate a comprehensive map of the codebase structure and intelligence. ' +
    'Shows directory tree, exported symbols, entry points, import dependencies, ' +
    'largest files, and recently changed files. ' +
    'Use at the start of any coding task to understand where everything lives. ' +
    'Actions: overview, exports, entry-points, dependencies, large-files, recent, find-symbol.',
  category: 'coder',
  timeout: 30_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'What to show.',
      enum: ['overview', 'exports', 'entry-points', 'dependencies', 'large-files', 'recent', 'find-symbol'],
    },
    directory: {
      type: 'string',
      required: false,
      description:
        'Subdirectory to focus on — absolute or relative to /root/sudo-ai-v4/. ' +
        'Default: entire src/. Example: "src/core/tools/builtin/coder".',
    },
    file: {
      type: 'string',
      required: false,
      description: 'File path for "dependencies" action.',
    },
    symbol: {
      type: 'string',
      required: false,
      description: 'Symbol name (class/function/interface/type) for "find-symbol" action.',
    },
    hours: {
      type: 'number',
      required: false,
      description: 'Hours look-back for "recent" action. Default: 24.',
    },
    depth: {
      type: 'number',
      required: false,
      description: 'Tree depth for "overview". Default: 3.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    logger.info({ session: ctx.sessionId, action }, 'coder.project-map invoked');

    const rawDir = typeof params['directory'] === 'string' ? params['directory'].trim() : '';
    const targetDir = rawDir
      ? (path.isAbsolute(rawDir) ? path.resolve(rawDir) : path.resolve(PROJECT_ROOT, rawDir))
      : SRC_DIR;

    // Security check
    if (!targetDir.startsWith(PROJECT_ROOT)) {
      return { success: false, output: `Path traversal blocked: ${rawDir}` };
    }

    const depth = typeof params['depth'] === 'number' ? Math.min(Math.max(1, params['depth']), 6) : 3;
    const hours = typeof params['hours'] === 'number' ? params['hours'] : 24;

    try {
      let output: string;

      switch (action) {
        case 'overview':
          output = doOverview(targetDir, depth);
          break;
        case 'exports':
          output = doExports(targetDir);
          break;
        case 'entry-points':
          output = doEntryPoints();
          break;
        case 'dependencies':
          output = doDependencies((params['file'] as string | undefined) ?? '');
          break;
        case 'large-files':
          output = doLargeFiles(targetDir);
          break;
        case 'recent':
          output = doRecent(targetDir, hours);
          break;
        case 'find-symbol':
          output = doFindSymbol((params['symbol'] as string | undefined) ?? '', targetDir);
          break;
        default:
          return { success: false, output: `Unknown action: ${action}` };
      }

      return { success: true, output, data: { action, targetDir } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'coder.project-map error');
      return { success: false, output: `coder.project-map error: ${msg}` };
    }
  },
};
