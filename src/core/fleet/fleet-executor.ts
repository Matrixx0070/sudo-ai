/**
 * @file src/core/fleet/fleet-executor.ts
 * @description Gap #28c slice 2 — device-side long-poll loop. Starts after
 * boot once the device has registered, runs in the background, and
 * forwards admin-dispatched commands to local handlers.
 *
 * Lifecycle:
 *   - `startFleetExecutor(opts)` returns a `{ stop() }` handle.
 *   - The loop GETs `:registrarUrl/api/fleet/device/:id/inbox?wait=25`
 *     repeatedly. Each request carries an Ed25519 signature over
 *     `<METHOD>:<PATH>:<TIMESTAMP>:<DEVICE_ID>` (see fleet-signature.ts).
 *   - On 200, the loop hands the command to the registered handler, then
 *     POSTs the result to `/api/fleet/device/:id/result`.
 *   - On 204 (no command this cycle), the loop re-polls.
 *   - On 4xx/5xx, backoff with jitter (5s..60s).
 *   - `stop()` cancels the in-flight fetch via AbortController and prevents
 *     the next iteration.
 *
 * Slice-2 command handlers cover `model.get` and `model.set`, both Brain-
 * backed and reusing the §28b slice 1 model surface. Unknown kinds return
 * a `failed` result so the admin sees the error.
 */

import type { DeviceIdentity } from './device-identity.js';
import type { CommandBody, CommandResult } from './command-queue.js';
import { signFleetRequest } from './fleet-signature.js';

/** Brain shape the executor needs — duck-typed against BrainSource. */
export interface ExecutorBrainHandle {
  getModel(): string;
  setModel(model: string): void;
}

/** Options for `startFleetExecutor`. */
export interface FleetExecutorOptions {
  registrarUrl: string;
  identity: DeviceIdentity;
  /**
   * Brain handle. When absent (orchestrator failed to wire one in cli.ts),
   * the executor still polls — but model.* commands return a `failed`
   * result with reason "brain_not_registered". This matches the
   * /api/admin/model endpoint behavior in slice-1.
   */
  brain?: ExecutorBrainHandle;
  /** Long-poll wait seconds. Clamped server-side to [0, 60]. */
  waitSeconds?: number;
  /** Backoff jitter base, ms. Default 5000. */
  backoffBaseMs?: number;
  /** Max backoff, ms. Default 60000. */
  backoffMaxMs?: number;
  /** Custom fetch impl (testing). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Custom logger (testing). Defaults to a console shim. */
  log?: {
    info(msg: Record<string, unknown>): void;
    warn(msg: Record<string, unknown>): void;
  };
}

/** Handle returned by `startFleetExecutor`. */
export interface FleetExecutorHandle {
  stop(): Promise<void>;
  /** Promise that resolves when the loop exits cleanly (after `stop`). */
  done: Promise<void>;
}

/** Start the long-poll loop. Returns immediately with a handle. */
export function startFleetExecutor(opts: FleetExecutorOptions): FleetExecutorHandle {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const waitSec = opts.waitSeconds ?? 25;
  const backoffBaseMs = opts.backoffBaseMs ?? 5000;
  const backoffMaxMs = opts.backoffMaxMs ?? 60000;
  const log = opts.log ?? defaultLog;
  let stopping = false;
  let currentController: AbortController | null = null;
  let consecutiveErrors = 0;

  async function loopBody(): Promise<void> {
    while (!stopping) {
      try {
        const cmd = await pollOnce();
        if (cmd === 'stop') break;
        if (cmd === null) {
          // 204 — no command. Reset backoff.
          consecutiveErrors = 0;
          continue;
        }
        consecutiveErrors = 0;
        // Got a command. Run + report.
        const result = await runCommand(cmd, opts.brain);
        await postResult(cmd.commandId, result);
      } catch (err) {
        if (stopping) break;
        consecutiveErrors++;
        const delay = Math.min(backoffMaxMs, backoffBaseMs * Math.pow(2, Math.min(5, consecutiveErrors - 1)));
        const jittered = delay * (0.5 + Math.random() * 0.5);
        log.warn({
          err: err instanceof Error ? err.message : String(err),
          consecutiveErrors,
          backoffMs: Math.round(jittered),
        });
        await sleep(jittered);
      }
    }
    log.info({ msg: 'Fleet executor loop exited' });
  }

  /**
   * Single iteration. Returns:
   *   - command object on 200
   *   - null on 204 (no command this cycle)
   *   - 'stop' if `stopping` was flipped during the fetch
   * Throws on transport error / 5xx so the outer loop can backoff.
   */
  async function pollOnce(): Promise<{ commandId: string; kind: string; args?: Record<string, unknown> } | null | 'stop'> {
    const path = `/api/fleet/device/${opts.identity.deviceId}/inbox`;
    const url = `${opts.registrarUrl}${path}?wait=${waitSec}`;
    const headers = signFleetRequest({ method: 'GET', path, identity: opts.identity });
    currentController = new AbortController();
    try {
      const res = await fetchImpl(url, { method: 'GET', headers, signal: currentController.signal });
      if (stopping) return 'stop';
      if (res.status === 204) return null;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`inbox HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const json = await res.json() as { commandId: string; kind: string; args?: Record<string, unknown> };
      return { commandId: json.commandId, kind: json.kind, ...(json.args ? { args: json.args } : {}) };
    } finally {
      currentController = null;
    }
  }

  async function postResult(commandId: string, result: CommandResult): Promise<void> {
    const path = `/api/fleet/device/${opts.identity.deviceId}/result`;
    const url = `${opts.registrarUrl}${path}`;
    const headers = {
      ...signFleetRequest({ method: 'POST', path, identity: opts.identity }),
      'Content-Type': 'application/json',
    };
    const body = JSON.stringify({ commandId, ...result });
    const controller = new AbortController();
    currentController = controller;
    try {
      const res = await fetchImpl(url, { method: 'POST', headers, body, signal: controller.signal });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`result HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
    } finally {
      currentController = null;
    }
  }

  const done = loopBody();

  return {
    async stop(): Promise<void> {
      stopping = true;
      currentController?.abort();
      await done;
    },
    done,
  };
}

/** Run a single command against the local brain. Slice-2 command set only. */
export async function runCommand(
  cmd: { commandId: string; kind: string; args?: Record<string, unknown> },
  brain: ExecutorBrainHandle | undefined,
): Promise<CommandResult> {
  try {
    if (cmd.kind === 'model.get') {
      if (!brain) return { status: 'failed', error: 'brain_not_registered' };
      return { status: 'completed', result: { model: brain.getModel() } };
    }
    if (cmd.kind === 'model.set') {
      if (!brain) return { status: 'failed', error: 'brain_not_registered' };
      const target = cmd.args?.['model'];
      if (typeof target !== 'string' || target.length === 0) {
        return { status: 'failed', error: 'model arg required (non-empty string)' };
      }
      brain.setModel(target);
      return { status: 'completed', result: { model: brain.getModel() } };
    }
    return { status: 'failed', error: `unsupported_kind:${cmd.kind}` };
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const defaultLog = {
  info(msg: Record<string, unknown>): void {
    const t = new Date().toISOString();
    process.stdout.write(`[${t}] [fleet-executor] ${JSON.stringify(msg)}\n`);
  },
  warn(msg: Record<string, unknown>): void {
    const t = new Date().toISOString();
    process.stderr.write(`[${t}] [fleet-executor] ${JSON.stringify(msg)}\n`);
  },
};
