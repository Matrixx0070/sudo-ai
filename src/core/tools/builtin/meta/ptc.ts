/**
 * @file ptc.ts
 * @description meta.ptc — Programmatic Tool Calling (gap #15).
 *
 * Hermes a1's "clearest capability gap": instead of a tool-call round-trip
 * per step, the model writes ONE JS script that calls multiple host tools
 * via an injected async `tool(name, args)` primitive. An N-step pipeline
 * (read three files, compute, write a result) becomes one model turn plus
 * N intra-script tool dispatches instead of N+1 model turns.
 *
 * Architecture:
 *   - Worker spawned from ptc-worker.cjs (CJS-forced; see js-worker.cjs
 *     header for the ESM-vs-CJS reason).
 *   - The worker exposes `tool(name, args)` and `print(...)` inside its
 *     sandbox; `await tool(...)` is the model's escape hatch back to the
 *     host registry.
 *   - For every `{type:'tool-call'}` message the worker emits, this file
 *     dispatches `registry.execute(name, args, ctx)` — so each call hits
 *     the same permission / approval / sandbox-policy gates a normal tool
 *     call would, NOT a privileged bypass.
 *   - The result (or thrown error) is posted back to the worker.
 *
 * Opt-in: cli.ts registers this tool only when SUDO_PTC=1, mirroring the
 * trust posture of SUDO_USER_HOOKS / SUDO_PLUGINS. When the flag is OFF
 * the tool is not in the registry at all.
 *
 * Limits:
 *   - Total wall-clock cap: timeout_seconds (default 60, max 300).
 *   - Max in-flight tool calls per script: MAX_TOOL_CALLS (50).
 *   - Worker resource limits inherit js-worker.cjs's 128 MB heap.
 */

import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import type { ToolRegistry } from '../../registry.js';
import { createLogger } from '../../../shared/logger.js';
import { clampToolOutput } from '../../../shared/head-tail-buffer.js';

const logger = createLogger('meta.ptc');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_CJS_PATH = path.resolve(__dirname, '..', 'code', 'ptc-worker.cjs');

const MAX_TOOL_CALLS = 50;
const MAX_SCRIPT_CHARS = 100_000;
const DEFAULT_TIMEOUT_SEC = 60;
const MAX_TIMEOUT_SEC = 300;

// ---------------------------------------------------------------------------
// Dependency injection — the ToolRegistry the worker dispatches against.
// Set via setPtcRegistry() from cli.ts §9.6b after the registry is fully
// built. Standalone export instead of the unified injectMetaToolDeps because
// only meta.ptc needs the registry; pulling it into the shared deps map
// would change every meta tool's signature for a single consumer.
// ---------------------------------------------------------------------------

let _registry: ToolRegistry | null = null;

export function setPtcRegistry(registry: ToolRegistry | null): void {
  // Warn on flag boot when the runtime asset is missing (dist build skipped
  // the cjs copy, or someone removed it). The CI gotcha — tests run before
  // build — means a runtime check at use-time would fail less informatively.
  if (registry !== null && !existsSync(WORKER_CJS_PATH)) {
    logger.warn(
      { workerPath: WORKER_CJS_PATH },
      'PTC worker .cjs file is missing — meta.ptc invocations will fail until it ships',
    );
  }
  _registry = registry;
}

// ---------------------------------------------------------------------------
// Worker protocol types
// ---------------------------------------------------------------------------

interface WorkerToolCallMsg {
  type: 'tool-call';
  id: number;
  name: string;
  args: Record<string, unknown>;
}

interface WorkerDoneMsg {
  type: 'done';
  stdout: string;
  stderr: string;
  value: unknown;
  callLog: Array<{ name: string; args: Record<string, unknown> }>;
  error: string | null;
}

type WorkerMsg = WorkerToolCallMsg | WorkerDoneMsg;

// ---------------------------------------------------------------------------
// Core: spawn a PTC worker, route tool calls through registry.execute()
// ---------------------------------------------------------------------------

interface PtcRunResult {
  stdout: string;
  stderr: string;
  value: unknown;
  callLog: Array<{ name: string; args: Record<string, unknown> }>;
  toolCallCount: number;
  timedOut: boolean;
  capped: boolean;
  error: string | null;
}

function runPtcScript(
  script: string,
  ctx: ToolContext,
  registry: ToolRegistry,
  timeoutMs: number,
): Promise<PtcRunResult> {
  return new Promise<PtcRunResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let capped = false;
    let toolCallCount = 0;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const worker = new Worker(WORKER_CJS_PATH, {
      workerData: { script },
      resourceLimits: {
        maxOldGenerationSizeMb: 128,
        maxYoungGenerationSizeMb: 32,
      },
    });

    const settle = (result: PtcRunResult): void => {
      if (settled) return;
      settled = true;
      if (killTimer !== null) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      worker.terminate().catch(() => { /* ignore */ });
      resolve(result);
    };

    killTimer = setTimeout(() => {
      timedOut = true;
      settle({
        stdout: '',
        stderr: '',
        value: undefined,
        callLog: [],
        toolCallCount,
        timedOut: true,
        capped,
        error: `script timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    worker.on('message', (msg: WorkerMsg) => {
      // Outer try/catch belt — worker.on('message') silently swallows
      // rejections from async handlers, so any unexpected throw outside the
      // inner try below would otherwise vanish.
      (async () => {
        if (!msg || typeof msg !== 'object') return;

        if (msg.type === 'tool-call') {
          // Recursion guard runs BEFORE the cap counter so a refused
          // re-entry doesn't burn a slot from the model's budget. The bare
          // name `ptc` is also rejected to close the Ollama prefix-strip
          // path (registry suffix-match would otherwise resolve `ptc` to
          // `meta.ptc` and bypass an exact-name check).
          if (msg.name === 'meta.ptc' || msg.name === 'ptc') {
            worker.postMessage({
              type: 'tool-result',
              id: msg.id,
              error: 'meta.ptc cannot recursively invoke itself',
            });
            return;
          }
          if (toolCallCount >= MAX_TOOL_CALLS) {
            capped = true;
            worker.postMessage({
              type: 'tool-result',
              id: msg.id,
              error: `MAX_TOOL_CALLS exceeded (${MAX_TOOL_CALLS}); cap the pipeline or split into multiple PTC turns`,
            });
            return;
          }
          toolCallCount++;
          try {
            const result = await registry.execute(msg.name, msg.args, ctx);
            worker.postMessage({ type: 'tool-result', id: msg.id, result });
          } catch (err) {
            worker.postMessage({
              type: 'tool-result',
              id: msg.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return;
        }

        if (msg.type === 'done') {
          settle({
            stdout: msg.stdout,
            stderr: msg.stderr,
            value: msg.value,
            callLog: msg.callLog,
            toolCallCount,
            timedOut: false,
            capped,
            error: msg.error,
          });
        }
      })().catch((err) => {
        logger.warn({ err: String(err) }, 'PTC worker message handler threw — settling with error');
        settle({
          stdout: '',
          stderr: '',
          value: undefined,
          callLog: [],
          toolCallCount,
          timedOut: false,
          capped,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    worker.on('error', (err) => {
      settle({
        stdout: '',
        stderr: String(err),
        value: undefined,
        callLog: [],
        toolCallCount,
        timedOut,
        capped,
        error: String(err),
      });
    });

    worker.on('exit', (code) => {
      if (!settled) {
        settle({
          stdout: '',
          stderr: code !== 0 ? `worker exited with code ${code}` : '',
          value: undefined,
          callLog: [],
          toolCallCount,
          timedOut,
          capped,
          error: code !== 0 ? `worker exited with code ${code}` : null,
        });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const ptcTool: ToolDefinition = {
  name: 'meta.ptc',
  description:
    'Programmatic Tool Calling — execute a JS script that calls other host tools via ' +
    'an injected async `tool(name, args)` primitive. Collapse multi-step pipelines ' +
    '(read+compute+write) into ONE model turn. The script runs in a sealed VM ' +
    '(no fs/network/require); every tool() invocation goes through the normal ' +
    'permission/approval gates. Use `print(...)` for stdout. ' +
    `Max ${MAX_TOOL_CALLS} tool calls per script; default ${DEFAULT_TIMEOUT_SEC}s timeout.`,
  category: 'meta' as const,
  safety: 'destructive',
  // The outer ptcTool call decides which inner tools get invoked and with
  // what args — the user must approve the SCRIPT before the sandbox starts,
  // not just the individual inner tool calls' own gates. Without this, the
  // model can write a script that calls system.shell-exec / coder.write-file
  // whose command/path strings were never shown to the user.
  requiresConfirmation: true,
  timeout: (MAX_TIMEOUT_SEC + 5) * 1000,
  parameters: {
    script: {
      type: 'string',
      required: true,
      description:
        'JavaScript code. Use `await tool("name", {arg: value})` to invoke other tools, ' +
        '`print(...)` for stdout. The script body runs inside an async IIFE — use ' +
        '`return <expr>;` to surface a return value in `result.data.value`.',
    },
    timeout_seconds: {
      type: 'number',
      description: `Wall-clock cap in seconds. Default ${DEFAULT_TIMEOUT_SEC}, max ${MAX_TIMEOUT_SEC}.`,
      default: DEFAULT_TIMEOUT_SEC,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const registry = _registry;
    if (!registry) {
      return {
        success: false,
        output:
          'meta.ptc: tool registry has not been injected. ' +
          'Call setPtcRegistry() during boot (cli.ts wires this when SUDO_PTC=1).',
      };
    }

    const script = typeof params['script'] === 'string' ? (params['script'] as string) : '';
    if (script.trim().length === 0) {
      return { success: false, output: 'meta.ptc: script must be a non-empty string' };
    }
    if (script.length > MAX_SCRIPT_CHARS) {
      return {
        success: false,
        output: `meta.ptc: script exceeds ${MAX_SCRIPT_CHARS} characters`,
      };
    }

    const rawTimeout = params['timeout_seconds'];
    const timeoutSec =
      typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
        ? Math.min(rawTimeout, MAX_TIMEOUT_SEC)
        : DEFAULT_TIMEOUT_SEC;
    const timeoutMs = timeoutSec * 1000;

    logger.info(
      { sessionId: ctx.sessionId, scriptLen: script.length, timeoutSec },
      'Running PTC script',
    );

    const result = await runPtcScript(script, ctx, registry, timeoutMs);

    const parts: string[] = [];
    if (result.timedOut) parts.push(`[TIMED OUT after ${timeoutMs}ms]`);
    if (result.capped) parts.push(`[CAPPED: max ${MAX_TOOL_CALLS} tool calls per script]`);
    if (result.error) parts.push(`error: ${result.error}`);
    if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
    if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
    if (result.value !== undefined && result.value !== null) {
      try {
        parts.push(`return value: ${JSON.stringify(result.value)}`);
      } catch {
        parts.push('return value: [non-serializable]');
      }
    }
    parts.push(`tool calls dispatched: ${result.toolCallCount}`);

    const { text: output, truncated } = clampToolOutput(parts.join('\n') || '(no output)');

    return {
      success: !result.timedOut && !result.capped && !result.error,
      output,
      data: {
        stdout: result.stdout,
        stderr: result.stderr,
        value: result.value,
        callLog: result.callLog,
        toolCallCount: result.toolCallCount,
        timedOut: result.timedOut,
        capped: result.capped,
        error: result.error,
        truncated,
      },
    };
  },
};
