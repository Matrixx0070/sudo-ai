/**
 * meta.self-modify — SUDO-AI self-modification pipeline.
 *
 * The single tool Frank uses to tell SUDO-AI to update its own code, config,
 * or settings through web chat or Telegram — no Claude Code needed.
 *
 * Actions:
 *   read-file   — Read any SUDO-AI source or config file
 *   find-file   — Glob search for files in the project (by name pattern)
 *   search-code — Grep for text/regex across all source files
 *   edit-file   — Replace text in a file (oldText → newText). Supports backup.
 *   write-file  — Overwrite an entire file with new content
 *   edit-config — Set a key in config/sudo-ai.json5 (key-value shorthand)
 *   build       — Run `npm run build` (compile TypeScript)
 *   restart     — Restart the SUDO-AI systemd service
 *   full-cycle  — edit-file + build + restart in one shot (most common)
 *   history     — Show last 20 modifications from the modification log
 *
 * Typical flow when Frank says "change X to Y":
 *   1. search-code  → find where X lives
 *   2. read-file    → confirm context
 *   3. full-cycle   → edit + build + restart
 *
 * No confirm required — Frank trusts SUDO-AI to modify itself.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { execSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  appendFileSync, copyFileSync,
} from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);

const logger = createLogger('meta.self-modify');

const PROJECT_ROOT = '/root/sudo-ai-v4';
const SRC_DIR    = path.join(PROJECT_ROOT, 'src');
const DATA_DIR   = path.join(PROJECT_ROOT, 'data');
const CONFIG_FILE = path.join(PROJECT_ROOT, 'config', 'sudo-ai.json5');
const MOD_LOG    = path.join(DATA_DIR, 'self-modify.log');
const BACKUP_DIR = path.join(DATA_DIR, 'file-backups');
const SERVICE    = 'sudo-ai';
const MAX_OUTPUT = 3000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDirs(): void {
  if (!existsSync(DATA_DIR))   mkdirSync(DATA_DIR,   { recursive: true });
  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
}

function ts(): string { return new Date().toISOString(); }

function logMod(action: string, detail: string): void {
  ensureDirs();
  const entry = `[${ts()}] ${action}: ${detail}\n`;
  appendFileSync(MOD_LOG, entry, 'utf-8');
  logger.info({ action, detail }, 'self-modify');
}

function run(cmd: string, timeoutMs = 60_000): string {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      cwd: PROJECT_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'stdout' in err && 'stderr' in err) {
      const e = err as { stdout: string; stderr: string };
      return ((e.stdout ?? '') + '\n' + (e.stderr ?? '')).trim();
    }
    throw err;
  }
}

function trim(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  const half = Math.floor(MAX_OUTPUT / 2);
  return s.slice(0, half) + '\n...[truncated]...\n' + s.slice(-half);
}

/** Resolve a user-supplied path — must be within PROJECT_ROOT */
function resolveProjectPath(rawPath: string): string | null {
  const abs = path.isAbsolute(rawPath) ? rawPath : path.join(PROJECT_ROOT, rawPath);
  const norm = path.resolve(abs);
  if (!norm.startsWith(PROJECT_ROOT)) return null;
  return norm;
}

/** Back up a file before modification */
function backup(filePath: string): string {
  ensureDirs();
  const rel = path.relative(PROJECT_ROOT, filePath).replace(/\//g, '__');
  const dest = path.join(BACKUP_DIR, `${Date.now()}_${rel}`);
  if (existsSync(filePath)) copyFileSync(filePath, dest);
  return dest;
}

// ---------------------------------------------------------------------------
// Action implementations
// ---------------------------------------------------------------------------

function doReadFile(rawPath: string): ToolResult {
  const abs = resolveProjectPath(rawPath);
  if (!abs) return { success: false, output: `Path traversal blocked: ${rawPath}` };
  if (!existsSync(abs)) return { success: false, output: `File not found: ${abs}` };
  const content = readFileSync(abs, 'utf-8');
  const lines = content.split('\n').length;
  return {
    success: true,
    output: `--- ${abs} (${lines} lines) ---\n${trim(content)}`,
    data: { path: abs, lines, size: content.length },
  };
}

function doFindFile(pattern: string): ToolResult {
  // Use find to search by filename pattern
  const safePattern = pattern.replace(/[`$(){}!]/g, '');
  const result = run(`find ${SRC_DIR} config workspace -name "${safePattern}" 2>/dev/null | head -40`, 10_000);
  const files = result ? result.split('\n').filter(Boolean) : [];
  return {
    success: true,
    output: files.length > 0 ? `Found ${files.length} file(s):\n${files.join('\n')}` : `No files found matching: ${pattern}`,
    data: { pattern, files },
  };
}

function doSearchCode(searchText: string, filePattern: string = '*.ts'): ToolResult {
  const safeSearch = searchText.replace(/'/g, "'\\''");
  const safePat = filePattern.replace(/[`$(){}!]/g, '');
  const result = run(
    `grep -rn --include="${safePat}" '${safeSearch}' ${SRC_DIR} config workspace 2>/dev/null | head -50`,
    10_000,
  );
  const lines = result ? result.split('\n').filter(Boolean) : [];
  return {
    success: true,
    output: lines.length > 0 ? `Found ${lines.length} match(es):\n${result}` : `No matches for: ${searchText}`,
    data: { searchText, matchCount: lines.length },
  };
}

function doEditFile(rawPath: string, oldText: string, newText: string, replaceAll = false): ToolResult {
  const abs = resolveProjectPath(rawPath);
  if (!abs) return { success: false, output: `Path traversal blocked: ${rawPath}` };
  if (!existsSync(abs)) return { success: false, output: `File not found: ${abs}` };

  let content = readFileSync(abs, 'utf-8');
  if (!content.includes(oldText)) {
    return { success: false, output: `Text not found in ${path.relative(PROJECT_ROOT, abs)}:\n${oldText.slice(0, 200)}` };
  }

  const backupPath = backup(abs);
  const count = replaceAll
    ? (content.split(oldText).length - 1)
    : 1;

  content = replaceAll
    ? content.split(oldText).join(newText)
    : content.replace(oldText, newText);

  writeFileSync(abs, content, 'utf-8');
  logMod('edit-file', `${path.relative(PROJECT_ROOT, abs)} (${count} replacement(s))`);

  return {
    success: true,
    output: `Edited ${path.relative(PROJECT_ROOT, abs)}: replaced ${count} occurrence(s).\nBackup: ${path.relative(PROJECT_ROOT, backupPath)}`,
    data: { path: abs, replacements: count, backup: backupPath },
  };
}

function doWriteFile(rawPath: string, content: string): ToolResult {
  const abs = resolveProjectPath(rawPath);
  if (!abs) return { success: false, output: `Path traversal blocked: ${rawPath}` };

  // Ensure parent dir exists
  const dir = path.dirname(abs);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const backupPath = existsSync(abs) ? backup(abs) : '';
  writeFileSync(abs, content, 'utf-8');
  logMod('write-file', `${path.relative(PROJECT_ROOT, abs)} (${content.split('\n').length} lines)`);

  return {
    success: true,
    output: `Written ${path.relative(PROJECT_ROOT, abs)} (${content.split('\n').length} lines).${backupPath ? `\nBackup: ${path.relative(PROJECT_ROOT, backupPath)}` : ''}`,
    data: { path: abs, lines: content.split('\n').length },
  };
}

function doEditConfig(key: string, value: unknown): ToolResult {
  if (!existsSync(CONFIG_FILE)) {
    return { success: false, output: 'Config file not found: config/sudo-ai.json5' };
  }
  const raw = readFileSync(CONFIG_FILE, 'utf-8');
  backup(CONFIG_FILE);

  // Simple key replacement: find "key": <old-value> and replace with new
  const JSON5 = _require('json5') as { parse: (s: string) => Record<string, unknown>; stringify: (v: unknown, r: unknown, s: unknown) => string };
  let parsed: Record<string, unknown>;
  try { parsed = JSON5.parse(raw) as Record<string, unknown>; }
  catch { return { success: false, output: 'Failed to parse sudo-ai.json5' }; }

  // Support dot-notation key paths like "brain.model"
  const keys = key.split('.');
  let obj: Record<string, unknown> = parsed;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!;
    if (typeof obj[k] !== 'object' || obj[k] === null) obj[k] = {};
    obj = obj[k] as Record<string, unknown>;
  }
  const leafKey = keys[keys.length - 1]!;
  const oldValue = obj[leafKey];
  obj[leafKey] = value;

  // Write back as JSON5 with 2-space indent (drops comments unfortunately)
  const updated = JSON5.stringify(parsed, null, 2);
  writeFileSync(CONFIG_FILE, updated, 'utf-8');
  logMod('edit-config', `${key}: ${String(oldValue)} → ${String(value)}`);

  return {
    success: true,
    output: `Config updated: ${key} = ${JSON.stringify(value)}\n(was: ${JSON.stringify(oldValue)})`,
    data: { key, oldValue, newValue: value },
  };
}

function doBuild(): ToolResult {
  logger.info('Running npm build');
  const output = run('npm run build 2>&1', 120_000);
  const success = !output.includes('error TS') && !output.includes('Build failed');
  logMod('build', success ? 'OK' : 'FAILED');
  return {
    success,
    output: success
      ? `Build succeeded.\n${trim(output)}`
      : `Build FAILED:\n${trim(output)}`,
    data: { buildOutput: output },
  };
}

function doRestart(): ToolResult {
  logger.info('Restarting sudo-ai service');
  logMod('restart', 'service restart initiated');
  run(`systemctl restart ${SERVICE}`, 30_000);
  // Give it 2s then check
  execSync('sleep 2');
  const status = run(`systemctl is-active ${SERVICE}`, 5_000);
  const ok = status.trim() === 'active';
  return {
    success: ok,
    output: ok ? 'Service restarted successfully — SUDO-AI is back online.' : `Restart may have failed. Status: ${status}`,
    data: { status },
  };
}

async function doFullCycle(rawPath: string, oldText: string, newText: string, replaceAll = false): Promise<ToolResult> {
  // Step 1: Edit
  const editResult = doEditFile(rawPath, oldText, newText, replaceAll);
  if (!editResult.success) return editResult;

  // Step 2: Build
  const buildResult = doBuild();
  if (!buildResult.success) {
    return {
      success: false,
      output: `Edit applied but BUILD FAILED. File has been edited — rollback by restoring backup.\n\nBuild error:\n${buildResult.output}`,
      data: { editResult, buildResult },
    };
  }

  // Step 3: Restart
  const restartResult = doRestart();

  return {
    success: restartResult.success,
    output: `DONE!\n\n✓ Edit: ${editResult.output}\n✓ Build: success\n${restartResult.success ? '✓ Restart: online' : '⚠ Restart: ' + restartResult.output}`,
    data: { editResult, buildResult, restartResult },
  };
}

function doHistory(): ToolResult {
  if (!existsSync(MOD_LOG)) {
    return { success: true, output: 'No modifications logged yet.', data: { entries: [] } };
  }
  const raw = readFileSync(MOD_LOG, 'utf-8');
  const lines = raw.split('\n').filter(Boolean);
  const last20 = lines.slice(-20).reverse();
  return {
    success: true,
    output: `Last ${last20.length} modification(s):\n\n${last20.join('\n')}`,
    data: { entries: last20 },
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const selfModifyTool: ToolDefinition = {
  name: 'meta.self-modify',
  description:
    'SUDO-AI self-modification pipeline. Use this when Frank asks you to update code, settings, ' +
    'or config files through web chat or Telegram. Supports reading files, finding files, ' +
    'searching code, editing files, writing files, editing config, building, restarting, ' +
    'and the full edit→build→restart cycle (full-cycle). ' +
    'No external tool or Claude Code needed — SUDO-AI modifies itself directly.',
  category: 'meta',
  timeout: 180_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'What to do.',
      enum: ['read-file', 'find-file', 'search-code', 'edit-file', 'write-file', 'edit-config', 'build', 'restart', 'full-cycle', 'history'],
    },
    path: {
      type: 'string',
      required: false,
      description: 'File path relative to /root/sudo-ai-v4/ or absolute. Used by: read-file, edit-file, write-file, full-cycle.',
    },
    pattern: {
      type: 'string',
      required: false,
      description: 'Filename glob pattern e.g. "*.ts", "health-check.ts". Used by: find-file.',
    },
    searchText: {
      type: 'string',
      required: false,
      description: 'Text or regex to search for in source files. Used by: search-code.',
    },
    filePattern: {
      type: 'string',
      required: false,
      description: 'File extension filter for search-code e.g. "*.ts", "*.json5". Default: "*.ts".',
    },
    oldText: {
      type: 'string',
      required: false,
      description: 'Exact text to find and replace. Used by: edit-file, full-cycle.',
    },
    newText: {
      type: 'string',
      required: false,
      description: 'Replacement text. Used by: edit-file, full-cycle.',
    },
    content: {
      type: 'string',
      required: false,
      description: 'Full file content to write. Used by: write-file.',
    },
    replaceAll: {
      type: 'boolean',
      required: false,
      description: 'Replace all occurrences of oldText (default: false = replace first only). Used by: edit-file, full-cycle.',
    },
    configKey: {
      type: 'string',
      required: false,
      description: 'Dot-notation config key e.g. "brain.model", "systemPrompt". Used by: edit-config.',
    },
    configValue: {
      type: 'string',
      required: false,
      description: 'New value for the config key (string). Used by: edit-config.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    logger.info({ action, session: ctx.sessionId }, 'meta.self-modify invoked');

    try {
      switch (action) {
        case 'read-file':
          return doReadFile((params['path'] as string | undefined) ?? '');

        case 'find-file':
          return doFindFile((params['pattern'] as string | undefined) ?? '*');

        case 'search-code':
          return doSearchCode(
            (params['searchText'] as string | undefined) ?? '',
            (params['filePattern'] as string | undefined) ?? '*.ts',
          );

        case 'edit-file':
          return doEditFile(
            (params['path'] as string | undefined) ?? '',
            (params['oldText'] as string | undefined) ?? '',
            (params['newText'] as string | undefined) ?? '',
            (params['replaceAll'] as boolean | undefined) ?? false,
          );

        case 'write-file':
          return doWriteFile(
            (params['path'] as string | undefined) ?? '',
            (params['content'] as string | undefined) ?? '',
          );

        case 'edit-config':
          return doEditConfig(
            (params['configKey'] as string | undefined) ?? '',
            params['configValue'],
          );

        case 'build':
          return doBuild();

        case 'restart':
          return doRestart();

        case 'full-cycle':
          return await doFullCycle(
            (params['path'] as string | undefined) ?? '',
            (params['oldText'] as string | undefined) ?? '',
            (params['newText'] as string | undefined) ?? '',
            (params['replaceAll'] as boolean | undefined) ?? false,
          );

        case 'history':
          return doHistory();

        default:
          return { success: false, output: `Unknown action: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'meta.self-modify error');
      return { success: false, output: `meta.self-modify error (${action}): ${msg}` };
    }
  },
};
