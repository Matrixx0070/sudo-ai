/**
 * @file core/session.ts
 * @description Desktop sessions for the Computer Use Backend.
 *
 * A Session is a display + its lifecycle. Two kinds:
 *   - attached: an existing display (e.g. ":10", the owner desktop). Never
 *     torn down; the window guard in the driver protects it.
 *   - ephemeral: a fresh Xvfb display (+ optional lightweight WM) spawned for
 *     the agent to work in WITHOUT colliding with the owner's screen. Disposed
 *     when done. This is how long GUI workflows run in the background.
 *
 * Readiness is polled with `xdpyinfo` (never a fixed sleep — the sandbox blocks
 * foreground sleep and fixed delays are races anyway).
 */

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../../../../shared/logger.js';

const execFileAsync = promisify(execFile);
const log = createLogger('computer:session');

export interface Session {
  /** e.g. ":99" (no screen suffix). */
  display: string;
  /** 'attached' displays are never torn down. */
  kind: 'attached' | 'ephemeral';
  width: number;
  height: number;
  /** Tear down the session (no-op for attached). Idempotent. */
  dispose(): Promise<void>;
}

export interface EphemeralOptions {
  width?: number;
  height?: number;
  depth?: number;
  /** Start a lightweight WM (openbox) so focus/wmctrl work. Default true. */
  windowManager?: boolean;
  /** Display number to use; auto-picked from a high range when omitted. */
  displayNum?: number;
  /** Max ms to wait for the display to accept connections. Default 8000. */
  readyTimeoutMs?: number;
}

/** Attach to an already-running display (e.g. the owner desktop). */
export function attachSession(display: string, width = 1280, height = 720): Session {
  return {
    display,
    kind: 'attached',
    width,
    height,
    async dispose() {
      /* attached displays are never torn down */
    },
  };
}

async function displayReady(display: string): Promise<boolean> {
  try {
    await execFileAsync('xdpyinfo', ['-display', display], { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

/** Await a predicate by polling, using timers (not a blocking sleep). */
async function pollUntil(fn: () => Promise<boolean>, timeoutMs: number, everyMs = 150): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await fn()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

let displayCounter = 90 + Math.floor((Date.now() % 900) / 100); // spread 90..99-ish

/**
 * Spawn an ephemeral Xvfb display (+ optional openbox). The returned Session's
 * dispose() kills both children and is safe to call more than once.
 */
export async function createEphemeralSession(opts: EphemeralOptions = {}): Promise<Session> {
  const width = opts.width ?? 1280;
  const height = opts.height ?? 800;
  const depth = opts.depth ?? 24;
  const wantWm = opts.windowManager ?? true;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 8000;

  // Pick a free display number by probing; ephemeral range 90..129.
  let display = '';
  const start = opts.displayNum ?? (displayCounter = (displayCounter % 40) + 90);
  for (let n = start; n < start + 40; n++) {
    const cand = `:${n}`;
    if (!(await displayReady(cand))) {
      display = cand;
      break;
    }
  }
  if (!display) throw new Error('createEphemeralSession: no free display number in 90..129');

  const children: ChildProcess[] = [];
  const xvfb = spawn(
    'Xvfb',
    [display, '-screen', '0', `${width}x${height}x${depth}`, '-ac', '-nolisten', 'tcp', '+extension', 'RANDR'],
    { stdio: 'ignore', detached: false },
  );
  children.push(xvfb);
  xvfb.on('error', (e) => log.error({ err: e, display }, 'Xvfb spawn error'));

  const ready = await pollUntil(() => displayReady(display), readyTimeoutMs);
  if (!ready) {
    for (const c of children) c.kill('SIGKILL');
    throw new Error(`createEphemeralSession: Xvfb ${display} did not become ready in ${readyTimeoutMs}ms`);
  }

  let wm: ChildProcess | undefined;
  if (wantWm) {
    wm = spawn('openbox', [], { env: { ...process.env, DISPLAY: display }, stdio: 'ignore' });
    wm.on('error', (e) => log.warn({ err: e, display }, 'openbox spawn error (continuing WM-less)'));
    children.push(wm);
    // Give openbox a beat to own the root window (poll for it, don't sleep).
    await pollUntil(async () => {
      try {
        await execFileAsync('wmctrl', ['-m'], { env: { ...process.env, DISPLAY: display }, timeout: 1500 });
        return true;
      } catch {
        return false;
      }
    }, 3000);
  }

  log.info({ display, width, height, wm: wantWm }, 'ephemeral session up');

  let disposed = false;
  return {
    display,
    kind: 'ephemeral',
    width,
    height,
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const c of children) {
        try {
          c.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      }
      // Hard-kill after a short grace, via timer not sleep.
      await new Promise((r) => setTimeout(r, 300));
      for (const c of children) {
        try {
          if (!c.killed) c.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
      log.info({ display }, 'ephemeral session disposed');
    },
  };
}
