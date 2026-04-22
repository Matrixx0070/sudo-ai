/**
 * CodebaseAnalyzer — filesystem scan and regex-based issue detection.
 *
 * Pure analysis logic with no database dependency.
 * Used by CodeEvolver to keep that class under the 300-line limit.
 */

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { createLogger } from '../shared/logger.js';
import type { CodeAnalysis, CodeIssue } from './code-evolver.js';

const logger = createLogger('code-analyzer');

// ---------------------------------------------------------------------------
// Regex patterns (no external tools)
// ---------------------------------------------------------------------------

/** Hardcoded URLs, long tokens, or bare IPs. */
const HARDCODED_RE = /["'](https?:\/\/[^"']{10,}|[A-Za-z0-9_\-]{32,}|(?:\d{1,3}\.){3}\d{1,3}:\d{4,5})["']/;

/** Branch / loop keywords used for cyclomatic complexity estimation. */
const CONDITION_RE = /\b(if|else if|switch|case|while|for|catch)\b/g;

/** Detects try blocks — positive signal for error handling. */
const TRY_RE = /\btry\b/g;

/** throw statement or structured error return. */
const ERR_HANDLE_RE = /throw\s|return\s*\{\s*success:\s*false/g;

/** Function / method declarations (rough count). */
const FUNC_DECL_RE = /(?:function\s+\w+|(?:async\s+)?(?:\w+\s*\(|\(\s*\w))\s*(?:<[^>]*>)?\s*\(/g;

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/**
 * Recursively collect all files with the given extension.
 * Skips node_modules and hidden directories.
 */
export function collectFiles(dir: string, ext: string, results: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) {
        collectFiles(full, ext, results);
      } else if (extname(entry) === ext) {
        results.push(full);
      }
    } catch {
      /* skip unreadable entries */
    }
  }
  return results;
}

/**
 * Read a source file to string; returns empty string on error.
 */
export function readSource(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Complexity estimation
// ---------------------------------------------------------------------------

/**
 * Estimate cyclomatic complexity by counting decision keywords.
 */
export function estimateComplexity(src: string): number {
  const matches = src.match(CONDITION_RE);
  return matches ? matches.length : 0;
}

// ---------------------------------------------------------------------------
// Issue detection
// ---------------------------------------------------------------------------

/**
 * Detect code issues in a single file using regex heuristics.
 */
export function detectIssues(relFile: string, src: string, lines: number): CodeIssue[] {
  const issues: CodeIssue[] = [];

  // Large file
  if (lines > 300) {
    issues.push({
      type: 'large_file',
      severity: lines > 600 ? 'high' : 'medium',
      file: relFile,
      description: `File has ${lines} lines — exceeds 300-line limit`,
      suggestedFix: 'Split into focused modules under 300 lines each',
    });
  }

  // Hardcoded values — scan line by line for context
  const srcLines = src.split('\n');
  srcLines.forEach((line, idx) => {
    const trimmed = line.trimStart();
    if (
      HARDCODED_RE.test(line) &&
      !trimmed.startsWith('//') &&
      !trimmed.startsWith('*')
    ) {
      issues.push({
        type: 'hardcoded_value',
        severity: 'medium',
        file: relFile,
        line: idx + 1,
        description: `Possible hardcoded URL/token/IP at line ${idx + 1}`,
        suggestedFix: 'Move to config or environment variable',
      });
    }
  });

  // Missing error handling
  const funcCount = (src.match(FUNC_DECL_RE) ?? []).length;
  const tryCount = (src.match(TRY_RE) ?? []).length;
  const errCount = (src.match(ERR_HANDLE_RE) ?? []).length;
  if (funcCount > 3 && tryCount === 0 && errCount === 0) {
    issues.push({
      type: 'missing_error_handling',
      severity: 'high',
      file: relFile,
      description: `${funcCount} functions detected but no try/catch or error returns found`,
      suggestedFix: 'Add try/catch blocks and return { success: false } on errors',
    });
  }

  // Excessive `any` usage
  const anyCount = (src.match(/:\s*any\b/g) ?? []).length;
  if (anyCount > 2) {
    issues.push({
      type: 'missing_types',
      severity: 'medium',
      file: relFile,
      description: `Found ${anyCount} uses of 'any' type — weakens type safety`,
      suggestedFix: 'Replace with specific interfaces or generics',
    });
  }

  // High cyclomatic complexity
  const complexity = estimateComplexity(src);
  if (complexity > 20) {
    issues.push({
      type: 'complex_function',
      severity: 'medium',
      file: relFile,
      description: `Estimated cyclomatic complexity ${complexity} is high`,
      suggestedFix: 'Break into smaller focused functions',
    });
  }

  // Commented-out dead code blocks
  const commentedCodeLines = srcLines.filter(l => {
    const t = l.trimStart();
    return (t.startsWith('//') && /[;{}()]/.test(t)) ||
           (t.startsWith('/*') && lines > 10);
  }).length;
  if (commentedCodeLines > 5) {
    issues.push({
      type: 'dead_code',
      severity: 'low',
      file: relFile,
      description: `~${commentedCodeLines} lines appear to be commented-out code`,
      suggestedFix: 'Remove dead code — use git history to recover if needed',
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Full analysis pass
// ---------------------------------------------------------------------------

/**
 * Analyze all .ts files under rootDir.
 * Returns one CodeAnalysis per file with issue list and complexity score.
 */
export async function analyzeAll(rootDir: string): Promise<CodeAnalysis[]> {
  logger.info({ rootDir }, 'analyzeAll start');
  const files = collectFiles(rootDir, '.ts');
  const results: CodeAnalysis[] = [];

  for (const filePath of files) {
    try {
      const src = readSource(filePath);
      const lines = src.split('\n').length;
      const stat = statSync(filePath);
      const relFile = relative(rootDir, filePath);
      const issues = detectIssues(relFile, src, lines);
      const complexity = estimateComplexity(src);

      results.push({
        file: relFile,
        lines,
        issues,
        complexity,
        lastModified: stat.mtime.toISOString(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ filePath, err: msg }, 'analyzeAll: skipping file');
    }
  }

  logger.info({ fileCount: results.length }, 'analyzeAll complete');
  return results;
}
