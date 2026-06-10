/**
 * @file cli/commands/start.ts
 * @description Start sub-command for the SUDO-AI CLI.
 *
 * Foreground mode (default):
 *   Dynamically imports src/cli.ts boot logic. The existing module fires
 *   its own boot() sequence at module level — importing it is sufficient.
 *
 * Daemon mode (--daemon):
 *   Spawns a detached child process running tsx src/cli.ts with stdio ignored,
 *   writes the child PID to data/sudo-ai.pid, and disconnects so the daemon
 *   survives the parent.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readPid, isRunning } from '../pid.js';
import { PID_PATH } from '../../core/shared/constants.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the tsx binary path — prefer the project-local installation.
 */
function resolveTsx(projectRoot: string): string {
  const local = path.join(projectRoot, 'node_modules', '.bin', 'tsx');
  if (fs.existsSync(local)) return local;
  return 'tsx';
}

/**
 * Write a numeric PID to a file, creating the parent directory if needed.
 * Standalone (does not use the pid module) to avoid ESM/CJS async import
 * issues when writing the *child* PID from the parent process.
 */
function writePidSync(pidPath: string, pid: number): void {
  const dir = path.dirname(pidPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(pidPath, String(pid), 'utf8');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start SUDO-AI in the foreground.
 *
 * Imports the existing `src/cli.ts` entry point which boots the full stack.
 * Signal handlers and shutdown logic are owned by that module.
 *
 * @param projectRoot Absolute path to the install root (where src/cli.ts lives).
 */
export async function runStartForeground(projectRoot: string): Promise<void> {
  const pidPath = PID_PATH;

  // Guard: prevent double-start.
  const existingPid = readPid(pidPath);
  if (existingPid !== null && isRunning(existingPid)) {
    console.error(`[start] SUDO-AI is already running (PID ${existingPid})`);
    process.exit(1);
  }

  // Write own PID so stop/status can find this process.
  try {
    writePidSync(pidPath, process.pid);
  } catch (err: unknown) {
    console.warn(`[start] Could not write PID file: ${String(err)}`);
  }

  // Remove PID file when this process exits (any cause).
  process.on('exit', () => {
    try { fs.unlinkSync(pidPath); } catch { /* best-effort */ }
  });

  // Dynamically import the existing boot entry point.
  // src/cli.ts fires boot() at module level — importing triggers the full stack.
  try {
    const cliEntry = path.resolve(projectRoot, 'src', 'cli.ts');
    await import(cliEntry);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error(`[start] Boot failed: ${msg}`);
    if (stack) console.error(stack);
    process.exit(1);
  }
}

/**
 * Start SUDO-AI as a detached background daemon.
 *
 * Spawns `tsx src/cli.ts` with stdio:'ignore' and detached:true so the
 * daemon survives the parent process. Writes the child PID to the PID file.
 *
 * @param projectRoot Absolute path to the install root (where src/cli.ts lives).
 */
export function runStartDaemon(projectRoot: string): void {
  const pidPath = PID_PATH;

  // Guard: prevent double-start.
  const existingPid = readPid(pidPath);
  if (existingPid !== null && isRunning(existingPid)) {
    console.error(`[start] SUDO-AI is already running (PID ${existingPid})`);
    process.exit(1);
  }

  const tsxBin = resolveTsx(projectRoot);
  const cliTs = path.resolve(projectRoot, 'src', 'cli.ts');

  console.log('[start] Launching SUDO-AI daemon...');

  const child = spawn(tsxBin, [cliTs], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
    cwd: projectRoot,
  });

  if (child.pid === undefined) {
    console.error('[start] Failed to spawn daemon — child process has no PID');
    process.exit(1);
  }

  // Write child PID so stop/status can manage it.
  try {
    writePidSync(pidPath, child.pid);
  } catch (err: unknown) {
    console.warn(`[start] Could not write PID file: ${String(err)}`);
  }

  // Detach from child so parent can exit cleanly.
  child.unref();

  console.log(`[start] SUDO-AI daemon started (PID ${child.pid})`);
  console.log('[start] Logs: data/logs/  |  Stop with: sudo-ai stop');
}
