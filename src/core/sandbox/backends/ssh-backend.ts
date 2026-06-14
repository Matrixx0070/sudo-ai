/**
 * @file sandbox/backends/ssh-backend.ts
 * @description SSH exec backend (gap #27).
 *
 * Runs the command on a REMOTE host over SSH instead of locally. Selected via
 * SUDO_EXEC_BACKEND=ssh. The same ulimit wrapper the bwrap/docker runners use is
 * applied on the remote (resource caps), but execution otherwise happens in the
 * remote host's own environment.
 *
 * Config (env):
 *   SUDO_SSH_HOST           remote host (REQUIRED)
 *   SUDO_SSH_USER           remote user (optional → "user@host")
 *   SUDO_SSH_PORT           port (default 22; -p only emitted when != 22)
 *   SUDO_SSH_KEY            identity file path (optional → -i)
 *   SUDO_SSH_BIN            ssh binary (default 'ssh')
 *   SUDO_SSH_WORKDIR        remote working dir to cd into (optional)
 *   SUDO_SSH_STRICT_HOST_KEY  StrictHostKeyChecking value (default 'accept-new')
 *
 * SECURITY / SEMANTICS — read before enabling:
 *   - The command runs on a REMOTE host with the SSH user's privileges. There is
 *     NO local sandbox and the local env scrub does NOT apply — the remote host
 *     is responsible for its own isolation. Treat the remote as trusted.
 *   - policy.network and policy.extraReadOnlyBinds/extraWritableBinds do NOT
 *     apply (no namespaces, no bind mounts over SSH); only the ulimit caps carry.
 *   - The local env is inherited by the ssh CLIENT (so SSH_AUTH_SOCK / known_hosts
 *     work) but is NOT forwarded to the remote (no SendEnv) — local secrets stay
 *     local.
 *   - The remote command is passed as a SINGLE ssh argument, built via execFile
 *     (no local shell) as `bash -c <single-quote-escaped>`, so neither the local
 *     side nor the remote shell can break out of the quoting (injection-safe).
 *   - Non-interactive: BatchMode=yes (never prompt → fail fast) + ConnectTimeout.
 *   - Honest failure: missing ssh binary → exitCode 127; SUDO_SSH_HOST unset →
 *     exitCode 78 (EX_CONFIG); connection failure → ssh's own 255.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../../shared/logger.js';
import { buildUlimitWrappedCommand, exitCodeFromError } from '../sandbox-runner.js';
import type { RunInSandboxOptions, SandboxRunResult } from '../sandbox-runner.js';
import type { ExecBackend } from '../exec-backend.js';

const log = createLogger('sandbox:ssh');
const execFileAsync = promisify(execFile);

const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;

export interface SshBackendConfig {
  bin: string;
  host: string;
  user?: string;
  port: number;
  key?: string;
  workdir?: string;
  strictHostKey: string;
}

export function resolveSshConfig(): SshBackendConfig {
  const portRaw = process.env['SUDO_SSH_PORT'];
  const port = portRaw ? Number.parseInt(portRaw, 10) : 22;
  return {
    bin: process.env['SUDO_SSH_BIN'] || 'ssh',
    host: process.env['SUDO_SSH_HOST'] || '',
    user: process.env['SUDO_SSH_USER'] || undefined,
    port: Number.isFinite(port) && port > 0 ? port : 22,
    key: process.env['SUDO_SSH_KEY'] || undefined,
    workdir: process.env['SUDO_SSH_WORKDIR'] || undefined,
    strictHostKey: process.env['SUDO_SSH_STRICT_HOST_KEY'] || 'accept-new',
  };
}

/**
 * POSIX single-quote a string so it is ONE literal argument to a shell. Wraps in
 * single quotes and rewrites each embedded `'` as `'\''` (close, escaped quote,
 * reopen). Everything else inside single quotes is literal, so this is safe for
 * arbitrary content — the basis of the backend's injection safety.
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the `ssh` argv (excluding the ssh binary). Pure + deterministic. The
 * remote command is a SINGLE argument — `bash -c <single-quote-escaped>` — so the
 * ulimit-wrapped user command cannot break out of the quoting on either side.
 */
export function buildSshArgs(
  opts: Pick<RunInSandboxOptions, 'command' | 'policy'>,
  config: SshBackendConfig,
): string[] {
  const { command, policy } = opts;

  const args: string[] = [
    '-o', 'BatchMode=yes', // never prompt for a password/passphrase — fail instead of hang
    '-o', `StrictHostKeyChecking=${config.strictHostKey}`,
    '-o', `ConnectTimeout=${DEFAULT_CONNECT_TIMEOUT_SECONDS}`,
  ];

  if (config.port !== 22) args.push('-p', String(config.port));
  if (config.key) args.push('-i', config.key);

  args.push(config.user ? `${config.user}@${config.host}` : config.host);

  // Apply the ulimit caps on the remote; optionally cd into a remote workdir.
  // The whole thing is run via bash -c as a single, fully-escaped argument.
  const ulimitWrapped = buildUlimitWrappedCommand(command, policy);
  const inner = config.workdir
    ? `cd ${shellQuote(config.workdir)} && ${ulimitWrapped}`
    : ulimitWrapped;
  args.push(`bash -c ${shellQuote(inner)}`);

  return args;
}

export const sshBackend: ExecBackend = {
  name: 'ssh',

  async run(opts: RunInSandboxOptions): Promise<SandboxRunResult> {
    const config = resolveSshConfig();

    if (!config.host) {
      return {
        stdout: '',
        stderr: 'ssh exec backend: SUDO_SSH_HOST is not set — cannot run remotely',
        exitCode: 78, // EX_CONFIG (sysexits): a configuration error, not a command failure
      };
    }

    // Defense in depth: the destination is a bare positional ssh argument, so a
    // host/user starting with '-' would be parsed as an OPTION (e.g.
    // -oProxyCommand=...) instead of a destination. SUDO_SSH_* are operator-set,
    // but reject the dangerous shapes (leading '-' or embedded whitespace) anyway.
    const target = config.user ? `${config.user}@${config.host}` : config.host;
    if (config.host.startsWith('-') || (config.user?.startsWith('-') ?? false) || /\s/.test(target)) {
      return {
        stdout: '',
        stderr: `ssh exec backend: unsafe SUDO_SSH_HOST/SUDO_SSH_USER (must not start with '-' or contain whitespace): ${JSON.stringify(target)}`,
        exitCode: 78,
      };
    }

    const args = buildSshArgs(opts, config);

    log.info(
      { host: config.host, user: config.user, port: config.port, bin: config.bin },
      'running command via ssh exec backend (remote execution — no local sandbox)',
    );

    try {
      // No `env` override: the ssh CLIENT inherits the local env (SSH_AUTH_SOCK,
      // HOME for ~/.ssh) but does not forward it to the remote.
      const result = await execFileAsync(config.bin, args, {
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
          stderr: `ssh exec backend: '${config.bin}' not found — is OpenSSH installed and on PATH?`,
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

      // ssh propagates the remote command's exit code; a connection failure is
      // ssh's own 255. execFile puts the code on .code.
      const exitCode = exitCodeFromError(error);
      return { stdout, stderr, exitCode };
    }
  },
};
