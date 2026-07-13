/**
 * @file sandbox/backends/modal-backend.ts
 * @description Modal exec backend (gap #27).
 *
 * Runs the command in an ephemeral Modal (modal.com) serverless sandbox. The
 * Modal SDK is Python-only, so this shells out to `python3 -c <driver>` where the
 * driver creates a modal.Sandbox and runs the command in it. Selected via
 * SUDO_EXEC_BACKEND=modal. Config (env):
 *   SUDO_MODAL_BIN     python binary that has the `modal` package (default python3)
 *   SUDO_MODAL_IMAGE   registry image ref (default: modal's debian_slim)
 *   SUDO_MODAL_APP     modal app name (default 'sudo-exec')
 * Requires the `modal` Python package + Modal auth (MODAL_TOKEN_ID / MODAL_TOKEN_SECRET
 * in the environment, which the local python client inherits).
 *
 * Injection-safe: the command is passed to the driver via the SUDO_MODAL_COMMAND
 * ENV var (never on argv) and run in the sandbox as `bash -c <command>` (argv to
 * sb.exec, not via a host shell).
 *
 * SECURITY / SEMANTICS — read before enabling (this backend does NOT have full
 * docker/bwrap parity):
 *   - The command runs in a FRESH Modal sandbox: the workspaceDir bind is NOT
 *     mounted (no project files), and policy.extraReadOnlyBinds /
 *     extraWritableBinds do NOT apply.
 *   - The HARD resource cap that carries everywhere is the shared ulimit wrapper
 *     (cpu/mem/files/procs), run inside the sandbox. The sandbox `memory` arg is a
 *     scheduling REQUEST, not a hard cap; `timeout` is a server-side wall-clock cap.
 *   - policy.network==='none' is mapped to Modal's block_network (best-effort: the
 *     driver retries without it + warns if the installed modal version lacks it).
 *   - On local timeout/abort the driver installs a SIGTERM/SIGINT handler that
 *     terminates the remote sandbox (so it doesn't keep running/billing); the
 *     server-side `timeout` is the backstop if even that is missed.
 *
 * Honest failure: python binary absent OR the `modal` package missing → exit 127.
 *
 * VERIFICATION BOUNDARY: the driver's syntax + the import-guard + the 127 path are
 * unit-tested against a real python3; the live Modal Sandbox round-trip
 * (create/exec/wait) is NOT exercised here (it needs a Modal account + auth, which
 * this environment lacks). Validate against your Modal workspace before relying on
 * remote execution. Unlike the docker/ssh backends, this backend's cloud path is
 * unverified end-to-end.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../../shared/logger.js';
import { buildUlimitWrappedCommand, exitCodeFromError } from '../sandbox-runner.js';
import type { RunInSandboxOptions, SandboxRunResult } from '../sandbox-runner.js';
import type { ExecBackend } from '../exec-backend.js';

const log = createLogger('sandbox:modal');
const execFileAsync = promisify(execFile);

export interface ModalBackendConfig {
  bin: string;
  image: string;
  app: string;
}

export function resolveModalConfig(): ModalBackendConfig {
  return {
    bin: process.env['SUDO_MODAL_BIN'] || 'python3',
    image: process.env['SUDO_MODAL_IMAGE'] || '',
    app: process.env['SUDO_MODAL_APP'] || 'sudo-exec',
  };
}

/**
 * The Python driver, run via `python3 -c`. All inputs arrive via env (never argv),
 * so there is no quoting/injection surface. The import-guard exits 127 when the
 * `modal` package is missing (mirrors the docker/ssh "tool unavailable → 127").
 */
export const MODAL_DRIVER = `
import os, sys, signal
try:
    import modal
except ImportError:
    sys.stderr.write("modal exec backend: the 'modal' Python package is not installed (pip install modal)\\n")
    sys.exit(127)

cmd = os.environ.get("SUDO_MODAL_COMMAND", "")
image_ref = os.environ.get("SUDO_MODAL_IMAGE", "")
app_name = os.environ.get("SUDO_MODAL_APP", "sudo-exec")
mem = int(os.environ.get("SUDO_MODAL_MEMORY_MB", "512") or "512")
timeout = int(os.environ.get("SUDO_MODAL_TIMEOUT_S", "60") or "60")
block_net = os.environ.get("SUDO_MODAL_BLOCK_NETWORK", "") == "1"

# Terminate the remote sandbox on local timeout/abort: Node SIGTERMs this process,
# whose default disposition would skip the finally below and orphan (keep billing)
# the sandbox. The handler reads the module-global sb set after create().
sb = None
def _cleanup(signum, frame):
    try:
        if sb is not None:
            sb.terminate()
    except Exception:
        pass
    sys.exit(143)
signal.signal(signal.SIGTERM, _cleanup)
signal.signal(signal.SIGINT, _cleanup)

app = modal.App.lookup(app_name, create_if_missing=True)
image = modal.Image.from_registry(image_ref) if image_ref else modal.Image.debian_slim()

# policy.network==='none' -> block_network (best-effort): retry without it + warn
# if the installed modal version doesn't accept the kwarg.
create_kwargs = dict(app=app, image=image, memory=mem, timeout=timeout)
if block_net:
    create_kwargs["block_network"] = True
try:
    sb = modal.Sandbox.create(**create_kwargs)
except TypeError:
    create_kwargs.pop("block_network", None)
    sb = modal.Sandbox.create(**create_kwargs)
    if block_net:
        sys.stderr.write("modal exec backend: this modal version does not support block_network; network is NOT isolated\\n")

try:
    p = sb.exec("bash", "-c", cmd)
    out = p.stdout.read()
    err = p.stderr.read()
    rc = p.wait()
    sys.stdout.write(out.decode() if isinstance(out, (bytes, bytearray)) else (out or ""))
    sys.stderr.write(err.decode() if isinstance(err, (bytes, bytearray)) else (err or ""))
    sys.exit(rc if isinstance(rc, int) else 0)
finally:
    try:
        sb.terminate()
    except Exception:
        pass
`;

/** Build the python argv. The driver is fixed; all inputs travel via env. */
export function buildModalArgs(): string[] {
  return ['-c', MODAL_DRIVER];
}

/**
 * Build the SUDO_MODAL_* env the driver reads. Pure + deterministic. The command
 * (ulimit-wrapped) travels here, NOT on argv. memory/timeout derive from policy
 * and the call timeout.
 */
export function buildModalDriverEnv(
  opts: Pick<RunInSandboxOptions, 'command' | 'policy' | 'timeoutMs'>,
  config: ModalBackendConfig,
): Record<string, string> {
  const { command, policy, timeoutMs } = opts;
  return {
    SUDO_MODAL_COMMAND: buildUlimitWrappedCommand(command, policy),
    SUDO_MODAL_IMAGE: config.image,
    SUDO_MODAL_APP: config.app,
    SUDO_MODAL_MEMORY_MB: String(policy.memoryMB ?? 512),
    SUDO_MODAL_TIMEOUT_S: String(Math.max(1, Math.ceil((timeoutMs ?? 60000) / 1000))),
    // policy.network 'none' → request Modal block_network (driver maps it,
    // best-effort). 'allowlist' also blocks: Modal has no egress-proxy path
    // (docker backend only), so the fail-closed reading is no network.
    SUDO_MODAL_BLOCK_NETWORK: policy.network !== 'host' ? '1' : '',
  };
}

export const modalBackend: ExecBackend = {
  name: 'modal',

  async run(opts: RunInSandboxOptions): Promise<SandboxRunResult> {
    const config = resolveModalConfig();
    const driverEnv = buildModalDriverEnv(opts, config);

    log.info(
      { image: config.image || 'debian_slim', app: config.app, bin: config.bin },
      'running command via modal exec backend (remote serverless sandbox)',
    );

    try {
      // The local python client inherits the env (MODAL_TOKEN_ID/SECRET auth) plus
      // the driver vars; the command is in SUDO_MODAL_COMMAND, never on argv.
      const result = await execFileAsync(config.bin, buildModalArgs(), {
        env: { ...process.env, ...driverEnv },
        timeout: opts.timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        signal: opts.signal,
      });
      const stdout = typeof result.stdout === 'string' ? result.stdout : String(result.stdout);
      const stderr = typeof result.stderr === 'string' ? result.stderr : String(result.stderr);
      return { stdout, stderr, exitCode: 0 };
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException & {
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        code?: string | number;
        status?: number;
      };

      if (error.code === 'ENOENT') {
        return {
          stdout: '',
          stderr: `modal exec backend: '${config.bin}' not found — is python3 (with the modal package) installed?`,
          exitCode: 127,
        };
      }

      const outRaw = error.stdout;
      const errRaw = error.stderr;
      const stdout = typeof outRaw === 'string' ? outRaw : outRaw ? String(outRaw) : '';
      const stderr = typeof errRaw === 'string' ? errRaw : errRaw ? String(errRaw) : '';

      if (error.code === 'ABORT_ERR' || error.code === 'ERR_ABORT' || opts.signal?.aborted) {
        return { stdout, stderr: stderr || 'Process aborted', exitCode: 130 };
      }

      // The driver exits with the remote command's exit code (or 127 when the
      // modal package is missing). execFile puts the code on .code.
      const exitCode = exitCodeFromError(error);
      return { stdout, stderr, exitCode };
    }
  },
};
