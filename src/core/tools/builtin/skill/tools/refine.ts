/**
 * @file skill/tools/refine.ts
 * @description skill.refine — generates a structured refinement proposal for a
 * given tool by querying the audit log for mistake patterns that mention the
 * tool's name or category. Dry-run by default; dryRun=false logs intent to
 * invoke meta.self-modify but does NOT patch in this wave.
 *
 * All cross-module deps are duck-typed (no direct import from cognition/).
 * Fails open when the tool source file is not discoverable.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../../../shared/logger.js';
import { DATA_DIR } from '../../../../shared/paths.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';

const logger = createLogger('skill:refine');

// ---------------------------------------------------------------------------
// DB duck-types (same as usage-stats — no shared import needed)
// ---------------------------------------------------------------------------

interface DbLike {
  prepare(sql: string): { all(...args: unknown[]): unknown[] };
  close(): void;
}

type DbConstructorFn = new (path: string, opts?: Record<string, unknown>) => DbLike;

function openReadonly(dbPath: string): DbLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Ctor = require('better-sqlite3') as DbConstructorFn;
    return new Ctor(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RefinementIssue {
  pattern: string;
  occurrences: number;
  suggestion: string;
}

export interface RefinementProposal {
  toolName: string;
  issues: RefinementIssue[];
  proposedPatchHints: string[];
  sourceFileFound: boolean;
  sourceFilePath: string | null;
  dryRun: boolean;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AUDIT_DB = path.join(DATA_DIR, 'audit.db');
const SRC_BASE = path.resolve('src/core/tools/builtin');

interface AuditMistakeRow {
  resource: string;
  metadata_json: string | null;
}

/** Query audit_log for mistake rows that mention toolName. */
function queryMistakePatterns(toolName: string): RefinementIssue[] {
  const db = openReadonly(AUDIT_DB);
  if (!db) return [];

  // Extract category from dotted name e.g. "skill.refine" → "skill"
  const category = toolName.includes('.') ? toolName.split('.')[0]! : toolName;

  try {
    const rows = db.prepare(
      `SELECT resource, metadata_json FROM audit_log
       WHERE action = 'commitment'
         AND (resource LIKE ? OR resource LIKE ?)
       ORDER BY timestamp DESC LIMIT 100`
    ).all(`%${toolName}%`, `%${category}%`) as AuditMistakeRow[];

    // Also scan metadata_json for toolName mentions
    const allRows = db.prepare(
      `SELECT resource, metadata_json FROM audit_log
       WHERE action = 'commitment' AND metadata_json LIKE ?
       ORDER BY timestamp DESC LIMIT 100`
    ).all(`%${toolName}%`) as AuditMistakeRow[];

    const combined = [...rows, ...allRows];

    // Aggregate patterns by normalized mistake text
    const patternCounts = new Map<string, number>();
    for (const row of combined) {
      if (!row.metadata_json) continue;
      try {
        const meta = JSON.parse(row.metadata_json) as Record<string, unknown>;
        const mistake = typeof meta['mistake'] === 'string' ? meta['mistake'] : null;
        if (!mistake) continue;
        const key = mistake.slice(0, 120).toLowerCase().replace(/\s+/g, ' ').trim();
        patternCounts.set(key, (patternCounts.get(key) ?? 0) + 1);
      } catch { /* skip */ }
    }

    const issues: RefinementIssue[] = [];
    for (const [pattern, occurrences] of patternCounts.entries()) {
      issues.push({
        pattern,
        occurrences,
        suggestion: derivesuggestion(pattern),
      });
    }

    // Sort by occurrences desc, cap at 10
    issues.sort((a, b) => b.occurrences - a.occurrences);
    return issues.slice(0, 10);
  } catch (err) {
    logger.warn({ err: String(err) }, 'skill.refine: mistake pattern query failed');
    return [];
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/** Derive a human-readable suggestion from a mistake pattern. */
function derivesuggestion(pattern: string): string {
  if (/timeout|timed out/.test(pattern)) return 'Consider increasing timeout or adding retry logic.';
  if (/not found|missing|no such/.test(pattern)) return 'Add existence checks before accessing resources.';
  if (/permission|forbidden|unauthori/.test(pattern)) return 'Validate permissions before executing.';
  if (/invalid|malformed|parse/.test(pattern)) return 'Strengthen input validation and add schema checks.';
  if (/network|connect|fetch/.test(pattern)) return 'Add retry with exponential backoff for network calls.';
  return 'Review and add additional error handling for this failure mode.';
}

/** Try to discover the source file for a tool by convention. */
function discoverSourceFile(toolName: string): { found: boolean; filePath: string | null } {
  if (!toolName.includes('.')) return { found: false, filePath: null };
  const [category, ...rest] = toolName.split('.');
  const action = rest.join('-');

  // Check: builtin/<category>/tools/<action>.ts (newer pattern)
  const withToolsDir = path.join(SRC_BASE, category!, 'tools', `${action}.ts`);
  if (existsSync(withToolsDir)) return { found: true, filePath: withToolsDir };

  // Check: builtin/<category>/<action>.ts (flat pattern)
  const flat = path.join(SRC_BASE, category!, `${action}.ts`);
  if (existsSync(flat)) return { found: true, filePath: flat };

  // Check: builtin/<category>/index.ts (single-file category)
  const idx = path.join(SRC_BASE, category!, 'index.ts');
  if (existsSync(idx)) return { found: true, filePath: idx };

  return { found: false, filePath: null };
}

/** Generate patch hints from discovered source content + issues. */
function buildPatchHints(issues: RefinementIssue[], source: string | null): string[] {
  const hints: string[] = [];
  if (issues.length === 0) {
    hints.push('No recurring mistake patterns detected — tool appears healthy.');
    return hints;
  }
  for (const issue of issues.slice(0, 3)) {
    hints.push(`[Pattern: "${issue.pattern.slice(0, 60)}..."] → ${issue.suggestion}`);
  }
  if (source) {
    const lines = source.split('\n').length;
    if (lines > 250) {
      hints.push(`Source is ${lines} lines — consider splitting into smaller modules.`);
    }
    if (!source.includes('try {')) {
      hints.push('Source has no try/catch blocks — add error handling.');
    }
  }
  return hints;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const refineTool: ToolDefinition = {
  name: 'skill.refine',
  description:
    'Generate a structured refinement proposal for a tool by scanning mistake patterns from the audit log. Returns issues, suggestions, and patch hints. dryRun=true (default) only generates the proposal; dryRun=false logs intent to self-patch.',
  category: 'skill' as import('../../../types.js').ToolCategory,
  timeout: 15_000,
  parameters: {
    toolName: {
      type: 'string',
      required: true,
      description: 'Dot-namespaced tool name to analyze (e.g. "browser.navigate").',
    },
    dryRun: {
      type: 'boolean',
      description: 'When false, logs a self-modify intent (no actual patching in this wave). Default: true.',
      default: true,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const toolName = params['toolName'] as string | undefined;
    const dryRun = params['dryRun'] !== false;

    logger.info({ session: ctx.sessionId, toolName, dryRun }, 'skill.refine invoked');

    if (!toolName?.trim()) {
      return { success: false, output: 'toolName is required.' };
    }

    try {
      const issues = queryMistakePatterns(toolName);
      const { found, filePath } = discoverSourceFile(toolName);

      let source: string | null = null;
      if (found && filePath) {
        try { source = readFileSync(filePath, 'utf8'); } catch { /* ignore */ }
      }

      const patchHints = buildPatchHints(issues, source);

      const proposal: RefinementProposal = {
        toolName,
        issues,
        proposedPatchHints: patchHints,
        sourceFileFound: found,
        sourceFilePath: filePath,
        dryRun,
        generatedAt: new Date().toISOString(),
      };

      if (!dryRun) {
        logger.info({ toolName }, 'skill.refine: dryRun=false — would invoke meta.self-modify (skipped in this wave)');
      }

      const summary = issues.length === 0
        ? `No recurring issues found for "${toolName}".`
        : `Found ${issues.length} issue pattern(s) for "${toolName}". Top: ${issues[0]!.pattern.slice(0, 60)}...`;

      return {
        success: true,
        output: `${summary}\n\nPatch hints:\n${patchHints.map(h => `  • ${h}`).join('\n')}`,
        data: { proposal },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ toolName, err: msg }, 'skill.refine error');
      return { success: false, output: `skill.refine error: ${msg}` };
    }
  },
};
