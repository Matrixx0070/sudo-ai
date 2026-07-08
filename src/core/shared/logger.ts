/**
 * Structured logger using pino.
 * Outputs JSON to data/logs/sudo-ai.log and human-readable lines to stdout.
 */

import pino, { type Logger } from 'pino';
import path from 'path';
import { mkdirSync } from 'fs';
import { DATA_DIR } from './paths.js';

const LOG_DIR = path.join(DATA_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'sudo-ai.log');

// Vitest points SUDO_AI_HOME/DATA_DIR at temp dirs removed in afterEach; a
// file-transport worker racing that cleanup throws an unhandled ENOENT, so
// skip the file target (and dir creation) under test.
const isTest = process.env['VITEST'] !== undefined;

// Ensure the log directory exists before pino tries to open the file.
if (!isTest) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
  } catch (err) {
    // Non-fatal: if we cannot create the dir, file transport will simply fail.
    process.stderr.write(`[logger] Cannot create log dir ${LOG_DIR}: ${String(err)}\n`);
  }
}

const isDev = process.env['NODE_ENV'] !== 'production';

/**
 * Build a pino transport configuration.
 * In development: pretty-print to stdout + raw JSON to file.
 * In production:  raw JSON to both stdout and file.
 */
function buildTransport(): pino.TransportMultiOptions {
  // fd 1 = stdout (default). Stdio-protocol entrypoints (ACP / MCP) own stdout
  // for their JSON-RPC channel, so they set SUDO_LOG_STDERR=1 to push human logs
  // to fd 2 (stderr) and keep the protocol stream clean. Applies to BOTH the dev
  // pretty target and the prod JSON target. Default (unset) is unchanged.
  const logFd = process.env['SUDO_LOG_STDERR'] === '1' ? 2 : 1;

  const fileTarget: pino.TransportTargetOptions = {
    target: 'pino/file',
    level: 'trace',
    options: { destination: LOG_FILE, append: true, mkdir: true },
  };

  if (isDev) {
    const prettyTarget: pino.TransportTargetOptions = {
      target: 'pino-pretty',
      level: 'trace',
      options: {
        destination: logFd,
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
        messageFormat: '[{module}] {msg}',
      },
    };
    return { targets: [prettyTarget, fileTarget] };
  }

  const stdoutTarget: pino.TransportTargetOptions = {
    target: 'pino/file',
    level: 'info',
    options: { destination: logFd },
  };

  return { targets: [stdoutTarget, fileTarget] };
}

const baseOptions: pino.LoggerOptions = {
  level: process.env['LOG_LEVEL'] ?? 'info',
  base: { pid: process.pid },
  timestamp: pino.stdTimeFunctions.isoTime,
};

/**
 * Default application-level logger. Multi-transport: pretty stdout in dev, JSON to file in prod.
 *
 * Under vitest, module isolation re-imports this file for every test file, and `pino.transport()`
 * spawns a thread-stream worker that registers a `process.on('exit')` flush handler
 * (pino/lib/transport.js → buildStream → process.addListener('exit')). Across 11+ test files in
 * one worker those handlers accumulate on the shared `process` object and trip Node's
 * MaxListenersExceededWarning ("11 exit listeners added to [process]") — plus a needless worker
 * thread per file. Tests don't need the worker transport, so log synchronously to stdout (no
 * worker, no exit handler). Production imports this module once, so the daemon registers exactly
 * one handler and is unaffected.
 */
const transportStream: pino.DestinationStream | null = isTest
  ? null
  : pino.transport(buildTransport());

export const logger: Logger = transportStream === null
  ? pino(baseOptions)
  : pino(baseOptions, transportStream);

let closePromise: Promise<void> | null = null;

/**
 * Flush and close the worker-thread transport so a one-shot CLI command can
 * exit cleanly.
 *
 * pino.transport() registers a process 'exit' hook that calls the
 * thread-stream's flushSync(); when a CLI command calls process.exit() the
 * event loop is already stopping, the worker can no longer acknowledge the
 * flush, and after 10s the hook throws "_flushSync took too long (10s)" out
 * of the process.exit() call site. Ending the stream emits 'close', which
 * pino uses to UNREGISTER that exit hook — so exit becomes clean.
 *
 * Bounded by `timeoutMs` (unref'd) so a wedged worker can never hang the CLI.
 * Idempotent: repeated calls return the same promise. No-op under vitest
 * (no worker transport is created there).
 */
export function closeLogger(timeoutMs = 5_000): Promise<void> {
  if (transportStream === null) return Promise.resolve();
  if (closePromise) return closePromise;

  closePromise = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref();
    const stream = transportStream as unknown as {
      once?: (ev: string, fn: () => void) => void;
      end?: () => void;
    };
    try {
      stream.once?.('close', () => {
        clearTimeout(timer);
        resolve();
      });
      logger.flush();
      stream.end?.();
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
  return closePromise;
}

/**
 * Create a child logger scoped to a named module.
 *
 * @param module - Short module/subsystem name (e.g. 'config', 'memory').
 * @returns A child pino.Logger with a `module` binding.
 */
export function createLogger(module: string): Logger {
  if (!module || typeof module !== 'string') {
    throw new TypeError('createLogger: module name must be a non-empty string');
  }
  return logger.child({ module });
}
