/**
 * @file cli/commands/doctor.ts
 * @description Comprehensive environment health checks for SUDO-AI.
 *
 * Runs each check in order, collects results, and prints a formatted table
 * with status symbols: ok (pass), warn (warning/optional), error (fail/critical).
 *
 * --fix flag auto-remediates safe issues.
 * Additional checks: wasmtimeAvailable, disk > 200 MB, mem > 512 MB.
 * Auto-fix only applies to idempotent safe items (data/ dir creation, permissions).
 *
 * Exit code: 0 if no critical failures, 1 if any critical check fails.
 *
 * NOTE: spawnSync with array args used for all subprocesses (constraint L9).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CheckLevel = 'ok' | 'warn' | 'error';

interface CheckResult {
  name: string;
  level: CheckLevel;
  message: string;
  fixApplied?: string;  // description of auto-fix if applied
}

export interface DoctorOptions {
  fix?: boolean;  // auto-remediate safe issues
}

// ---------------------------------------------------------------------------
// Symbol table
// ---------------------------------------------------------------------------

const SYMBOLS: Record<CheckLevel, string> = {
  ok:    'ok  ',
  warn:  'warn',
  error: 'FAIL',
};

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function checkNodeVersion(): CheckResult {
  const name = 'Node.js >= 20';
  const [major] = process.versions.node.split('.').map(Number);
  if (major >= 20) {
    return { name, level: 'ok', message: `Node ${process.versions.node}` };
  }
  return { name, level: 'error', message: `Node ${process.versions.node} — upgrade to 20+` };
}

async function checkConfig(projectRoot: string): Promise<CheckResult> {
  const name = 'config/sudo-ai.json5';
  const configPath = path.join(projectRoot, 'config', 'sudo-ai.json5');

  if (!fs.existsSync(configPath)) {
    return { name, level: 'error', message: `Not found at ${configPath}` };
  }

  try {
    const { ConfigLoader } = await import('../../core/config/loader.js');
    const loader = new ConfigLoader(projectRoot);
    await loader.load();
    return { name, level: 'ok', message: configPath };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name, level: 'error', message: `Invalid: ${msg.substring(0, 80)}` };
  }
}

function checkEnvFile(projectRoot: string): CheckResult {
  const name = 'config/.env';
  const envPath = path.join(projectRoot, 'config', '.env');
  if (fs.existsSync(envPath)) {
    return { name, level: 'ok', message: envPath };
  }
  return { name, level: 'warn', message: 'Not found — copy config/.env.example and fill in values' };
}

function checkLlmKeys(): CheckResult {
  const name = 'LLM API key (XAI or OpenAI)';
  const hasXai = !!process.env['XAI_API_KEY'];
  const hasOpenAi = !!process.env['OPENAI_API_KEY'];
  const hasAnthropic = !!process.env['ANTHROPIC_API_KEY'] || !!process.env['ANTHROPIC_AUTH_TOKEN'];

  if (hasXai || hasOpenAi || hasAnthropic) {
    const found: string[] = [];
    if (hasXai) found.push('XAI_API_KEY');
    if (hasOpenAi) found.push('OPENAI_API_KEY');
    if (hasAnthropic) found.push('ANTHROPIC key');
    return { name, level: 'ok', message: found.join(', ') };
  }
  return {
    name,
    level: 'error',
    message: 'Neither XAI_API_KEY nor OPENAI_API_KEY is set',
  };
}

function checkTelegramToken(): CheckResult {
  const name = 'TELEGRAM_BOT_TOKEN';
  if (process.env['TELEGRAM_BOT_TOKEN']) {
    return { name, level: 'ok', message: 'Present' };
  }
  return { name, level: 'warn', message: 'Not set — Telegram channel will be disabled' };
}

function checkDataDir(projectRoot: string, fix: boolean): CheckResult {
  const name = 'data/ directory writable';
  const dataPath = path.join(projectRoot, 'data');

  if (!fs.existsSync(dataPath)) {
    if (fix) {
      try {
        fs.mkdirSync(dataPath, { recursive: true });
        return {
          name,
          level: 'ok',
          message: `Created ${dataPath}`,
          fixApplied: `mkdir -p ${dataPath}`,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { name, level: 'error', message: `Cannot create: ${msg}` };
      }
    }
    return { name, level: 'error', message: `data/ not found at ${dataPath} — run with --fix` };
  }

  try {
    const testFile = path.join(dataPath, '.write-test');
    fs.writeFileSync(testFile, '');
    fs.unlinkSync(testFile);

    // Check permissions — fix world-writable if --fix
    const stat = fs.statSync(dataPath);
    const mode = stat.mode & 0o777;
    const worldWritable = (mode & 0o002) !== 0;

    if (worldWritable && fix) {
      try {
        fs.chmodSync(dataPath, 0o750);
        return {
          name,
          level: 'ok',
          message: `${dataPath} — fixed permissions to 750`,
          fixApplied: `chmod 750 ${dataPath}`,
        };
      } catch {
        // Non-fatal: continue with warning
      }
    }

    return { name, level: 'ok', message: dataPath };
  } catch {
    return { name, level: 'error', message: `${dataPath} exists but is not writable` };
  }
}

function checkPnpm(): CheckResult {
  const name = 'pnpm available';
  // Use spawnSync with array args (constraint L9 — no execSync shell interpolation)
  const result = spawnSync('pnpm', ['--version'], { encoding: 'utf8', timeout: 5_000 });
  if (result.status === 0 && result.stdout) {
    return { name, level: 'ok', message: `pnpm ${result.stdout.trim()}` };
  }
  return { name, level: 'warn', message: 'pnpm not found in PATH — install via npm i -g pnpm' };
}

function checkPlaywright(): CheckResult {
  const name = 'Playwright browsers (optional)';
  // Use spawnSync with array args (constraint L9)
  const result = spawnSync(
    'npx',
    ['playwright', '--version'],
    { encoding: 'utf8', timeout: 8_000 },
  );
  if (result.status === 0) {
    return { name, level: 'ok', message: 'Playwright available' };
  }
  return { name, level: 'warn', message: 'Not installed — run: npx playwright install' };
}

async function checkSqliteVec(): Promise<CheckResult> {
  const name = 'sqlite-vec loadable (optional)';
  try {
    const { default: Database } = await import('better-sqlite3');
    const { default: sqliteVec } = await import('sqlite-vec');
    const db = new Database(':memory:');
    sqliteVec.load(db);
    db.close();
    return { name, level: 'ok', message: 'sqlite-vec loaded successfully' };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name, level: 'warn', message: `Not loadable: ${msg.substring(0, 60)}` };
  }
}

// ---------------------------------------------------------------------------
// Environment resource checks
// ---------------------------------------------------------------------------

/**
 * Check if wasmtime CLI binary is available in PATH.
 */
function checkWasmtime(): CheckResult {
  const name = 'wasmtime available (optional)';
  // Use spawnSync with array args (constraint L9)
  const result = spawnSync('wasmtime', ['--version'], { encoding: 'utf8', timeout: 5_000 });
  if (result.status === 0 && result.stdout) {
    return { name, level: 'ok', message: `wasmtime ${result.stdout.trim().split('\n')[0] ?? ''}` };
  }
  return {
    name,
    level: 'warn',
    message: 'wasmtime not found in PATH — WASM sandbox unavailable. Install from https://wasmtime.dev',
  };
}

/**
 * Check available disk space on the project root filesystem.
 * Flags if free space < 200 MB.
 */
function checkDiskSpace(projectRoot: string): CheckResult {
  const name = 'Disk space > 200 MB';

  // Use spawnSync with array args (constraint L9 — no shell interpolation).
  // -P forces POSIX output: exactly one line per filesystem, never wrapped,
  // so a long Filesystem/device name cannot push the numeric columns to a
  // second line and shift the field indices.
  const result = spawnSync(
    'df',
    ['-m', '-P', projectRoot],
    { encoding: 'utf8', timeout: 5_000 },
  );

  if (result.status !== 0 || !result.stdout) {
    return { name, level: 'warn', message: 'Cannot check disk space (df unavailable)' };
  }

  const lines = result.stdout.trim().split('\n');
  // df -m -P output: Filesystem, 1M-blocks, Used, Available, Capacity, Mounted
  const dataLine = lines[1];
  if (!dataLine) {
    return { name, level: 'warn', message: 'Could not parse df output' };
  }

  const fields = dataLine.trim().split(/\s+/);
  // Available is field index 3 (0-based)
  const availMb = parseInt(fields[3] ?? '0', 10);

  if (isNaN(availMb)) {
    return { name, level: 'warn', message: 'Could not parse available disk space' };
  }

  if (availMb < 200) {
    return {
      name,
      level: 'error',
      message: `Only ${availMb} MB available (minimum 200 MB required)`,
    };
  }

  return { name, level: 'ok', message: `${availMb} MB available` };
}

/**
 * Check available system memory.
 * Flags if available RAM < 512 MB.
 */
function checkMemory(): CheckResult {
  const name = 'Memory > 512 MB';

  // Use spawnSync with array args (constraint L9)
  const result = spawnSync('free', ['-m'], { encoding: 'utf8', timeout: 5_000 });

  if (result.status !== 0 || !result.stdout) {
    // Fallback: use Node.js os module (already imported at top)
    try {
      const freeMb = Math.round(os.freemem() / 1024 / 1024);
      if (freeMb < 512) {
        return { name, level: 'warn', message: `Only ${freeMb} MB free RAM (target >= 512 MB)` };
      }
      return { name, level: 'ok', message: `${freeMb} MB free` };
    } catch { /* ignore */ }
    return { name, level: 'warn', message: 'Cannot check memory (free command unavailable)' };
  }

  // Parse `free -m` output: Mem: total used free shared buff/cache available
  const lines = result.stdout.trim().split('\n');
  const memLine = lines.find((l) => l.startsWith('Mem:'));
  if (!memLine) {
    return { name, level: 'warn', message: 'Could not parse free output' };
  }

  const fields = memLine.trim().split(/\s+/);
  // "available" is the last field (index 6)
  const availMb = parseInt(fields[6] ?? fields[3] ?? '0', 10);

  if (isNaN(availMb)) {
    return { name, level: 'warn', message: 'Could not parse available memory' };
  }

  if (availMb < 512) {
    return {
      name,
      level: 'warn',
      message: `Only ${availMb} MB available RAM (target >= 512 MB)`,
    };
  }

  return { name, level: 'ok', message: `${availMb} MB available` };
}

// ---------------------------------------------------------------------------
// Table printer
// ---------------------------------------------------------------------------

function printTable(results: CheckResult[]): void {
  const nameWidth = Math.max(...results.map((r) => r.name.length), 30);
  const msgWidth = 60;

  const border = '─'.repeat(nameWidth + msgWidth + 12);
  console.log(`\n  SUDO-AI Doctor — Environment Check\n  ${border}`);
  console.log(
    `  ${'Status'.padEnd(6)} ${'Check'.padEnd(nameWidth)} ${'Details'.padEnd(msgWidth)}`,
  );
  console.log(`  ${border}`);

  for (const r of results) {
    const sym = SYMBOLS[r.level].padEnd(6);
    const name = r.name.padEnd(nameWidth);
    const msg = r.message.substring(0, msgWidth).padEnd(msgWidth);
    console.log(`  ${sym} ${name} ${msg}`);
    if (r.fixApplied) {
      console.log(`  ${''.padEnd(6)} ${''.padEnd(nameWidth)} > Fixed: ${r.fixApplied}`);
    }
  }

  console.log(`  ${border}`);

  const errors   = results.filter((r) => r.level === 'error').length;
  const warnings = results.filter((r) => r.level === 'warn').length;
  const passed   = results.filter((r) => r.level === 'ok').length;

  console.log(
    `\n  Summary: ${passed} passed, ${warnings} warnings, ${errors} critical failures\n`,
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Run all doctor checks and print the results table.
 *
 * @param projectRoot  Absolute path to the project root directory.
 * @param opts         { fix?: boolean } to auto-remediate safe issues.
 * @returns Exit code: 0 for healthy, 1 if any critical failure detected.
 */
export async function runDoctor(projectRoot: string, opts: DoctorOptions = {}): Promise<number> {
  const fix = opts.fix ?? false;

  if (fix) {
    console.log('\n  [doctor] --fix mode: will auto-remediate safe, idempotent issues');
  }

  const results: CheckResult[] = [];

  results.push(checkNodeVersion());
  results.push(await checkConfig(projectRoot));
  results.push(checkEnvFile(projectRoot));
  results.push(checkLlmKeys());
  results.push(checkTelegramToken());
  results.push(checkDataDir(projectRoot, fix));
  results.push(checkPnpm());
  results.push(checkPlaywright());
  results.push(await checkSqliteVec());
  // Environment resource checks
  results.push(checkWasmtime());
  results.push(checkDiskSpace(projectRoot));
  results.push(checkMemory());

  printTable(results);

  const hasCritical = results.some((r) => r.level === 'error');
  return hasCritical ? 1 : 0;
}
