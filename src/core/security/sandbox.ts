/**
 * @file security/sandbox.ts
 * @description SandboxExecutor — runs arbitrary shell commands inside an
 * ephemeral Docker container with strict resource limits.
 *
 * Security model:
 *  - No network access (--network=none)
 *  - Memory cap via --memory
 *  - CPU cap via --cpus
 *  - Container auto-removed on exit (--rm)
 *  - AbortController-based timeout kills the docker process if it hangs
 */

import { spawn } from 'node:child_process';
import { createLogger } from '../shared/logger.js';

const log = createLogger('security:sandbox');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ---------------------------------------------------------------------------
// SandboxExecutor
// ---------------------------------------------------------------------------

const DEFAULT_IMAGE = 'node:20-alpine' as const;
const DEFAULT_MEMORY = '512m' as const;
const DEFAULT_CPUS = '0.5' as const;
const DEFAULT_TIMEOUT_MS = 30_000 as const;

export class SandboxExecutor {
  private readonly image: string;
  private readonly memoryLimit: string;
  private readonly cpuLimit: string;

  /**
   * @param image       - Docker image to use (default: node:20-alpine).
   * @param memoryLimit - Container memory limit (default: 512m).
   * @param cpuLimit    - CPU share (default: 0.5 = half a core).
   */
  constructor(
    image: string = DEFAULT_IMAGE,
    memoryLimit: string = DEFAULT_MEMORY,
    cpuLimit: string = DEFAULT_CPUS,
  ) {
    this.image = image;
    this.memoryLimit = memoryLimit;
    this.cpuLimit = cpuLimit;
  }

  // -------------------------------------------------------------------------
  // Availability probe
  // -------------------------------------------------------------------------

  /**
   * Check whether the Docker CLI is present and responsive.
   * Resolves `true` if `docker info` exits with code 0, `false` otherwise.
   */
  static async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn('docker', ['info'], { stdio: 'ignore' });
      proc.on('error', () => resolve(false));
      proc.on('exit', (code) => resolve(code === 0));
    });
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  /**
   * Execute a shell command inside a sandboxed Docker container.
   *
   * @param command    - Shell command string, passed to `sh -c "..."`.
   * @param timeoutMs  - Maximum wall-clock time (default: 30 000 ms).
   * @returns Captured stdout, stderr, and numeric exit code.
   * @throws {Error} when Docker is not available or the timeout fires.
   */
  async execute(
    command: string,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<SandboxResult> {
    if (!command || typeof command !== 'string') {
      throw new TypeError('SandboxExecutor.execute: command must be a non-empty string');
    }
    if (timeoutMs <= 0 || !isFinite(timeoutMs)) {
      throw new RangeError(`SandboxExecutor.execute: invalid timeoutMs ${timeoutMs}`);
    }

    const dockerArgs = this._buildArgs(command);
    log.info(
      { image: this.image, memoryLimit: this.memoryLimit, cpuLimit: this.cpuLimit },
      'Executing sandboxed command',
    );

    return new Promise<SandboxResult>((resolve, reject) => {
      const controller = new AbortController();

      const timer = setTimeout(() => {
        controller.abort();
        log.error({ command: command.slice(0, 120), timeoutMs }, 'Sandbox execution timed out');
        reject(new Error(`Sandbox execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const proc = spawn('docker', dockerArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: controller.signal,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      proc.on('error', (err) => {
        clearTimeout(timer);
        // AbortController fires an 'abort' error — rethrow as timeout message.
        if (controller.signal.aborted) return; // already rejected above
        log.error({ err: err.message }, 'Docker process error');
        reject(new Error(`Sandbox process error: ${err.message}`));
      });

      proc.on('exit', (code, signal) => {
        clearTimeout(timer);
        if (controller.signal.aborted) return; // already rejected

        const exitCode = typeof code === 'number' ? code : 1;
        log.info({ exitCode, signal, stdoutLen: stdout.length, stderrLen: stderr.length }, 'Sandbox finished');
        resolve({ stdout, stderr, exitCode });
      });
    });
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Build the docker run argument list.
   * Keeps arguments explicit and auditable — no shell interpolation.
   */
  private _buildArgs(command: string): string[] {
    return [
      'run',
      '--rm',
      '--network=none',
      `--memory=${this.memoryLimit}`,
      `--cpus=${this.cpuLimit}`,
      // Drop ALL capabilities; add back none.
      '--cap-drop=ALL',
      // Read-only root filesystem.
      '--read-only',
      // Use a tmp volume for /tmp to allow write access.
      '--tmpfs=/tmp:rw,noexec,nosuid,size=64m',
      // Run as non-root uid 1000 inside the container.
      '--user=1000:1000',
      this.image,
      'sh',
      '-c',
      command,
    ];
  }
}
