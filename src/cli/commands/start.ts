/**
 * @file cli/commands/start.ts
 * @description Start sub-command for the SUDO-AI CLI.
 *
 * Entry resolution (both modes):
 *   Repo/dev checkout  -> src/cli.ts via tsx (unchanged historical behavior).
 *   Installed npm pkg  -> dist/src/cli.js via plain node (the tarball ships only
 *   dist/, no src/ and no tsx). See resolveDaemonEntry().
 *
 * Foreground mode (default):
 *   Dynamically imports the boot module. It fires its own boot() sequence at
 *   module level — importing it is sufficient.
 *
 * Daemon mode (--daemon):
 *   Spawns a detached child process running the resolved entry with stdio
 *   ignored, writes the child PID to data/sudo-ai.pid, and disconnects so the
 *   daemon survives the parent.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readPid, isRunning } from '../pid.js';
import { PID_PATH } from '../../core/shared/constants.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** How the daemon entry point will be launched. */
export interface DaemonEntry {
  /** 'src' = repo/dev layout (tsx on TypeScript source); 'dist' = installed npm package (plain node on the compiled bundle). */
  kind: 'src' | 'dist';
  /** Absolute path to the module that boots the daemon (imported in foreground mode). */
  entryPath: string;
  /** Command to spawn for daemon mode. */
  command: string;
  /** Arguments for the spawned command. */
  args: string[];
}

/** Injectable fs surface for unit tests. */
export interface EntryFs {
  existsSync(p: string): boolean;
}

/**
 * Resolve which daemon entry point to use.
 *
 * Repo/dev layout: `src/cli.ts` exists next to the CLI — run it with tsx
 * (unchanged historical behavior; pm2 uses this same source entry).
 *
 * Installed npm package: the tarball ships only `dist/` (no `src/`, no tsx),
 * so use the compiled `dist/src/cli.js` bundle with plain node.
 *
 * @throws if neither entry exists (corrupt install).
 */
export function resolveDaemonEntry(
  projectRoot: string,
  fsImpl: EntryFs = fs,
  nodeExecPath: string = process.execPath,
): DaemonEntry {
  const srcEntry = path.resolve(projectRoot, 'src', 'cli.ts');
  if (fsImpl.existsSync(srcEntry)) {
    return {
      kind: 'src',
      entryPath: srcEntry,
      command: resolveTsxWith(projectRoot, fsImpl),
      args: [srcEntry],
    };
  }
  const distEntry = path.resolve(projectRoot, 'dist', 'src', 'cli.js');
  if (fsImpl.existsSync(distEntry)) {
    return {
      kind: 'dist',
      entryPath: distEntry,
      command: nodeExecPath,
      args: [distEntry],
    };
  }
  throw new Error(
    `[start] No daemon entry found under ${projectRoot} — expected src/cli.ts (repo) or dist/src/cli.js (installed package). ` +
    'The installation may be corrupt; try reinstalling.',
  );
}

/** resolveTsx with an injectable fs (shared by resolveDaemonEntry + tests). */
function resolveTsxWith(projectRoot: string, fsImpl: EntryFs): string {
  const local = path.join(projectRoot, 'node_modules', '.bin', 'tsx');
  if (fsImpl.existsSync(local)) return local;
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

  // Dynamically import the boot entry point (src/cli.ts in a repo checkout,
  // dist/src/cli.js in an installed npm package). The module fires boot() at
  // module level — importing triggers the full stack.
  try {
    const entry = resolveDaemonEntry(projectRoot);
    await import(entry.entryPath);
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

  let entry: DaemonEntry;
  try {
    entry = resolveDaemonEntry(projectRoot);
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // The daemon must resolve config/data the same way this CLI process does
  // (SUDO_AI_HOME, else the invoking cwd — where quickstart wrote the config).
  // Spawning with cwd=projectRoot would point an installed daemon at the
  // package dir inside node_modules instead of the user's home root.
  const homeRoot = process.env['SUDO_AI_HOME']
    ? path.resolve(process.env['SUDO_AI_HOME'])
    : process.cwd();

  console.log('[start] Launching SUDO-AI daemon...');

  const child = spawn(entry.command, entry.args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, SUDO_AI_HOME: homeRoot },
    cwd: homeRoot,
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
