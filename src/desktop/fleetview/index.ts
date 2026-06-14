/**
 * @file src/desktop/fleetview/index.ts
 * @description Entry point for the FleetView desktop wrapper (gap #25 slice 4).
 *
 * tsx-runnable launcher: validates env, then spawns the `electron` CLI on
 * main.cjs. Electron is an optionalDependency so a default `pnpm install` for
 * server-only deploys doesn't pull the ~150MB Chromium download; the launcher
 * fails honestly if it's missing.
 *
 * Invoke via `pnpm desktop:fleetview`.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { readConfigFromEnv } from './config.js';

function resolveElectronBinary(): string | null {
  // `require('electron')` outside the Electron runtime exports the path to
  // the bundled binary as a string. Wrapped in try/catch so a missing
  // optionalDependency surfaces a useful install hint, not MODULE_NOT_FOUND.
  try {
    const req = createRequire(import.meta.url);
    const electronExport: unknown = req('electron');
    if (typeof electronExport === 'string' && electronExport.length > 0) {
      return electronExport;
    }
    return null;
  } catch {
    return null;
  }
}

function resolveMainCjsPath(): string {
  // The compiled bundle and the dev (tsx) path both land main.cjs next to
  // this file. Use import.meta.url so this works equally from src/ under tsx
  // and from dist/ if a future slice ships a bundled binary.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, 'main.cjs');
}

async function main(): Promise<void> {
  const cfgResult = readConfigFromEnv();
  if (!cfgResult.ok) {
    process.stderr.write(`desktop-fleetview: ${cfgResult.error}\n`);
    process.exit(1);
  }

  const electronBin = resolveElectronBinary();
  if (electronBin === null) {
    process.stderr.write(
      'desktop-fleetview: electron is not installed. ' +
        'Run `pnpm add -D electron` (it is an optionalDependency by default ' +
        'so server-only deploys do not pull the ~150MB Chromium download).\n',
    );
    process.exit(1);
  }

  const mainCjs = resolveMainCjsPath();
  const child = spawn(electronBin, [mainCjs], {
    stdio: 'inherit',
    env: process.env,
  });

  child.on('error', (err) => {
    process.stderr.write(`desktop-fleetview: spawn failed: ${err.message}\n`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      // Reflect the actual signal number — wrapper supervisors (systemd, pm2,
      // parent shells) decide restart policy based on exit code, and 128+9
      // (SIGKILL) means something very different from 128+15 (SIGTERM). Map
      // via os.constants.signals so the wrapper stays honest about WHY
      // electron exited (verifier MED #1).
      const signalNumber = (os.constants.signals as Record<string, number>)[signal];
      const exitCode = typeof signalNumber === 'number' ? 128 + signalNumber : 128 + 15;
      process.exit(exitCode);
    }
    process.exit(code ?? 0);
  });

  // Forward INT/TERM so Ctrl+C in the launcher closes the Electron app.
  const forward = (sig: NodeJS.Signals): void => {
    if (!child.killed) child.kill(sig);
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));
}

void main();
