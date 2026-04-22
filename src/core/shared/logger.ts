/**
 * Structured logger using pino.
 * Outputs JSON to data/logs/sudo-ai.log and human-readable lines to stdout.
 */

import pino, { type Logger } from 'pino';
import path from 'path';
import { mkdirSync } from 'fs';

const LOG_DIR = path.resolve('data/logs');
const LOG_FILE = path.join(LOG_DIR, 'sudo-ai.log');

// Ensure the log directory exists before pino tries to open the file.
try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch (err) {
  // Non-fatal: if we cannot create the dir, file transport will simply fail.
  process.stderr.write(`[logger] Cannot create log dir ${LOG_DIR}: ${String(err)}\n`);
}

const isDev = process.env['NODE_ENV'] !== 'production';

/**
 * Build a pino transport configuration.
 * In development: pretty-print to stdout + raw JSON to file.
 * In production:  raw JSON to both stdout and file.
 */
function buildTransport(): pino.TransportMultiOptions {
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
    options: { destination: 1 }, // fd 1 = stdout
  };

  return { targets: [stdoutTarget, fileTarget] };
}

const baseOptions: pino.LoggerOptions = {
  level: process.env['LOG_LEVEL'] ?? 'info',
  base: { pid: process.pid },
  timestamp: pino.stdTimeFunctions.isoTime,
};

/** Default application-level logger. Multi-transport: pretty stdout in dev, JSON to file in prod. */
export const logger: Logger = pino(baseOptions, pino.transport(buildTransport()));

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
