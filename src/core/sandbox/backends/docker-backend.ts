/**
 * @file sandbox/backends/docker-backend.ts
 * @description Docker exec backend (gap #27).
 *
 * Runs the command inside a throwaway Docker container (`docker run --rm`) with
 * the workspace bind-mounted, the same env scrub the bwrap runner uses, the same
 * ulimit wrapper, plus container-level memory/pid caps and network isolation.
 *
 * Selected via SUDO_EXEC_BACKEND=docker. Config:
 *   SUDO_DOCKER_BIN    docker binary (default 'docker')
 *   SUDO_DOCKER_IMAGE  image with /bin/bash (default 'ubuntu:24.04')
 *   SUDO_DOCKER_USER   optional --user (e.g. '1000:1000' to drop root)
 *
 * Requires Docker on the host; when the binary is absent the run returns an
 * honest exitCode 127 instead of throwing. The argv builder is deterministic and
 * unit-tested (env VALUES are passed via the child process env, the `-e <KEY>`
 * pass-through form, never on argv); it touches the filesystem only to resolve +
 * validate extra bind mounts, exactly as the bwrap runner does.
 *
 * Isolation parity note: pid/ipc/uts/session isolation that the bwrap runner sets
 * explicitly (`--unshare-pid/ipc/uts`, `--new-session`) is inherent to a Docker
 * container, so it is not passed as separate flags here — it is not an omission.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpathSync } from 'node:fs';
import { createLogger } from '../../shared/logger.js';
import { buildSandboxEnv, buildUlimitWrappedCommand } from '../sandbox-runner.js';
import type { RunInSandboxOptions, SandboxRunResult } from '../sandbox-runner.js';
import type { ExecBackend } from '../exec-backend.js';
import { validateBindPath } from '../sandbox-policy.js';
import { SandboxPolicyError } from '../sandbox-types.js';

const log = createLogger('sandbox:docker');
const execFileAsync = promisify(execFile);

/**
 * A Docker `-v` spec is colon-delimited (`src:dst[:mode]`), so a host path that
 * itself contains ':' would corrupt the mount (extra colons get read as a mode).
 * The bwrap runner passes paths as separate argv tokens and is immune; here we
 * reject them explicitly. Mirrors the SandboxPolicyError bwrap throws on bad binds.
 */
function assertNoColon(path: string, label: string): void {
  if (path.includes(':')) {
    throw new SandboxPolicyError(
      `docker exec backend: ${label} path may not contain ':' (breaks -v mount syntax): ${JSON.stringify(path)}`,
    );
  }
}

/**
 * Resolve symlinks first (so a symlink to a denied path can't bypass the
 * denylist) then validate — identical to the bwrap runner's extra-bind handling.
 * Returns the resolved, validated, colon-free path to mount at the same location.
 */
function resolveAndValidateBind(bind: string, realpath: (p: string) => string): string {
  let resolved: string;
  try {
    resolved = realpath(bind);
  } catch {
    throw new SandboxPolicyError(
      `docker exec backend: bind path does not exist: ${JSON.stringify(bind)}`,
    );
  }
  if (!validateBindPath(resolved)) {
    throw new SandboxPolicyError(
      `docker exec backend: resolved bind path unsafe: ${JSON.stringify(resolved)}`,
    );
  }
  assertNoColon(resolved, 'bind');
  return resolved;
}

export interface DockerBackendConfig {
  bin: string;
  image: string;
  user?: string;
}

export function resolveDockerConfig(): DockerBackendConfig {
  return {
    bin: process.env['SUDO_DOCKER_BIN'] || 'docker',
    image: process.env['SUDO_DOCKER_IMAGE'] || 'ubuntu:24.04',
    user: process.env['SUDO_DOCKER_USER'] || undefined,
  };
}

/**
 * Build the `docker` argv (excluding the docker binary). Deterministic; the only
 * filesystem access is resolving + validating extra bind mounts (the
 * `_realpathSync` override exists for unit testing, mirroring buildBwrapArgs).
 * `env` keys are forwarded by name via `-e <KEY>` — the VALUES travel through the
 * child process environment, never the command line.
 */
export function buildDockerArgs(
  opts: Pick<RunInSandboxOptions, 'command' | 'workspaceDir' | 'policy'>,
  env: NodeJS.ProcessEnv,
  config: DockerBackendConfig,
  _realpathSync: (p: string) => string = realpathSync,
): string[] {
  const { command, workspaceDir, policy } = opts;

  const args: string[] = ['run', '--rm', '--init'];

  // Network isolation mirrors bwrap: policy.network 'none' → --network none.
  args.push('--network', policy.network === 'host' ? 'host' : 'none');

  // Workspace bind + working directory. A ':' in the host path would corrupt the
  // -v spec, so reject it up front (bwrap passes it as a separate token).
  assertNoColon(workspaceDir, 'workspaceDir');
  args.push('-v', `${workspaceDir}:/workspace`);
  args.push('-w', '/workspace');

  // Container-level resource caps (defense in depth alongside the ulimit wrapper).
  args.push('--memory', `${policy.memoryMB ?? 512}m`);
  args.push('--pids-limit', '64');

  if (config.user) args.push('--user', config.user);

  // Extra bind mounts from policy — isolation parity with the bwrap runner. Each
  // path is symlink-resolved + validated before mounting at the same location;
  // read-only binds get the `:ro` mode, writable binds do not. Silently dropping
  // these (the prior behavior) would have left callers a broken environment.
  for (const bind of policy.extraReadOnlyBinds ?? []) {
    const resolved = resolveAndValidateBind(bind, _realpathSync);
    args.push('-v', `${resolved}:${resolved}:ro`);
  }
  for (const bind of policy.extraWritableBinds ?? []) {
    const resolved = resolveAndValidateBind(bind, _realpathSync);
    args.push('-v', `${resolved}:${resolved}`);
  }

  // Forward the scrubbed env by name only (values via the child process env).
  for (const key of Object.keys(env)) {
    args.push('-e', key);
  }

  args.push(config.image);
  args.push('/bin/bash', '-c', buildUlimitWrappedCommand(command, policy));

  return args;
}

export const dockerBackend: ExecBackend = {
  name: 'docker',

  async run(opts: RunInSandboxOptions): Promise<SandboxRunResult> {
    const config = resolveDockerConfig();
    const env = buildSandboxEnv(opts.policy);
    const args = buildDockerArgs(opts, env, config);

    log.info(
      { image: config.image, network: opts.policy.network, bin: config.bin },
      'running command via docker exec backend',
    );

    try {
      const result = await execFileAsync(config.bin, args, {
        env,
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
        status?: number;
      };

      if (error.code === 'ENOENT') {
        return {
          stdout: '',
          stderr: `docker exec backend: '${config.bin}' not found — is Docker installed and on PATH?`,
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

      const exitCode = typeof error.status === 'number' ? error.status : 1;
      return { stdout, stderr, exitCode };
    }
  },
};
