/**
 * meta.self-modify — Rewrite SUDO-AI source code on disk.
 *
 * The single tool the owner uses to tell SUDO-AI to update its own code, config,
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
 *   test        — Run the vitest suite (optional testTarget to scope it)
 *   restart     — Restart the live SUDO-AI service (pm2; SUDO_RESTART_CMD override)
 *   full-cycle  — edit-file + build + test + restart in one shot (most common)
 *   history     — Show last 20 modifications from the modification log
 *
 * Typical flow when the owner says "change X to Y":
 *   1. search-code  → find where X lives
 *   2. read-file    → confirm context
 *   3. full-cycle   → edit + build + restart
 *
 * No confirm required — The owner trusts SUDO-AI to modify itself.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { execSync, execFileSync, spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  appendFileSync, copyFileSync, realpathSync,
} from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { isProtectedPath, PROTECTED_PATHS } from '../../../self-build/protected-paths.js';
import { PROJECT_ROOT, DATA_DIR } from '../../../shared/paths.js';
const _require = createRequire(import.meta.url);

const logger = createLogger('meta.self-modify');

const SRC_DIR    = path.join(PROJECT_ROOT, 'src');
const CONFIG_FILE = path.join(PROJECT_ROOT, 'config', 'sudo-ai.json5');
const MOD_LOG    = path.join(DATA_DIR, 'self-modify.log');
const BACKUP_DIR = path.join(DATA_DIR, 'file-backups');
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

/**
 * Run a command with an explicit argument array — NO shell, so agent-supplied
 * tokens can never inject (`;`, `&&`, `$()`, backticks are inert). Returns the
 * exit code (unlike run(), which masks it) so callers can distinguish pass/fail.
 */
function runWithCode(cmd: string, args: string[], timeoutMs = 60_000): { code: number; output: string } {
  try {
    const out = execFileSync(cmd, args, {
      encoding: 'utf-8', timeout: timeoutMs, cwd: PROJECT_ROOT, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return { code: 0, output: out };
  } catch (err: unknown) {
    const e = (err ?? {}) as { status?: number | null; signal?: string | null; stdout?: string; stderr?: string };
    const out = ((e.stdout ?? '') + '\n' + (e.stderr ?? '')).trim();
    const code = typeof e.status === 'number' ? e.status : (e.signal ? 124 : 1);
    return { code, output: out || `command failed: ${cmd} ${args.join(' ')}` };
  }
}

/** A vitest target is a path or filename glob — reject anything with shell metacharacters. */
const TEST_TARGET_RE = /^[A-Za-z0-9_./*-]+$/;

/**
 * Build the `npm test` argument array for an optional, validated vitest target.
 * Exported for unit testing the injection guard without executing the suite.
 */
export function buildTestArgs(testTarget?: string): { args: string[] } | { error: string } {
  const target = (testTarget ?? '').trim();
  if (target && !TEST_TARGET_RE.test(target)) {
    return { error: `Invalid testTarget "${target}". Only letters, digits and . _ - / * are allowed (a vitest path or filename pattern).` };
  }
  // `npm test -- <target>` → `vitest run <target>`; no target → full suite.
  return { args: target ? ['test', '--', target] : ['test'] };
}

function doTest(testTarget?: string): ToolResult {
  const built = buildTestArgs(testTarget);
  if ('error' in built) return { success: false, output: built.error };

  const target = (testTarget ?? '').trim();
  const label = target ? ` (${target})` : ' (full suite)';
  logger.info({ target: target || '(full suite)' }, 'Running test suite');
  const { code, output } = runWithCode('npm', built.args, 300_000);
  const success = code === 0;
  logMod('test', success ? `OK${target ? ` ${target}` : ''}` : `FAILED${target ? ` ${target}` : ''} (exit ${code})`);
  return {
    success,
    output: success
      ? `Tests passed${label}.\n${trim(output)}`
      : `Tests FAILED${label} (exit ${code}):\n${trim(output)}`,
    data: { exitCode: code, target: target || null },
  };
}

/** Resolve a user-supplied path — must be within PROJECT_ROOT.
 *
 * HIGH-3 fix: follows symlinks via realpathSync to prevent symlink-based
 * bypasses of the protected-path guard. For new (non-existent) files,
 * falls back to path.resolve(). Defense-in-depth: BOTH the realpath and
 * the raw norm are checked by callers via isProtectedPath.
 */
function resolveProjectPath(rawPath: string): string | null {
  const abs = path.isAbsolute(rawPath) ? rawPath : path.join(PROJECT_ROOT, rawPath);
  const norm = path.resolve(abs);
  if (!norm.startsWith(PROJECT_ROOT)) return null;

  // Resolve symlinks to prevent symlink-based traversal into protected paths.
  let realNorm: string;
  try {
    realNorm = realpathSync(norm);
  } catch {
    // File does not exist yet (new write); use norm as the real path.
    realNorm = norm;
  }
  // Return the realpath; callers also receive norm implicitly via closures
  // or by re-deriving from the original raw path.
  if (!realNorm.startsWith(PROJECT_ROOT)) return null;
  return realNorm;
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

  // Defense-in-depth: check both realpath-based rel AND raw input rel.
  const rel = path.relative(PROJECT_ROOT, abs);
  const rawNorm = path.resolve(path.isAbsolute(rawPath) ? rawPath : path.join(PROJECT_ROOT, rawPath));
  const relRaw = path.relative(PROJECT_ROOT, rawNorm);
  if ((isProtectedPath(rel) || isProtectedPath(relRaw)) && process.env['SUDO_SELFBUILD_ALLOW_PROTECTED'] !== '1') {
    return {
      success: false,
      output: `Path is protected during self-build: ${rel}. Protected roots: ${PROTECTED_PATHS.slice(0, 5).join(', ')}...`,
    };
  }

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

  // Defense-in-depth: check both realpath-based rel AND raw input rel.
  const rel = path.relative(PROJECT_ROOT, abs);
  const rawNorm = path.resolve(path.isAbsolute(rawPath) ? rawPath : path.join(PROJECT_ROOT, rawPath));
  const relRaw = path.relative(PROJECT_ROOT, rawNorm);
  if ((isProtectedPath(rel) || isProtectedPath(relRaw)) && process.env['SUDO_SELFBUILD_ALLOW_PROTECTED'] !== '1') {
    return {
      success: false,
      output: `Path is protected during self-build: ${rel}. Protected roots: ${PROTECTED_PATHS.slice(0, 5).join(', ')}...`,
    };
  }

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
  if (process.env['SUDO_SELF_BUILD_MODE'] === '1') {
    return { success: false, output: 'meta.self-modify build is blocked while SUDO_SELF_BUILD_MODE=1. The self-build orchestrator controls build/restart.' };
  }
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

/**
 * The command that restarts the live SUDO-AI service. Defaults to the pm2
 * ecosystem-file form — correct for this deployment (the daemon runs as
 * `sudo-ai-v5` under pm2; `sudo-ai.service` is masked) AND it reloads the
 * ecosystem env, so a restart can't silently drop keys like
 * SUDO_DAILY_BUDGET_USD via a stale pm2 dump. Override with SUDO_RESTART_CMD
 * for other deployments. Exported for unit testing.
 */
export function restartCommand(): string {
  const override = process.env['SUDO_RESTART_CMD'];
  if (override && override.trim()) return override.trim();
  return 'pm2 restart ecosystem.config.cjs --only sudo-ai-v5 --update-env';
}

function doRestart(): ToolResult {
  if (process.env['SUDO_SELF_BUILD_MODE'] === '1') {
    return { success: false, output: 'meta.self-modify restart is blocked while SUDO_SELF_BUILD_MODE=1. The self-build orchestrator controls build/restart.' };
  }
  const cmd = restartCommand();
  logger.info({ cmd }, 'Scheduling self-restart');
  logMod('restart', `scheduled: ${cmd}`);

  // A self-restart kills THIS process, so the restart must outlive us: spawn a
  // DETACHED child that waits a few seconds (letting this tool's result flush to
  // the user) then restarts the service. We cannot synchronously confirm success
  // — by the time pm2 bounces us, this process is gone.
  try {
    const child = spawn('sh', ['-c', `sleep 3; ${cmd}`], {
      detached: true,
      stdio: 'ignore',
      cwd: PROJECT_ROOT,
      env: process.env,
    });
    child.unref();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logMod('restart', `FAILED to schedule: ${msg}`);
    return { success: false, output: `Failed to schedule restart: ${msg}`, data: { cmd } };
  }

  return {
    success: true,
    output: `Restart scheduled via \`${cmd}\` (in ~3s). SUDO-AI will go offline briefly and come back on the new code — reconnect after a few seconds.`,
    data: { scheduled: true, cmd },
  };
}

async function doFullCycle(rawPath: string, oldText: string, newText: string, replaceAll = false, testTarget?: string): Promise<ToolResult> {
  if (process.env['SUDO_SELF_BUILD_MODE'] === '1') {
    return { success: false, output: 'meta.self-modify full-cycle is blocked while SUDO_SELF_BUILD_MODE=1. The self-build orchestrator controls build/restart.' };
  }
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

  // Step 3: Test — never restart into a fix that breaks the suite.
  const testResult = doTest(testTarget);
  if (!testResult.success) {
    return {
      success: false,
      output: `Edit applied and build succeeded, but TESTS FAILED — NOT restarting. Fix the tests or restore the backup.\n\n${testResult.output}`,
      data: { editResult, buildResult, testResult },
    };
  }

  // Step 4: Restart
  const restartResult = doRestart();

  return {
    success: restartResult.success,
    output: `DONE!\n\n✓ Edit: ${editResult.output}\n✓ Build: success\n✓ Tests: passed\n${restartResult.success ? '✓ Restart: online' : '⚠ Restart: ' + restartResult.output}`,
    data: { editResult, buildResult, testResult, restartResult },
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
    'Rewrite SUDO-AI source code on disk. Use when the owner asks you to update code, settings, ' +
    'or config files through web chat or Telegram. Supports reading files, finding files, ' +
    'searching code, editing files, writing files, editing config, building, running the test ' +
    'suite (test), restarting, and the full edit→build→test→restart cycle (full-cycle). ' +
    'NOT for inspecting current runtime config, enabled channels, model selection, version, or ' +
    'capabilities — those introspective questions are answered from the system prompt directly. ' +
    'No external tool or Claude Code needed — SUDO-AI modifies itself directly.',
  category: 'meta',
  // Generous: full-cycle now runs edit + build (~2m) + test (up to 5m) + restart.
  timeout: 600_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'What to do.',
      enum: ['read-file', 'find-file', 'search-code', 'edit-file', 'write-file', 'edit-config', 'build', 'test', 'restart', 'full-cycle', 'history'],
    },
    path: {
      type: 'string',
      required: false,
      description: `File path relative to ${PROJECT_ROOT}/ or absolute. Used by: read-file, edit-file, write-file, full-cycle.`,
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
    testTarget: {
      type: 'string',
      required: false,
      description: 'Optional vitest path or filename pattern to scope the run (e.g. "tests/meta" or "self-modify"). '
        + 'Omit to run the full suite. Used by: test, full-cycle. Only letters, digits and . _ - / * are allowed.',
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

        case 'test':
          return doTest(params['testTarget'] as string | undefined);

        case 'restart':
          return doRestart();

        case 'full-cycle':
          return await doFullCycle(
            (params['path'] as string | undefined) ?? '',
            (params['oldText'] as string | undefined) ?? '',
            (params['newText'] as string | undefined) ?? '',
            (params['replaceAll'] as boolean | undefined) ?? false,
            params['testTarget'] as string | undefined,
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
