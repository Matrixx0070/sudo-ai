/**
 * Shared helpers for social builtin tools.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../../shared/paths.js';
import type { ToolResult } from '../../types.js';

// ---------------------------------------------------------------------------
// ScheduledPost types — canonical source is schedule-dispatcher-types.ts (§3)
// ---------------------------------------------------------------------------

export type { PostStatus, ScheduledPost } from '../../../social/schedule-dispatcher-types.js';

export const SCHEDULE_FILE = path.join(DATA_DIR, 'scheduled-posts.json');

export function missingKey(envVar: string, toolName: string): ToolResult {
  return { success: false, output: `${toolName}: API key not configured. Set ${envVar} in config/.env` };
}

export function ensureDir(dir: string): void {
  try { mkdirSync(dir, { recursive: true }); } catch { /* already exists */ }
}

export function loadSchedule(): Array<Record<string, unknown>> {
  try {
    if (!existsSync(SCHEDULE_FILE)) return [];
    return JSON.parse(readFileSync(SCHEDULE_FILE, 'utf8')) as Array<Record<string, unknown>>;
  } catch { return []; }
}

export function saveSchedule(entries: Array<Record<string, unknown>>): void {
  ensureDir(path.dirname(SCHEDULE_FILE));
  writeFileSync(SCHEDULE_FILE, JSON.stringify(entries, null, 2), 'utf8');
}
