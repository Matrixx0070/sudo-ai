/**
 * meta.cron-manager — SUDO-AI system cron job management tool.
 *
 * Allows the brain to manage its own crontab entries safely.
 *
 * Actions:
 *   list     — Read and return all current crontab entries
 *   add      — Add a new cron entry with schedule, command, and optional comment
 *   remove   — Remove a SUDO-AI-managed entry by index or comment label
 *   validate — Validate a cron expression without installing it
 *   status   — Check if the cron daemon is running
 *
 * Safety:
 *   - Only entries prefixed with `# SUDO-AI:` can be removed.
 *   - All mutations are logged to data/cron-events.log.
 *   - Cron expressions are validated before installation.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { execSync } from 'node:child_process';
import { writeFileSync, appendFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const logger = createLogger('meta.cron-manager');
const DATA_DIR = path.resolve('data');
const CRON_LOG = path.join(DATA_DIR, 'cron-events.log');
const SUDO_AI_PREFIX = '# SUDO-AI:';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function timestamp(): string {
  return new Date().toISOString();
}

function logEvent(action: string, detail?: string): void {
  ensureDataDir();
  const entry = `[${timestamp()}] action=${action}${detail ? ` ${detail}` : ''}\n`;
  appendFileSync(CRON_LOG, entry, 'utf-8');
  logger.info({ action, detail }, `cron-manager: ${action}`);
}

function runCmd(cmd: string, timeoutMs = 15_000): string {
  return execSync(cmd, {
    encoding: 'utf-8',
    timeout: timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function readCrontab(): string[] {
  try {
    const raw = runCmd('crontab -l 2>/dev/null');
    return raw ? raw.split('\n') : [];
  } catch {
    return [];
  }
}

function installCrontab(lines: string[]): void {
  const ts = Date.now();
  const tmpFile = `/tmp/sudo-ai-crontab-${ts}`;
  try {
    writeFileSync(tmpFile, lines.join('\n') + '\n', 'utf-8');
    runCmd(`crontab ${tmpFile}`);
  } finally {
    try { unlinkSync(tmpFile); } catch { /* already cleaned or never created */ }
  }
}

// ---------------------------------------------------------------------------
// Cron expression validation
// ---------------------------------------------------------------------------

interface ValidationResult {
  valid: boolean;
  error?: string;
}

const FIELD_RANGES: Array<{ name: string; min: number; max: number }> = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 },
];

function validateCronExpression(expr: string): ValidationResult {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    return { valid: false, error: `Expected 5 fields, got ${fields.length}. Format: min hour dom month dow` };
  }

  for (let i = 0; i < 5; i++) {
    const field = fields[i]!;
    const range = FIELD_RANGES[i]!;
    const err = validateField(field, range.min, range.max, range.name);
    if (err) return { valid: false, error: err };
  }

  return { valid: true };
}

function validateField(field: string, min: number, max: number, name: string): string | null {
  // Handle lists (comma-separated)
  const parts = field.split(',');
  for (const part of parts) {
    const err = validateFieldPart(part, min, max, name);
    if (err) return err;
  }
  return null;
}

function validateFieldPart(part: string, min: number, max: number, name: string): string | null {
  // Wildcard
  if (part === '*') return null;

  // Step values: */n or range/n
  const stepMatch = part.match(/^(.+)\/(\d+)$/);
  if (stepMatch) {
    const base = stepMatch[1]!;
    const step = parseInt(stepMatch[2]!, 10);
    if (step < 1) return `${name}: step value must be >= 1, got ${step}`;
    if (base === '*') return null;
    return validateRangeOrValue(base, min, max, name);
  }

  // Range: a-b
  if (part.includes('-')) {
    return validateRangeOrValue(part, min, max, name);
  }

  // Single value
  const val = parseInt(part, 10);
  if (isNaN(val)) return `${name}: invalid value "${part}"`;
  if (val < min || val > max) return `${name}: value ${val} out of range [${min}-${max}]`;
  return null;
}

function validateRangeOrValue(part: string, min: number, max: number, name: string): string | null {
  const rangeMatch = part.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const lo = parseInt(rangeMatch[1]!, 10);
    const hi = parseInt(rangeMatch[2]!, 10);
    if (lo < min || lo > max) return `${name}: range start ${lo} out of range [${min}-${max}]`;
    if (hi < min || hi > max) return `${name}: range end ${hi} out of range [${min}-${max}]`;
    if (lo > hi) return `${name}: range start ${lo} > end ${hi}`;
    return null;
  }
  const val = parseInt(part, 10);
  if (isNaN(val)) return `${name}: invalid value "${part}"`;
  if (val < min || val > max) return `${name}: value ${val} out of range [${min}-${max}]`;
  return null;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const cronManagerTool: ToolDefinition = {
  name: 'meta.cron-manager',
  description:
    'Manage system cron jobs for SUDO-AI. List current entries, add new scheduled tasks, remove SUDO-AI-managed entries, validate cron expressions, or check cron daemon status. All changes are logged and only SUDO-AI-owned entries can be removed.',
  category: 'meta',
  timeout: 30_000,
  requiresConfirmation: true,
  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'The cron management operation to perform.',
      enum: ['list', 'add', 'remove', 'validate', 'status'],
    },
    schedule: {
      type: 'string',
      description: 'Cron expression (5 fields: min hour dom month dow). Required for "add" and "validate".',
    },
    command: {
      type: 'string',
      description: 'Shell command to execute on schedule. Required for "add".',
    },
    comment: {
      type: 'string',
      description: 'Label for the cron entry. Used as identifier when adding or removing by label.',
    },
    index: {
      type: 'number',
      description: 'Zero-based index of the SUDO-AI entry to remove. Used with "remove" action.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    logger.info({ session: ctx.sessionId, action }, 'meta.cron-manager invoked');

    try {
      switch (action) {
        case 'list':
          return handleList();
        case 'add':
          return handleAdd(params);
        case 'remove':
          return handleRemove(params);
        case 'validate':
          return handleValidate(params);
        case 'status':
          return handleStatus();
        default:
          return { success: false, output: `Unknown action: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'meta.cron-manager error');
      return { success: false, output: `Cron manager error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

function handleList(): ToolResult {
  const lines = readCrontab();
  if (lines.length === 0) {
    return { success: true, output: 'No crontab entries found.', data: { entries: [] } };
  }

  // Parse into structured entries (pair comment lines with command lines)
  const entries: Array<{ index: number; comment?: string; line: string; sudoAI: boolean }> = [];
  let pendingComment: string | undefined;
  let idx = 0;

  for (const line of lines) {
    if (line.startsWith(SUDO_AI_PREFIX)) {
      pendingComment = line.slice(SUDO_AI_PREFIX.length).trim();
      continue;
    }
    if (line.trim() === '' || line.startsWith('#')) {
      pendingComment = undefined;
      continue;
    }
    entries.push({
      index: idx++,
      comment: pendingComment,
      line,
      sudoAI: pendingComment !== undefined,
    });
    pendingComment = undefined;
  }

  const display = entries.map(e => {
    const label = e.sudoAI ? `[SUDO-AI: ${e.comment}]` : '[external]';
    return `  ${e.index}: ${label} ${e.line}`;
  });

  return {
    success: true,
    output: `${entries.length} crontab entry(ies):\n${display.join('\n')}`,
    data: { entries },
  };
}

function handleAdd(params: Record<string, unknown>): ToolResult {
  const schedule = params['schedule'] as string | undefined;
  const command = params['command'] as string | undefined;
  const comment = (params['comment'] as string | undefined) ?? 'unnamed task';

  if (!schedule?.trim()) return { success: false, output: 'schedule is required for "add" action.' };
  if (!command?.trim()) return { success: false, output: 'command is required for "add" action.' };

  // Validate the cron expression
  const validation = validateCronExpression(schedule);
  if (!validation.valid) {
    return { success: false, output: `Invalid cron expression: ${validation.error}` };
  }

  const lines = readCrontab();
  const isoDate = new Date().toISOString();
  const commentLine = `${SUDO_AI_PREFIX} ${comment} (added ${isoDate})`;
  const cronLine = `${schedule} ${command}`;

  lines.push(commentLine);
  lines.push(cronLine);

  installCrontab(lines);
  logEvent('add', `schedule="${schedule}" command="${command}" comment="${comment}"`);

  return {
    success: true,
    output: `Cron entry added:\n  ${commentLine}\n  ${cronLine}`,
    data: { schedule, command, comment, addedAt: isoDate },
  };
}

function handleRemove(params: Record<string, unknown>): ToolResult {
  const index = params['index'] as number | undefined;
  const comment = params['comment'] as string | undefined;

  if (index === undefined && !comment?.trim()) {
    return { success: false, output: 'Either "index" or "comment" is required for "remove" action.' };
  }

  const lines = readCrontab();
  if (lines.length === 0) {
    return { success: false, output: 'Crontab is empty — nothing to remove.' };
  }

  // Build structured entries to find the target
  interface CronEntry {
    commentLineIdx: number;
    commandLineIdx: number;
    comment: string;
    command: string;
    entryIndex: number;
  }

  const sudoEntries: CronEntry[] = [];
  let entryIdx = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith(SUDO_AI_PREFIX)) {
      // Next non-empty, non-comment line is the command
      const nextIdx = i + 1;
      if (nextIdx < lines.length && !lines[nextIdx]!.startsWith('#') && lines[nextIdx]!.trim() !== '') {
        sudoEntries.push({
          commentLineIdx: i,
          commandLineIdx: nextIdx,
          comment: line.slice(SUDO_AI_PREFIX.length).trim(),
          command: lines[nextIdx]!,
          entryIndex: entryIdx,
        });
        entryIdx++;
      }
    }
  }

  let target: CronEntry | undefined;

  if (index !== undefined) {
    // Find by counting all cron entries (including non-SUDO-AI) to match the index from list
    // But only allow removing SUDO-AI entries
    let cronIdx = 0;
    let pendingSudoComment: { lineIdx: number; text: string } | undefined;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.startsWith(SUDO_AI_PREFIX)) {
        pendingSudoComment = { lineIdx: i, text: line.slice(SUDO_AI_PREFIX.length).trim() };
        continue;
      }
      if (line.trim() === '' || line.startsWith('#')) {
        pendingSudoComment = undefined;
        continue;
      }
      if (cronIdx === index) {
        if (!pendingSudoComment) {
          return { success: false, output: `Entry at index ${index} was NOT added by SUDO-AI. Refusing to remove external entries.` };
        }
        target = {
          commentLineIdx: pendingSudoComment.lineIdx,
          commandLineIdx: i,
          comment: pendingSudoComment.text,
          command: line,
          entryIndex: cronIdx,
        };
        break;
      }
      cronIdx++;
      pendingSudoComment = undefined;
    }

    if (!target) {
      return { success: false, output: `No cron entry found at index ${index}.` };
    }
  } else if (comment) {
    // Find by comment label match (case-insensitive substring)
    const needle = comment.toLowerCase();
    target = sudoEntries.find(e => e.comment.toLowerCase().includes(needle));
    if (!target) {
      return { success: false, output: `No SUDO-AI cron entry matching comment "${comment}" found.` };
    }
  }

  if (!target) {
    return { success: false, output: 'Could not identify a cron entry to remove.' };
  }

  // Remove both the comment line and the command line (remove higher index first)
  const indicesToRemove = new Set([target.commentLineIdx, target.commandLineIdx]);
  const newLines = lines.filter((_, i) => !indicesToRemove.has(i));

  installCrontab(newLines);
  logEvent('remove', `comment="${target.comment}" command="${target.command}"`);

  return {
    success: true,
    output: `Removed SUDO-AI cron entry: "${target.comment}"\n  Was: ${target.command}`,
    data: { removedComment: target.comment, removedCommand: target.command },
  };
}

function handleValidate(params: Record<string, unknown>): ToolResult {
  const schedule = params['schedule'] as string | undefined;
  if (!schedule?.trim()) {
    return { success: false, output: 'schedule is required for "validate" action.' };
  }

  const result = validateCronExpression(schedule);
  if (result.valid) {
    const fields = schedule.trim().split(/\s+/);
    const desc = [
      `minute: ${fields[0]}`,
      `hour: ${fields[1]}`,
      `day-of-month: ${fields[2]}`,
      `month: ${fields[3]}`,
      `day-of-week: ${fields[4]}`,
    ].join(', ');
    return {
      success: true,
      output: `Valid cron expression: ${schedule}\n  Fields: ${desc}`,
      data: { valid: true, expression: schedule, fields: { minute: fields[0], hour: fields[1], dayOfMonth: fields[2], month: fields[3], dayOfWeek: fields[4] } },
    };
  } else {
    return {
      success: false,
      output: `Invalid cron expression "${schedule}": ${result.error}`,
      data: { valid: false, error: result.error },
    };
  }
}

function handleStatus(): ToolResult {
  try {
    const raw = runCmd('systemctl status cron 2>&1 || systemctl status crond 2>&1 || true');
    const isActive = /Active:\s*active\s*\(running\)/.test(raw);
    return {
      success: true,
      output: isActive
        ? `Cron daemon is RUNNING.\n\n${raw}`
        : `Cron daemon status:\n\n${raw}`,
      data: { running: isActive, raw },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: true,
      output: `Could not determine cron daemon status: ${msg}`,
      data: { running: false, error: msg },
    };
  }
}
