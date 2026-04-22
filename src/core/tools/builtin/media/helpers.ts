/**
 * Shared helpers for media builtin tools.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import type { ToolResult } from '../../types.js';

const execFileAsync = promisify(execFile);

export function ensureDir(dir: string): void {
  try { mkdirSync(dir, { recursive: true }); } catch { /* already exists */ }
}

export function missingKey(envVar: string, toolName: string): ToolResult {
  return { success: false, output: `${toolName}: API key not configured. Set ${envVar} in config/.env` };
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function runFfmpegSilent(args: string[], signal?: AbortSignal): Promise<void> {
  try {
    await execFileAsync('ffmpeg', ['-y', ...args], { signal, maxBuffer: 32 * 1024 * 1024 });
  } catch (err: unknown) {
    const e = err as { stderr?: string; code?: number };
    throw new Error(`ffmpeg error (code ${e.code ?? 1}): ${(e.stderr ?? String(err)).slice(-1000)}`);
  }
}

export async function runFfmpegCapture(args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync('ffmpeg', ['-y', ...args], { signal, maxBuffer: 16 * 1024 * 1024 });
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string; code?: number };
    // ffmpeg often writes to stderr even on success; return both for callers to parse
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? String(err) };
  }
}
