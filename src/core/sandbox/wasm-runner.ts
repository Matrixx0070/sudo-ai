/**
 * @file sandbox/wasm-runner.ts
 * @description wasmtime-based WASM module runner for SUDO-AI.
 *
 * Invokes the `wasmtime` CLI binary as a subprocess using spawnSync with
 * array arguments (no shell interpolation — per constraint L.9).
 *
 * Availability:
 *   On init, checks `wasmtime --version`. If not found, exports isAvailable=false
 *   and run() returns a graceful error object.
 *
 * This runner COEXISTS with the existing bwrap sandbox (sandbox-runner.ts).
 * It does NOT replace it. Enable with env var SUDO_WASM_SANDBOX=1.
 *
 * @module sandbox/wasm-runner
 */

import { spawnSync } from 'node:child_process';
import { createLogger } from '../shared/logger.js';

const log = createLogger('sandbox:wasm-runner');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WasmRunInput {
  /** Absolute path to the .wasm module file. */
  module: string;
  /** Optional stdin to pass to the WASM module. */
  input?: string;
  /** Timeout in milliseconds (default: 10,000 ms). */
  timeout_ms?: number;
  /**
   * Optional extra wasmtime CLI flags (array, never shell-interpolated).
   *
   * RESTRICTION: The following flags are rejected to prevent filesystem and
   * environment escapes:
   *   --dir, --mapdir, --env, --inherit-env
   *   and their `=`-prefixed variants (--dir=, --mapdir=, --env=).
   * Passing any of these will throw: Error('wasm-runner: extraArg "<arg>" rejected (filesystem/env escapes forbidden)').
   */
  extraArgs?: string[];
}

export interface WasmRunResult {
  stdout: string;
  stderr: string;
  exit: number;
  timedOut: boolean;
}

// ---------------------------------------------------------------------------
// Availability check (lazy, cached at module load)
// ---------------------------------------------------------------------------

let _isAvailable: boolean | null = null;

/**
 * Check whether wasmtime is available in PATH.
 * Result is cached after first call.
 */
export function checkWasmAvailability(): boolean {
  if (_isAvailable !== null) return _isAvailable;

  try {
    const result = spawnSync('wasmtime', ['--version'], {
      encoding: 'utf8',
      timeout: 3000,
    });
    _isAvailable = result.status === 0 && !result.error;
  } catch {
    _isAvailable = false;
  }

  if (_isAvailable) {
    log.info('wasmtime found in PATH — WASM sandbox available');
  } else {
    log.warn('wasmtime not found in PATH — WASM sandbox unavailable (SUDO_WASM_SANDBOX=1 will be ignored)');
  }

  return _isAvailable;
}

/** True if wasmtime CLI is available in PATH. Evaluated lazily on first import. */
export const isAvailable: boolean = (() => {
  // Defer actual check — let module init succeed even on failure
  return checkWasmAvailability();
})();

// ---------------------------------------------------------------------------
// WasmRunner
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MB per stream

// ---------------------------------------------------------------------------
// extraArgs allowlist validator (FIX 6)
// ---------------------------------------------------------------------------

/**
 * Flags that would grant filesystem or environment access to the WASM module.
 * Any extraArg equal to these, or starting with the `=`-prefixed form, is rejected.
 */
const BLOCKED_ARG_PREFIXES = ['--dir', '--mapdir', '--env', '--inherit-env', '--dir=', '--mapdir=', '--env='];

/**
 * Validate extraArgs against the blocked-flags list.
 * Throws on the first rejected argument.
 */
function validateExtraArgs(args: string[]): void {
  for (const arg of args) {
    for (const prefix of BLOCKED_ARG_PREFIXES) {
      if (arg === prefix || arg.startsWith(prefix + '=') || (prefix.endsWith('=') && arg.startsWith(prefix))) {
        throw new Error(`wasm-runner: extraArg "${arg}" rejected (filesystem/env escapes forbidden)`);
      }
    }
  }
}

/**
 * Run a WASM module via the `wasmtime` CLI binary.
 *
 * @example
 * ```ts
 * const runner = new WasmRunner();
 * if (runner.isAvailable) {
 *   const result = await runner.run({ module: '/path/to/module.wasm', input: 'hello' });
 * }
 * ```
 */
export class WasmRunner {
  /** True if wasmtime is available in PATH. */
  readonly isAvailable: boolean;

  constructor() {
    this.isAvailable = checkWasmAvailability();
  }

  /**
   * Execute a WASM module and return its output.
   *
   * If wasmtime is not available, returns a graceful error result with exit=-1.
   *
   * @param input - Module path, optional stdin, and timeout configuration.
   * @returns Stdout, stderr, exit code, and timeout flag.
   */
  run(input: WasmRunInput): WasmRunResult {
    if (!this.isAvailable) {
      return {
        stdout: '',
        stderr: 'wasmtime not available — install wasmtime to use WASM sandbox',
        exit: -1,
        timedOut: false,
      };
    }

    const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;

    // Validate module path (no shell interpolation — args are array)
    const wasmFile = input.module;
    if (!wasmFile || typeof wasmFile !== 'string') {
      return {
        stdout: '',
        stderr: 'WasmRunner: module path must be a non-empty string',
        exit: -1,
        timedOut: false,
      };
    }

    // Validate extraArgs against blocked filesystem/env escape flags
    if (input.extraArgs && input.extraArgs.length > 0) {
      validateExtraArgs(input.extraArgs);
    }

    // Build argument array — never use shell interpolation
    const args: string[] = [
      'run',
      ...(input.extraArgs ?? []),
      '--',
      wasmFile,
    ];

    log.debug({ module: wasmFile, timeoutMs }, 'Running WASM module via wasmtime');

    try {
      const result = spawnSync('wasmtime', args, {
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        input: input.input,
        // Kill process on timeout
        killSignal: 'SIGKILL',
      });

      const timedOut = result.signal === 'SIGKILL' || result.error?.message?.includes('ETIMEDOUT') === true;
      const stdout = (result.stdout ?? '').slice(0, MAX_OUTPUT_BYTES);
      const stderr = (result.stderr ?? '').slice(0, MAX_OUTPUT_BYTES);
      const exit = typeof result.status === 'number' ? result.status : (timedOut ? 124 : -1);

      if (timedOut) {
        log.warn({ module: wasmFile, timeoutMs }, 'WASM module execution timed out');
      } else {
        log.debug({ module: wasmFile, exit }, 'WASM module execution completed');
      }

      return { stdout, stderr, exit, timedOut };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ module: wasmFile, err: msg }, 'WASM runner subprocess error');
      return {
        stdout: '',
        stderr: `WasmRunner subprocess error: ${msg}`,
        exit: -1,
        timedOut: false,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** Default singleton WasmRunner. Check .isAvailable before calling .run(). */
export const wasmRunner = new WasmRunner();
