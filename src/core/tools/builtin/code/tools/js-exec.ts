/**
 * code.js-exec — Node.js sandboxed code execution via vm.createContext + worker_threads.
 *
 * Architecture:
 *   - Each call spawns a Worker referencing js-worker.cjs (CommonJS, required for vm + require())
 *   - The worker receives code + context snapshot via workerData
 *   - Inside the Worker, vm.createContext isolates execution; no require/process/fs/global
 *   - stdout/stderr are captured by overriding console in the VM context
 *   - Per-session context persistence: after execution, JSON-serializable vars are
 *     stored in session-kernels for the next call with the same sessionId
 *   - Memory limit: 128 MB via resourceLimits.maxOldGenerationSizeMb
 *   - Timeout: worker.terminate() after timeout ms
 *
 * The worker is a .cjs file because the project uses "type":"module" (ESM) and
 * Worker eval:true scripts inherit ESM mode in Node 22+, which prevents require().
 * A physical .cjs file forces CommonJS loading regardless of package.json type.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { getOrCreateEntry, touchEntry } from '../session-kernels.js';
import { createLogger } from '../../../../shared/logger.js';

const logger = createLogger('code.js-exec');

// Resolve path to the CJS worker file (sibling of this file's directory)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_CJS_PATH = path.resolve(__dirname, '..', 'js-worker.cjs');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JsExecResult {
  stdout: string;
  stderr: string;
  value: unknown;
  executionTimeMs: number;
  timedOut: boolean;
}

interface WorkerOutput {
  stdout: string;
  stderr: string;
  value: unknown;
  error: string | null;
  contextSnapshot: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/**
 * Validate code string — must be a non-empty string within size limit.
 */
function validateCode(code: unknown): string {
  if (typeof code !== 'string' || code.trim().length === 0) {
    throw new Error('code must be a non-empty string');
  }
  if (code.length > 100_000) {
    throw new Error('code exceeds maximum length of 100,000 characters');
  }
  return code;
}

// ---------------------------------------------------------------------------
// Core execution logic
// ---------------------------------------------------------------------------

/**
 * Execute JS code in a sandboxed Worker thread (CJS worker via js-worker.cjs).
 */
async function execJsSandbox(
  code: string,
  sessionId: string,
  timeoutMs: number,
): Promise<JsExecResult> {
  const entry = getOrCreateEntry(sessionId);
  const contextSnapshot: Record<string, unknown> = entry.jsContext ?? {};

  const start = Date.now();

  return new Promise<JsExecResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let terminateTimer: ReturnType<typeof setTimeout> | null = null;

    const worker = new Worker(WORKER_CJS_PATH, {
      workerData: { code, contextSnapshot },
      resourceLimits: {
        maxOldGenerationSizeMb: 128,
        maxYoungGenerationSizeMb: 32,
      },
    });

    const settle = (result: JsExecResult): void => {
      if (settled) return;
      settled = true;
      if (terminateTimer !== null) {
        clearTimeout(terminateTimer);
        terminateTimer = null;
      }
      resolve(result);
    };

    // Outer timeout: terminate the worker if it runs too long
    terminateTimer = setTimeout(() => {
      timedOut = true;
      worker.terminate().catch(() => { /* ignore */ });
      settle({
        stdout: '',
        stderr: '',
        value: undefined,
        executionTimeMs: Date.now() - start,
        timedOut: true,
      });
    }, timeoutMs);

    worker.on('message', (msg: WorkerOutput) => {
      const durationMs = Date.now() - start;

      // Persist updated context snapshot for next call
      if (msg.contextSnapshot && typeof msg.contextSnapshot === 'object') {
        entry.jsContext = msg.contextSnapshot;
        touchEntry(sessionId);
      }

      let stderr = msg.stderr ?? '';
      if (msg.error) {
        stderr = stderr ? `${stderr}\n${msg.error}` : msg.error;
      }

      settle({
        stdout: msg.stdout ?? '',
        stderr,
        value: msg.value,
        executionTimeMs: durationMs,
        timedOut: false,
      });
      worker.terminate().catch(() => { /* ignore */ });
    });

    worker.on('error', (err) => {
      settle({
        stdout: '',
        stderr: String(err),
        value: undefined,
        executionTimeMs: Date.now() - start,
        timedOut,
      });
    });

    worker.on('exit', (code) => {
      if (!settled) {
        settle({
          stdout: '',
          stderr: code !== 0 ? `Worker exited with code ${code}` : '',
          value: undefined,
          executionTimeMs: Date.now() - start,
          timedOut,
        });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const jsExecTool: ToolDefinition = {
  name: 'code.js-exec',
  description:
    'Execute JavaScript code in a secure sandboxed Node.js environment. ' +
    'Captures stdout (console.log), stderr (console.error), and return value. ' +
    'Supports session-persistent variables across calls using the same sessionId. ' +
    'Blocked globals: require, process, fs, globalThis, global. ' +
    'Safe globals: console, JSON, Math, Number, String, Array, Object, Date, Promise, Error.',
  category: 'coder',
  requiresConfirmation: false,
  safety: 'destructive',
  timeout: 30_000,
  parameters: {
    code: {
      type: 'string',
      description: 'JavaScript code to execute. Use console.log() for output. The last expression is returned as the value.',
      required: true,
    },
    sessionId: {
      type: 'string',
      description:
        'Optional session identifier for context persistence. Same sessionId reuses the same variable scope across calls.',
    },
    timeout: {
      type: 'number',
      description: 'Execution timeout in milliseconds. Default: 5000. Max: 30000.',
      default: 5000,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const startMs = Date.now();
    let code: string;

    try {
      code = validateCode(params['code']);
    } catch (err) {
      return {
        success: false,
        output: `Validation error: ${String(err)}`,
        data: { error: String(err) },
      };
    }

    const sessionId = typeof params['sessionId'] === 'string' && params['sessionId'].length > 0
      ? params['sessionId']
      : ctx.sessionId;

    const rawTimeout = params['timeout'];
    const timeoutMs = typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? Math.min(rawTimeout, 30_000)
      : 5_000;

    logger.info(
      { event: 'code.exec', runtime: 'js', sessionId, codeLen: code.length },
      'Executing JS code in sandbox',
    );

    let result: JsExecResult;
    try {
      result = await execJsSandbox(code, sessionId, timeoutMs);
    } catch (err) {
      const durationMs = Date.now() - startMs;
      logger.error(
        { event: 'code.exec', runtime: 'js', sessionId, durationMs, err: String(err) },
        'JS sandbox infrastructure failure',
      );
      return {
        success: false,
        output: `Sandbox error: ${String(err)}`,
        data: { error: String(err), executionTimeMs: durationMs, timedOut: false },
      };
    }

    logger.info(
      {
        event: 'code.exec',
        runtime: 'js',
        sessionId,
        codeLen: code.length,
        stdout1kb: result.stdout.slice(0, 1024),
        stderr1kb: result.stderr.slice(0, 1024),
        durationMs: result.executionTimeMs,
        exitCode: result.timedOut ? -1 : 0,
      },
      'JS sandbox execution complete',
    );

    const outputParts: string[] = [];
    if (result.timedOut) {
      outputParts.push(`[TIMED OUT after ${timeoutMs}ms]`);
    }
    if (result.stdout) {
      outputParts.push(`stdout:\n${result.stdout}`);
    }
    if (result.stderr) {
      outputParts.push(`stderr:\n${result.stderr}`);
    }
    if (result.value !== undefined) {
      try {
        outputParts.push(`return value: ${JSON.stringify(result.value)}`);
      } catch {
        outputParts.push(`return value: [non-serializable]`);
      }
    }
    const output = outputParts.join('\n') || '(no output)';

    // success = ran without timeout and no exception-level stderr
    // Note: console.error() output in stderr does not indicate failure
    const hasError = result.stderr.includes('Error:') || result.stderr.includes('SyntaxError') || result.stderr.includes('ReferenceError');

    return {
      success: !result.timedOut && !hasError,
      output,
      data: result,
    };
  },
};
