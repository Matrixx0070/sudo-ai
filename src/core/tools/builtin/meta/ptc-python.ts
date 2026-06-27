/**
 * @file ptc-python.ts
 * @description meta.ptc-python — Programmatic Tool Calling, Python variant (gap #15).
 *
 * The Python sibling of meta.ptc. Instead of a tool-call round-trip per step,
 * the model writes ONE Python script that calls host tools via a synchronous
 * `tool(name, args)` primitive. Hermes a1 ships execute_code in BOTH JS and
 * Python; this closes the Python half.
 *
 * Architecture:
 *   - A `python3 -u` subprocess runs ptc-python-harness.py.
 *   - Communication is a line-delimited JSON protocol over the child's
 *     stdin/stdout: the harness emits `{type:'tool-call',id,name,args}` and
 *     blocks until this file writes the matching `{type:'tool-result',id,...}`.
 *   - Each tool-call is dispatched through `registry.execute(name, args, ctx)`
 *     — the SAME permission / approval / sandbox-policy gates a normal tool
 *     call hits, NOT a privileged bypass.
 *
 * Trust posture (v1 / slice 1):
 *   - Opt-in: cli.ts registers this only when SUDO_PTC_PYTHON=1 (default OFF).
 *   - requiresConfirmation: the user approves the SCRIPT before it runs.
 *   - The subprocess gets a SCRUBBED env (no daemon secrets) and a workspace
 *     cwd. UNLIKE meta.ptc's sealed VM, Python `exec` is NOT a true sandbox —
 *     the script has full Python. bwrap confinement is a documented follow-up
 *     (the interactive tool() protocol needs streaming the one-shot exec
 *     sandbox doesn't provide). tool() is the *intended* gated escape.
 *
 * Limits: wall-clock timeout (default 60s, max 300s); MAX_TOOL_CALLS (50).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import type { ToolRegistry } from '../../registry.js';
import { createLogger } from '../../../shared/logger.js';
import { clampToolOutput } from '../../../shared/head-tail-buffer.js';

const logger = createLogger('meta.ptc-python');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_PATH = path.resolve(__dirname, '..', 'code', 'ptc-python-harness.py');

const MAX_TOOL_CALLS = 50;
const MAX_SCRIPT_CHARS = 100_000;
const DEFAULT_TIMEOUT_SEC = 60;
const MAX_TIMEOUT_SEC = 300;

// ---------------------------------------------------------------------------
// DI — the ToolRegistry the subprocess dispatches against (mirrors meta.ptc).
// ---------------------------------------------------------------------------

let _registry: ToolRegistry | null = null;

export function setPtcPythonRegistry(registry: ToolRegistry | null): void {
  if (registry !== null && !existsSync(HARNESS_PATH)) {
    logger.warn(
      { harnessPath: HARNESS_PATH },
      'PTC python harness file is missing — meta.ptc-python invocations will fail until it ships',
    );
  }
  _registry = registry;
}

// ---------------------------------------------------------------------------
// Protocol messages
// ---------------------------------------------------------------------------

interface ToolCallMsg { type: 'tool-call'; id: number; name: string; args: Record<string, unknown> }
interface DoneMsg { type: 'done'; stdout: string; value: unknown; callLog: Array<{ name: string; args: Record<string, unknown> }>; error: string | null }

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

/** Minimal env — NEVER hand the daemon's secrets (tokens, OAuth) to the script. */
function scrubbedEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env['HOME'] ?? '/tmp',
    LANG: process.env['LANG'] ?? 'C.UTF-8',
    PYTHONIOENCODING: 'utf-8',
    PYTHONDONTWRITEBYTECODE: '1',
  };
}

function runPtcPythonScript(
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
    let stdoutBuf = '';
    let stderrBuf = '';

    const cwd = ctx.workspaceDir ?? ctx.workingDir ?? process.cwd();
    const child = spawn('python3', ['-u', HARNESS_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env: scrubbedEnv(),
    });

    const settle = (result: PtcRunResult): void => {
      if (settled) return;
      settled = true;
      if (killTimer !== null) { clearTimeout(killTimer); killTimer = null; }
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve(result);
    };

    killTimer = setTimeout(() => {
      timedOut = true;
      settle({ stdout: '', stderr: stderrBuf, value: undefined, callLog: [], toolCallCount, timedOut: true, capped, error: `script timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    const writeToChild = (obj: unknown): void => {
      try { if (child.stdin.writable) child.stdin.write(JSON.stringify(obj) + '\n'); } catch { /* child gone */ }
    };

    const handleLine = (line: string): void => {
      let msg: ToolCallMsg | DoneMsg;
      try { msg = JSON.parse(line) as ToolCallMsg | DoneMsg; } catch { return; }
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'tool-call') {
        // Recursion guard before the cap so a refused re-entry doesn't burn a
        // slot; the bare `ptc-python` is rejected too (suffix-match bypass).
        if (msg.name === 'meta.ptc-python' || msg.name === 'ptc-python') {
          writeToChild({ type: 'tool-result', id: msg.id, error: 'meta.ptc-python cannot recursively invoke itself' });
          return;
        }
        if (toolCallCount >= MAX_TOOL_CALLS) {
          capped = true;
          writeToChild({ type: 'tool-result', id: msg.id, error: `MAX_TOOL_CALLS exceeded (${MAX_TOOL_CALLS}); cap the pipeline or split into multiple PTC turns` });
          return;
        }
        toolCallCount++;
        // worker.on('message')-style belt: async rejections must not vanish.
        (async () => {
          try {
            const result = await registry.execute(msg.name, msg.args ?? {}, ctx);
            writeToChild({ type: 'tool-result', id: msg.id, result });
          } catch (err) {
            writeToChild({ type: 'tool-result', id: msg.id, error: err instanceof Error ? err.message : String(err) });
          }
        })().catch((err) => {
          logger.warn({ err: String(err) }, 'ptc-python tool-call handler threw');
          writeToChild({ type: 'tool-result', id: msg.id, error: err instanceof Error ? err.message : String(err) });
        });
        return;
      }

      if (msg.type === 'done') {
        settle({
          stdout: typeof msg.stdout === 'string' ? msg.stdout : '',
          stderr: stderrBuf,
          value: msg.value,
          callLog: Array.isArray(msg.callLog) ? msg.callLog : [],
          toolCallCount,
          timedOut: false,
          capped,
          error: msg.error ?? null,
        });
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line.trim()) handleLine(line);
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrBuf += chunk;
      if (stderrBuf.length > 64_000) stderrBuf = stderrBuf.slice(-64_000);
    });

    child.on('error', (err) => {
      settle({ stdout: '', stderr: String(err), value: undefined, callLog: [], toolCallCount, timedOut, capped, error: String(err) });
    });

    child.on('exit', (code) => {
      if (!settled) {
        settle({ stdout: '', stderr: stderrBuf, value: undefined, callLog: [], toolCallCount, timedOut, capped, error: code !== 0 ? `python exited with code ${code}` : 'python exited before completing the protocol' });
      }
    });

    // Kick off: send the init line carrying the user script.
    writeToChild({ type: 'init', script });
  });
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const ptcPythonTool: ToolDefinition = {
  name: 'meta.ptc-python',
  description:
    'Programmatic Tool Calling (Python) — run a Python 3 script that calls other host tools via a ' +
    'synchronous `tool("name", {arg: value})` primitive. Collapse multi-step pipelines into ONE model ' +
    'turn. `print(...)` is captured as stdout; set a `result = <value>` global to surface a return value. ' +
    'Each tool() goes through the normal permission/approval gates. The script runs in a python3 ' +
    'subprocess (scrubbed env, workspace cwd) — full Python, so this is opt-in and the script is approved ' +
    `before it runs. Max ${MAX_TOOL_CALLS} tool calls; default ${DEFAULT_TIMEOUT_SEC}s timeout.`,
  category: 'meta' as const,
  safety: 'destructive',
  requiresConfirmation: true,
  timeout: (MAX_TIMEOUT_SEC + 5) * 1000,
  parameters: {
    script: {
      type: 'string',
      required: true,
      description:
        'Python 3 source. Call `tool("name", {arg: value})` (synchronous) to invoke host tools, `print(...)` ' +
        'for stdout, and set `result = <expr>` to return a value in result.data.value.',
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
      return { success: false, output: 'meta.ptc-python: tool registry has not been injected. Call setPtcPythonRegistry() during boot (cli.ts wires this when SUDO_PTC_PYTHON=1).' };
    }

    const script = typeof params['script'] === 'string' ? (params['script'] as string) : '';
    if (script.trim().length === 0) return { success: false, output: 'meta.ptc-python: script must be a non-empty string' };
    if (script.length > MAX_SCRIPT_CHARS) return { success: false, output: `meta.ptc-python: script exceeds ${MAX_SCRIPT_CHARS} characters` };

    const rawTimeout = params['timeout_seconds'];
    const timeoutSec = typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? Math.min(rawTimeout, MAX_TIMEOUT_SEC)
      : DEFAULT_TIMEOUT_SEC;
    const timeoutMs = timeoutSec * 1000;

    logger.info({ sessionId: ctx.sessionId, scriptLen: script.length, timeoutSec }, 'Running PTC-python script');

    const result = await runPtcPythonScript(script, ctx, registry, timeoutMs);

    const parts: string[] = [];
    if (result.timedOut) parts.push(`[TIMED OUT after ${timeoutMs}ms]`);
    if (result.capped) parts.push(`[CAPPED: max ${MAX_TOOL_CALLS} tool calls per script]`);
    if (result.error) parts.push(`error: ${result.error}`);
    if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
    if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
    if (result.value !== undefined && result.value !== null) {
      try { parts.push(`return value: ${JSON.stringify(result.value)}`); } catch { parts.push('return value: [non-serializable]'); }
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
