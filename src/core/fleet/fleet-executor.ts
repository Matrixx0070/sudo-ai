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

/**
 * Autonomy handle the executor needs — gap #28d slice 1.
 *
 * Duck-typed against WakeSleepCycle so the executor stays decoupled from
 * the autonomy module's full surface. cli.ts hands a slim adapter that
 * forwards to the live cycle once SUDO_AUTONOMY_V1 has wired one up.
 *
 * status() returns the canonical fleet-visible snapshot — fields are the
 * union of WakeSleepCycle.pause()/resume() return shapes, normalized so
 * the admin UI can render any of the three commands' results uniformly.
 */
export interface ExecutorAutonomyHandle {
  pause(): { state: string; paused: true; activeCount: number };
  resume(): { state: string; paused: false; activeCount: number };
  status(): { state: string; paused: boolean; activeCount: number };
}

/**
 * Alignment digest handle the executor needs — gap #28d slice 2.
 *
 * Duck-typed against `AlignmentDigestSource.getDigest()` (the same shape
 * the dashboard's `__sudoAlignment` global uses). The slim wrapper in
 * cli.ts forwards both consumers to one closure — fleet rollup and the
 * local dashboard's `/api/alignment` see the exact same snapshot.
 *
 * digest() returns `undefined` when the AlignmentAggregator has no report
 * yet — the executor surfaces that as `failed/alignment_unavailable` so
 * the admin rollup can distinguish "no digest produced yet" from "device
 * never ran alignment.digest".
 */
export interface ExecutorAlignmentHandle {
  digest(): { overallScore?: number; signals?: Record<string, number> } | undefined;
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
  /**
   * Autonomy handle (gap #28d slice 1). When absent the executor still
   * polls — but autonomy.* commands return `failed` with reason
   * "autonomy_not_enabled". cli.ts may wire this in after the executor
   * starts via the returned handle's `setAutonomy()` setter (the autonomy
   * cycle is constructed later in boot than the executor).
   */
  autonomy?: ExecutorAutonomyHandle;
  /**
   * Alignment digest handle (gap #28d slice 2). The alignment aggregator
   * is wired into `__sudoAlignment` BEFORE the executor starts, so this
   * is passed at construct time (no late-bind setter needed — unlike the
   * autonomy cycle in slice 1). When absent, `alignment.digest` commands
   * return `failed/alignment_not_enabled`.
   */
  alignment?: ExecutorAlignmentHandle;
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
  /**
   * Late-bind an autonomy handle (gap #28d slice 1). cli.ts constructs the
   * WakeSleepCycle AFTER the fleet executor starts, so passing the handle
   * at startFleetExecutor() time isn't always possible. Pass `undefined` to
   * detach (e.g. on autonomy shutdown). Idempotent.
   */
  setAutonomy(handle: ExecutorAutonomyHandle | undefined): void;
  /**
   * Hot-swap the alignment handle (gap #28d slice 2). cli.ts wires this at
   * construct time today, but the setter keeps the API symmetric with
   * setAutonomy() and lets future callers detach on subsystem shutdown.
   */
  setAlignment(handle: ExecutorAlignmentHandle | undefined): void;
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
  // Mutable so setAutonomy() can late-bind / detach after start.
  let autonomy: ExecutorAutonomyHandle | undefined = opts.autonomy;
  // Same hot-swap pattern as autonomy: cli.ts wires alignment at construct
  // time today (slice 2), but a setter keeps the API symmetric and lets
  // future callers detach on alignment subsystem shutdown.
  let alignment: ExecutorAlignmentHandle | undefined = opts.alignment;

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
        // Got a command. Run + report. All handles are read fresh on each
        // dispatch so late-bound autonomy via setAutonomy() (or alignment
        // via setAlignment()) takes effect on the very next admin command.
        const result = await runCommand(cmd, opts.brain, autonomy, alignment);
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
    setAutonomy(handle: ExecutorAutonomyHandle | undefined): void {
      autonomy = handle;
    },
    setAlignment(handle: ExecutorAlignmentHandle | undefined): void {
      alignment = handle;
    },
  };
}

/**
 * Run a single command against the local brain/autonomy/alignment handles.
 *
 * - `model.{get,set}` — gap #28c slice 2 (brain-backed)
 * - `autonomy.{pause,resume,status}` — gap #28d slice 1 (autonomy-backed)
 * - `alignment.digest` — gap #28d slice 2 (alignment-aggregator-backed)
 *
 * Unknown kinds return `failed/unsupported_kind:<k>` rather than throwing
 * so the admin sees the error rather than the executor's outer backoff loop
 * silently retrying.
 */
export async function runCommand(
  cmd: { commandId: string; kind: string; args?: Record<string, unknown> },
  brain: ExecutorBrainHandle | undefined,
  autonomy?: ExecutorAutonomyHandle,
  alignment?: ExecutorAlignmentHandle,
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
    if (cmd.kind === 'autonomy.pause') {
      if (!autonomy) return { status: 'failed', error: 'autonomy_not_enabled' };
      return { status: 'completed', result: autonomy.pause() };
    }
    if (cmd.kind === 'autonomy.resume') {
      if (!autonomy) return { status: 'failed', error: 'autonomy_not_enabled' };
      return { status: 'completed', result: autonomy.resume() };
    }
    if (cmd.kind === 'autonomy.status') {
      if (!autonomy) return { status: 'failed', error: 'autonomy_not_enabled' };
      return { status: 'completed', result: autonomy.status() };
    }
    if (cmd.kind === 'alignment.digest') {
      if (!alignment) return { status: 'failed', error: 'alignment_not_enabled' };
      const d = alignment.digest();
      // No report produced yet — distinct from "no handle" so admin rollup
      // can show "device awaiting first alignment turn" vs. "device opted
      // out of alignment".
      if (d === undefined) return { status: 'failed', error: 'alignment_unavailable' };
      return {
        status: 'completed',
        result: {
          overallScore: d.overallScore ?? 0,
          signals: d.signals ?? {},
          at: new Date().toISOString(),
        },
      };
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
