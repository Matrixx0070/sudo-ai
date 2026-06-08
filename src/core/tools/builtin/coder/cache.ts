/**
 * coder.cache — Project symbol index and analysis cache.
 *
 * Builds a fast lookup index of all exports, imports, and symbols across the
 * codebase. Use "build" to index (run once, ~10s). Use "find" to locate any
 * symbol in milliseconds. Use "deps" for the dependency graph of a file. Use
 * "stats" for project-wide metrics. Use "clear" to delete the cache.
 */

import {
  readFileSync, writeFileSync, existsSync,
  mkdirSync, unlinkSync, statSync,
} from 'node:fs';
import { readdir } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { PROJECT_ROOT } from '../../../shared/paths.js';

const logger = createLogger('coder.cache');
const CACHE_PATH = path.join(PROJECT_ROOT, 'data', 'coder-cache.json');

// ---------------------------------------------------------------------------
// Cache structure
// ---------------------------------------------------------------------------

interface CoderCache {
  builtAt: string;
  fileCount: number;
  totalLines: number;
  symbols: Record<string, string[]>;  // symbolName -> [filePaths]
  imports: Record<string, string[]>;  // filePath -> [imported from paths]
  exports: Record<string, string[]>;  // filePath -> [exported names]
  fileHashes: Record<string, string>; // filePath -> content.slice(0,32)
}

// ---------------------------------------------------------------------------
// Cache I/O helpers
// ---------------------------------------------------------------------------

function loadCache(): CoderCache {
  if (!existsSync(CACHE_PATH)) {
    throw new Error('Cache not built. Run: coder.cache action:"build" first.');
  }
  try {
    const raw = readFileSync(CACHE_PATH, 'utf-8');
    return JSON.parse(raw) as CoderCache;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Cache file corrupt — rebuild with action:"build". Error: ${msg}`);
  }
}

function saveCache(cache: CoderCache): void {
  const dir = path.dirname(CACHE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', 'coverage', '.next', '.turbo']);
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);

async function walkSourceFiles(dir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(d: string): Promise<void> {
    let entries: string[];
    try { entries = await readdir(d); } catch { return; }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = path.join(d, entry);
      let s;
      try { s = statSync(full); } catch { continue; }
      if (s.isDirectory()) { await walk(full); continue; }
      if (SOURCE_EXTS.has(path.extname(entry).toLowerCase())) {
        if (s.size <= 500_000) results.push(full);
      }
    }
  }

  await walk(dir);
  return results;
}

// ---------------------------------------------------------------------------
// Symbol/import extraction
// ---------------------------------------------------------------------------

const EXPORT_REGEX = /^export\s+(?:(?:default\s+)?(?:class|function|const|let|var|type|interface|enum)\s+)(\w+)/gm;
const IMPORT_REGEX = /^import\s+.*?from\s+['"]([^'"]+)['"]/gm;

function extractExports(content: string): string[] {
  const names: string[] = [];
  const regex = new RegExp(EXPORT_REGEX.source, EXPORT_REGEX.flags);
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    if (m[1]) names.push(m[1]);
  }
  return names;
}

function extractImports(content: string): string[] {
  const paths: string[] = [];
  const regex = new RegExp(IMPORT_REGEX.source, IMPORT_REGEX.flags);
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    if (m[1]) paths.push(m[1]);
  }
  return paths;
}

// ---------------------------------------------------------------------------
// action: build
// ---------------------------------------------------------------------------

async function buildCache(): Promise<string> {
  const startMs = Date.now();
  const srcDir = path.join(PROJECT_ROOT, 'src');

  logger.info('coder.cache: building index...');

  const files = await walkSourceFiles(srcDir);
  const cache: CoderCache = {
    builtAt: new Date().toISOString(),
    fileCount: 0,
    totalLines: 0,
    symbols: {},
    imports: {},
    exports: {},
    fileHashes: {},
  };

  for (const abs of files) {
    let content: string;
    try { content = readFileSync(abs, 'utf-8'); } catch { continue; }

    const rel = path.relative(PROJECT_ROOT, abs);
    const lines = content.split('\n').length;
    cache.totalLines += lines;
    cache.fileHashes[rel] = content.slice(0, 32);

    const exportedNames = extractExports(content);
    cache.exports[rel] = exportedNames;

    for (const name of exportedNames) {
      if (!cache.symbols[name]) cache.symbols[name] = [];
      cache.symbols[name].push(rel);
    }

    const importedPaths = extractImports(content);
    cache.imports[rel] = importedPaths;
  }

  cache.fileCount = files.length;
  saveCache(cache);

  const tookMs = Date.now() - startMs;
  const symbolCount = Object.keys(cache.symbols).length;

  logger.info({ files: cache.fileCount, symbols: symbolCount, tookMs }, 'coder.cache: built');
  return `Built index: ${cache.fileCount} files, ${symbolCount} symbols, ${cache.totalLines.toLocaleString()} lines, took ${tookMs}ms`;
}

// ---------------------------------------------------------------------------
// action: find
// ---------------------------------------------------------------------------

function findSymbol(symbol: string): string {
  const cache = loadCache();
  const files = cache.symbols[symbol];

  const lines: string[] = [
    `Symbol: "${symbol}"`,
    `Cache built: ${cache.builtAt}`,
    '',
  ];

  if (!files || files.length === 0) {
    lines.push(`Not found in index. Try rebuilding: coder.cache action:"build"`);
  } else {
    lines.push(`Found in ${files.length} file(s):`);
    for (const f of files) {
      lines.push(`  - ${f}`);
    }
  }

  // Also run rg for line numbers
  lines.push('');
  lines.push('Live search (with line numbers):');
  try {
    const rgOut = execSync(
      `rg -n "export.*${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" "${path.join(PROJECT_ROOT, 'src')}"`,
      { encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }
    ).trim();
    if (rgOut) {
      for (const line of rgOut.split('\n').slice(0, 20)) {
        lines.push(`  ${line}`);
      }
    } else {
      lines.push('  (no live matches)');
    }
  } catch {
    lines.push('  (rg not available or no matches)');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// action: deps
// ---------------------------------------------------------------------------

function getDeps(file: string): string {
  const cache = loadCache();

  // Normalize: accept absolute or relative
  const rel = file.startsWith(PROJECT_ROOT)
    ? path.relative(PROJECT_ROOT, file)
    : file.replace(/^\.\//, '');

  const lines: string[] = [
    `Dependency graph for: ${rel}`,
    `Cache built: ${cache.builtAt}`,
    '',
  ];

  // What this file imports
  const imported = cache.imports[rel];
  if (imported && imported.length > 0) {
    lines.push(`Imports (${imported.length}):`);
    for (const imp of imported) lines.push(`  - ${imp}`);
  } else {
    lines.push('Imports: none found (or file not indexed)');
  }

  lines.push('');

  // What files import THIS file
  const fileBase = rel.replace(/\.(ts|tsx|js|jsx|mjs)$/, '');
  const importedBy: string[] = [];
  for (const [f, imps] of Object.entries(cache.imports)) {
    for (const imp of imps) {
      // Match by basename or path fragment
      if (imp.includes(fileBase) || imp.endsWith(path.basename(fileBase))) {
        importedBy.push(f);
        break;
      }
    }
  }

  if (importedBy.length > 0) {
    lines.push(`Imported by (${importedBy.length}):`);
    for (const f of importedBy.slice(0, 30)) lines.push(`  - ${f}`);
    if (importedBy.length > 30) lines.push(`  ... and ${importedBy.length - 30} more`);
  } else {
    lines.push('Imported by: none found');
  }

  // Exports from this file
  const exported = cache.exports[rel];
  if (exported && exported.length > 0) {
    lines.push('');
    lines.push(`Exports (${exported.length}): ${exported.join(', ')}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// action: stats
// ---------------------------------------------------------------------------

function getStats(): string {
  const cache = loadCache();
  const symbolCount = Object.keys(cache.symbols).length;

  // Most exported files (by number of exports)
  const exportCounts = Object.entries(cache.exports)
    .map(([f, exps]) => ({ file: f, count: exps.length }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const lines: string[] = [
    `## Project Index Stats`,
    `Built: ${cache.builtAt}`,
    '',
    `Files indexed:   ${cache.fileCount}`,
    `Total lines:     ${cache.totalLines.toLocaleString()}`,
    `Unique symbols:  ${symbolCount}`,
    '',
    '## Most Exported Files (top 10)',
  ];

  for (const { file, count } of exportCounts) {
    lines.push(`  ${count.toString().padStart(4)} exports  ${file}`);
  }

  lines.push('');
  lines.push('## Sample Symbols (first 20)');
  const sampleSymbols = Object.keys(cache.symbols).slice(0, 20);
  lines.push(`  ${sampleSymbols.join(', ')}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// action: clear
// ---------------------------------------------------------------------------

function clearCache(): string {
  if (!existsSync(CACHE_PATH)) {
    return 'Cache does not exist — nothing to clear.';
  }
  try {
    unlinkSync(CACHE_PATH);
    return 'Cache cleared successfully.';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Failed to clear cache: ${msg}`;
  }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const cacheTool: ToolDefinition = {
  name: 'coder.cache',
  description:
    'Project symbol index and analysis cache. Builds a fast lookup index of all exports, imports, and ' +
    'symbols across the codebase. Use "build" to index the project (run once, takes ~10s). Use "find" to ' +
    'instantly locate any symbol (function/class/interface/type) in milliseconds. Use "deps" to get the ' +
    'dependency graph for a file. Use "stats" for project-wide metrics. Much faster than coder.glob + ' +
    'coder.grep for symbol lookups.',
  category: 'coder',
  timeout: 60_000,

  parameters: {
    action: {
      type: 'string',
      required: true,
      enum: ['build', 'find', 'deps', 'stats', 'clear'],
      description: 'Action to perform.',
    },
    symbol: {
      type: 'string',
      description: 'Symbol name to find (for action="find").',
    },
    file: {
      type: 'string',
      description: 'File to get dependency graph for (for action="deps").',
    },
  },

  async execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const action = typeof params['action'] === 'string' ? params['action'] : '';
    const symbol = typeof params['symbol'] === 'string' ? params['symbol'].trim() : '';
    const file   = typeof params['file']   === 'string' ? params['file'].trim()   : '';

    logger.info({ action, symbol, file }, 'coder.cache invoked');

    try {
      switch (action) {
        case 'build': {
          const result = await buildCache();
          return { success: true, output: result };
        }

        case 'find': {
          if (!symbol) return { success: false, output: 'coder.cache: "symbol" is required for action="find".' };
          const result = findSymbol(symbol);
          return { success: true, output: result };
        }

        case 'deps': {
          if (!file) return { success: false, output: 'coder.cache: "file" is required for action="deps".' };
          const result = getDeps(file);
          return { success: true, output: result };
        }

        case 'stats': {
          const result = getStats();
          return { success: true, output: result };
        }

        case 'clear': {
          const result = clearCache();
          return { success: true, output: result };
        }

        default:
          return { success: false, output: `coder.cache: Unknown action "${action}". Use: build, find, deps, stats, clear.` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'coder.cache: error');
      return { success: false, output: `coder.cache error: ${msg}` };
    }
  },
};
