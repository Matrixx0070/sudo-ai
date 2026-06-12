/**
 * code.python-exec — Sandboxed Python execution via Docker.
 *
 * Architecture:
 *   - Per session: a Docker container named sudo-ai-py-<sanitized-sessionId>
 *   - Container spec: python:3.12-slim, NetworkMode=none, read-only root,
 *     writable /tmp/sandbox, 256MB memory limit
 *   - On first call for a session: container is spawned, matplotlib/numpy/pandas
 *     pre-installed via pip (slow ~15-30s, logged)
 *   - Subsequent calls: docker exec into the same container
 *   - Matplotlib support: inject Agg backend + savefig override, base64-encode output
 *   - Auto-cleanup: containers idle > 10 min killed by session-kernels sweeper
 *   - If Docker unavailable: clear error, no fallback to host Python
 *   - Fail-open on infra errors: return error result, never throw
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { getOrCreateEntry, sanitizeForDocker, isValidSessionId } from '../session-kernels.js';
import { createLogger } from '../../../../shared/logger.js';
import { clampToolOutput } from '../../../../shared/head-tail-buffer.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('code.python-exec');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOCKER_IMAGE = 'python:3.12-slim';
const CONTAINER_PREFIX = 'sudo-ai-py-';
const CONTAINER_MEMORY = '256m';
const CONTAINER_TMPFS = '/tmp/sandbox:rw,size=64m';

/** Packages pre-installed on container first spawn. */
const PRE_INSTALL_PACKAGES = ['matplotlib', 'numpy', 'pandas'];

/** Path inside container for matplotlib figure output. */
const PLOT_OUTPUT_PATH = '/tmp/sandbox/output.png';

/** Maximum output buffer size (8 MB). */
const MAX_BUFFER = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PythonExecResult {
  stdout: string;
  stderr: string;
  images: string[];
  executionTimeMs: number;
  timedOut: boolean;
  containerId: string;
}

// ---------------------------------------------------------------------------
// Docker availability check
// ---------------------------------------------------------------------------

let dockerAvailable: boolean | null = null;

async function checkDockerAvailable(): Promise<boolean> {
  if (dockerAvailable !== null) return dockerAvailable;
  try {
    await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}'], {
      timeout: 5_000,
    });
    dockerAvailable = true;
  } catch {
    dockerAvailable = false;
  }
  return dockerAvailable;
}

// ---------------------------------------------------------------------------
// Container lifecycle
// ---------------------------------------------------------------------------

/** Build a container name from sessionId. */
function containerName(sessionId: string): string {
  return `${CONTAINER_PREFIX}${sanitizeForDocker(sessionId)}`;
}

/** Check if a container is running. */
async function isContainerRunning(name: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('docker', [
      'inspect',
      '--format', '{{.State.Running}}',
      name,
    ], { timeout: 5_000 });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Spawn a new Python sandbox container.
 * Returns the container name (used as the id reference).
 */
async function spawnContainer(sessionId: string): Promise<string> {
  const name = containerName(sessionId);

  logger.info({ sessionId, name }, 'Spawning Python sandbox container');

  await execFileAsync('docker', [
    'run',
    '-d',
    '--name', name,
    '--network', 'none',
    '--memory', CONTAINER_MEMORY,
    '--memory-swap', CONTAINER_MEMORY,
    '--read-only',
    '--tmpfs', CONTAINER_TMPFS,
    '--tmpfs', '/tmp:rw,size=32m',
    '--stop-signal', 'SIGTERM',
    '--label', 'sudo-ai-sandbox=1',
    '--label', `sudo-ai-session=${sanitizeForDocker(sessionId)}`,
    DOCKER_IMAGE,
    // Keep container alive with a long sleep
    'sleep', '900',
  ], { timeout: 30_000 });

  logger.info({ sessionId, name }, 'Container spawned, pre-installing packages');

  // Pre-install packages (slow, ~15-30s on first call)
  try {
    await execFileAsync('docker', [
      'exec', name,
      'pip', 'install', '--quiet', '--no-cache-dir', ...PRE_INSTALL_PACKAGES,
    ], { timeout: 120_000, maxBuffer: MAX_BUFFER });
    logger.info({ sessionId, name, packages: PRE_INSTALL_PACKAGES }, 'Packages installed');
  } catch (err) {
    logger.warn({ sessionId, name, err: String(err) }, 'Package pre-install partial failure (continuing)');
    // Non-fatal: the user code might still work without all packages
  }

  return name;
}

/**
 * Get the container ID for this session, spawning one if needed.
 */
async function getOrSpawnContainer(sessionId: string): Promise<string> {
  const entry = getOrCreateEntry(sessionId);

  // Reuse existing container if it's still running
  if (entry.pyContainerId) {
    const running = await isContainerRunning(entry.pyContainerId);
    if (running) return entry.pyContainerId;
    // Container died — clear it and re-spawn
    logger.warn({ sessionId, containerId: entry.pyContainerId }, 'Container not running, re-spawning');
    entry.pyContainerId = null;
  }

  const name = await spawnContainer(sessionId);
  entry.pyContainerId = name;
  return name;
}

// ---------------------------------------------------------------------------
// Code injection: matplotlib support
// ---------------------------------------------------------------------------

/**
 * Wrap user code with matplotlib Agg backend setup and output capture.
 * Only injected when the code contains "plt." references.
 */
function wrapWithMatplotlib(userCode: string): string {
  const hasPlot = /\bplt\b/.test(userCode) || /\bmatplotlib\b/.test(userCode);
  if (!hasPlot) return userCode;

  return `
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

# Override plt.show() to save figure instead
_original_show = plt.show
def plt_show_override(*args, **kwargs):
    plt.savefig('${PLOT_OUTPUT_PATH}', dpi=100, bbox_inches='tight')
    plt.close('all')
plt.show = plt_show_override

${userCode}

# Auto-save if anything is open
try:
    if plt.get_fignums():
        plt.savefig('${PLOT_OUTPUT_PATH}', dpi=100, bbox_inches='tight')
        plt.close('all')
except Exception:
    pass
`.trim();
}

// ---------------------------------------------------------------------------
// Execute code in container
// ---------------------------------------------------------------------------

async function execInContainer(
  containerId: string,
  code: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; timedOut: boolean; exitCode: number }> {
  // Write code to container and run it
  const wrappedCode = wrapWithMatplotlib(code);

  // We pass the code via stdin using echo+pipe through docker exec
  // docker exec -i allows stdin; we write the code as a heredoc
  const start = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;

    // Use execFile with --env PYTHONDONTWRITEBYTECODE to keep container clean
    const proc = execFile(
      'docker',
      [
        'exec',
        '-i',
        '--env', 'PYTHONDONTWRITEBYTECODE=1',
        '--env', 'PYTHONUNBUFFERED=1',
        containerId,
        'python3', '-c', wrappedCode,
      ],
      {
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        killSignal: 'SIGTERM',
      },
      (err, stdout, stderr) => {
        if (settled) return;
        settled = true;

        const exitCode = err && 'code' in err && typeof (err as {code: unknown}).code === 'number'
          ? (err as {code: number}).code
          : 0;

        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          timedOut,
          exitCode,
        });
      },
    );

    // Timeout handling
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, timeoutMs);

    proc.on('exit', () => {
      clearTimeout(timer);
    });
  });
}

/** Read and base64-encode the plot output file from the container. */
async function extractPlotImage(containerId: string): Promise<string | null> {
  try {
    // Copy file out of container to a temp path
    const tmpPath = `/tmp/sudo-ai-plot-${Date.now()}.png`;
    await execFileAsync('docker', ['cp', `${containerId}:${PLOT_OUTPUT_PATH}`, tmpPath], {
      timeout: 10_000,
    });
    const buf = await readFile(tmpPath);
    // Clean up temp file (best-effort)
    execFileAsync('rm', ['-f', tmpPath]).catch(() => { /* ignore */ });
    return buf.toString('base64');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core execution
// ---------------------------------------------------------------------------

async function execPythonSandbox(
  code: string,
  sessionId: string,
  timeoutMs: number,
): Promise<PythonExecResult> {
  const start = Date.now();

  if (!(await checkDockerAvailable())) {
    return {
      stdout: '',
      stderr: 'Docker is not available on this system. Python execution requires Docker.',
      images: [],
      executionTimeMs: Date.now() - start,
      timedOut: false,
      containerId: '',
    };
  }

  let containerId: string;
  try {
    containerId = await getOrSpawnContainer(sessionId);
  } catch (err) {
    return {
      stdout: '',
      stderr: `Failed to provision Python sandbox container: ${String(err)}`,
      images: [],
      executionTimeMs: Date.now() - start,
      timedOut: false,
      containerId: '',
    };
  }

  const execResult = await execInContainer(containerId, code, timeoutMs);
  const images: string[] = [];

  // Extract plot if code referenced matplotlib
  if (/\bplt\b/.test(code) || /\bmatplotlib\b/.test(code)) {
    const plotB64 = await extractPlotImage(containerId);
    if (plotB64) {
      images.push(plotB64);
    }
    // Clean up plot file in container (best-effort)
    execFileAsync('docker', [
      'exec', containerId,
      'rm', '-f', PLOT_OUTPUT_PATH,
    ]).catch(() => { /* ignore */ });
  }

  return {
    stdout: execResult.stdout,
    stderr: execResult.stderr,
    images,
    executionTimeMs: Date.now() - start,
    timedOut: execResult.timedOut,
    containerId,
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const pythonExecTool: ToolDefinition = {
  name: 'code.python-exec',
  description:
    'Execute Python code in a secure Docker-sandboxed Python 3.12 environment. ' +
    'Captures stdout, stderr, and matplotlib figures as base64 PNG images. ' +
    'Supports numpy, pandas, and matplotlib pre-installed. ' +
    'No network access, read-only filesystem (except /tmp/sandbox). ' +
    'Note: first call per session takes 15-30s to install packages. ' +
    'Docker must be available; falls back to an error message if not.',
  category: 'coder',
  requiresConfirmation: false,
  safety: 'destructive',
  timeout: 120_000,
  parameters: {
    code: {
      type: 'string',
      description:
        'Python code to execute. Use print() for output. matplotlib.pyplot (plt) is pre-configured ' +
        'to save figures automatically — call plt.show() as normal.',
      required: true,
    },
    sessionId: {
      type: 'string',
      description:
        'Optional session identifier. Reuses the same Docker container across calls within a session.',
    },
    timeout: {
      type: 'number',
      description: 'Execution timeout in milliseconds. Default: 10000. Max: 60000.',
      default: 10000,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const startMs = Date.now();

    // Validate code
    const rawCode = params['code'];
    if (typeof rawCode !== 'string' || rawCode.trim().length === 0) {
      return {
        success: false,
        output: 'Validation error: code must be a non-empty string',
        data: { error: 'invalid_code' },
      };
    }
    if (rawCode.length > 100_000) {
      return {
        success: false,
        output: 'Validation error: code exceeds maximum length of 100,000 characters',
        data: { error: 'code_too_long' },
      };
    }

    const code = rawCode;

    // Determine sessionId
    const rawSession = params['sessionId'];
    const sessionIdParam = typeof rawSession === 'string' && rawSession.length > 0
      ? rawSession
      : ctx.sessionId;

    // Validate sessionId for safety
    const sessionId = isValidSessionId(sessionIdParam) ? sessionIdParam : ctx.sessionId;

    // Timeout
    const rawTimeout = params['timeout'];
    const timeoutMs = typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? Math.min(rawTimeout, 60_000)
      : 10_000;

    logger.info(
      { event: 'code.exec', runtime: 'py', sessionId, codeLen: code.length },
      'Executing Python code in Docker sandbox',
    );

    let result: PythonExecResult;
    try {
      result = await execPythonSandbox(code, sessionId, timeoutMs);
    } catch (err) {
      const durationMs = Date.now() - startMs;
      logger.error(
        { event: 'code.exec', runtime: 'py', sessionId, durationMs, err: String(err) },
        'Python sandbox infrastructure failure',
      );
      return {
        success: false,
        output: `Sandbox error: ${String(err)}`,
        data: {
          error: String(err),
          executionTimeMs: durationMs,
          timedOut: false,
          containerId: '',
          images: [],
        },
      };
    }

    logger.info(
      {
        event: 'code.exec',
        runtime: 'py',
        sessionId,
        codeLen: code.length,
        stdout1kb: result.stdout.slice(0, 1024),
        stderr1kb: result.stderr.slice(0, 1024),
        durationMs: result.executionTimeMs,
        exitCode: result.timedOut ? -1 : 0,
        imageCount: result.images.length,
      },
      'Python sandbox execution complete',
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
    if (result.images.length > 0) {
      outputParts.push(`[${result.images.length} figure(s) captured as base64 PNG]`);
    }
    if (!result.containerId) {
      outputParts.push('[Docker unavailable — Python execution skipped]');
    }
    const { text: output, truncated } = clampToolOutput(outputParts.join('\n') || '(no output)');

    return {
      success: !result.timedOut && !result.stderr && !!result.containerId,
      output,
      data: { ...result, truncated },
    };
  },
};
