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
import { realpathSync, statSync } from 'node:fs';
import { createLogger } from '../../shared/logger.js';
import { buildSandboxEnv, buildUlimitWrappedCommand, exitCodeFromError } from '../sandbox-runner.js';
import type { RunInSandboxOptions, SandboxRunResult } from '../sandbox-runner.js';
import type { ExecBackend } from '../exec-backend.js';
import { validateBindPath } from '../sandbox-policy.js';
import { SandboxPolicyError, resolveEgressAllowlist } from '../sandbox-types.js';
import { startEgressProxy } from '../egress-proxy.js';
import type { EgressProxyHandle } from '../egress-proxy.js';

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

/**
 * Default sandbox image: the non-root node+python image built from
 * docker/Dockerfile.sandbox (see that file). Override with SUDO_DOCKER_IMAGE.
 * If the image is absent, an untrusted `docker run` fails with a nonzero exit —
 * fail-closed by construction (the command never runs on the host).
 */
export const DEFAULT_SANDBOX_IMAGE = 'sudo-ai-sandbox:latest';

/**
 * Internal docker network for network:'allowlist' runs. `--internal` means no
 * NAT, no default route, and (Docker 26+) no external DNS — all verified live
 * on this host — so the ONLY reachable endpoint is the gateway IP on the host
 * bridge, where the per-run egress-proxy listens. Created lazily, idempotent.
 * Override the name with SUDO_DOCKER_EGRESS_NETWORK.
 */
export const DEFAULT_EGRESS_NETWORK = 'sudo-sandbox-egress';

export function resolveEgressNetworkName(): string {
  return process.env['SUDO_DOCKER_EGRESS_NETWORK'] || DEFAULT_EGRESS_NETWORK;
}

/**
 * Ensure the internal egress network exists and return its gateway IP (the
 * host-side address the proxy must bind). Throws on any failure — callers
 * treat that as fail-closed for the run.
 */
export async function ensureEgressNetwork(bin: string, name: string): Promise<{ gatewayIp: string }> {
  const inspect = async (): Promise<string> => {
    const { stdout } = await execFileAsync(
      bin,
      ['network', 'inspect', name, '--format', '{{(index .IPAM.Config 0).Gateway}} {{.Internal}}'],
      { timeout: 10_000 },
    );
    const [gateway, internal] = String(stdout).trim().split(/\s+/);
    if (internal !== 'true') {
      // A pre-existing NON-internal network under this name would silently give
      // the container a real route out — refuse instead of running open.
      throw new SandboxPolicyError(
        `docker egress network '${name}' exists but is not internal — refusing allowlist run`,
      );
    }
    if (!gateway) throw new SandboxPolicyError(`docker egress network '${name}' has no gateway IP`);
    return gateway;
  };

  try {
    return { gatewayIp: await inspect() };
  } catch (err) {
    if (err instanceof SandboxPolicyError) throw err;
    await execFileAsync(bin, ['network', 'create', '--internal', name], { timeout: 15_000 }).catch(
      (createErr: unknown) => {
        // Lost a create race → fine, inspect below settles it. Anything else
        // (docker down, permission) also surfaces via the inspect re-throw.
        void createErr;
      },
    );
    return { gatewayIp: await inspect() };
  }
}

export function resolveDockerConfig(): DockerBackendConfig {
  return {
    bin: process.env['SUDO_DOCKER_BIN'] || 'docker',
    image: process.env['SUDO_DOCKER_IMAGE'] || DEFAULT_SANDBOX_IMAGE,
    user: process.env['SUDO_DOCKER_USER'] || undefined,
  };
}

/**
 * Check whether the configured sandbox image is present locally. Called at boot
 * so operators get an early, actionable warning (with the build command) instead
 * of every untrusted turn silently failing closed. Never throws.
 */
export async function checkSandboxImageAvailable(
  config: DockerBackendConfig = resolveDockerConfig(),
): Promise<{ available: boolean; reason?: string }> {
  try {
    await execFileAsync(config.bin, ['image', 'inspect', config.image], {
      timeout: 10_000,
    });
    return { available: true };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return { available: false, reason: 'docker binary not found' };
    return { available: false, reason: `image '${config.image}' not present locally` };
  }
}

/**
 * Repo-relative Dockerfile for the sandbox image. `docker build` needs the repo
 * root as its context (the image copies nothing from it today, but the context
 * arg is required), so callers pass an absolute repo root.
 */
export const SANDBOX_DOCKERFILE = 'docker/Dockerfile.sandbox';

/**
 * Build the sandbox image from docker/Dockerfile.sandbox. The spec's "pre-pull
 * on boot" step: our image is LOCALLY built (no registry to pull from), so the
 * correct self-heal is a build. Opt-in + backgrounded by the caller so a slow
 * build never blocks boot. Returns {ok} rather than throwing; the build can take
 * minutes, hence the generous timeout. Never runs during a turn — boot only.
 */
export async function buildSandboxImage(
  repoRoot: string,
  config: DockerBackendConfig = resolveDockerConfig(),
): Promise<{ ok: boolean; reason?: string }> {
  try {
    await execFileAsync(
      config.bin,
      ['build', '-f', SANDBOX_DOCKERFILE, '-t', config.image, '.'],
      { cwd: repoRoot, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 },
    );
    return { ok: true };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stderr?: string | Buffer };
    if (e.code === 'ENOENT') return { ok: false, reason: 'docker binary not found' };
    const stderr = e.stderr ? String(e.stderr).trim().split('\n').slice(-3).join(' | ') : String(e.message ?? e);
    return { ok: false, reason: stderr };
  }
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

  // --- Container hardening (Feature 8) ---------------------------------------
  // Drop ALL Linux capabilities and forbid privilege escalation (setuid/setgid
  // binaries, file capabilities). An untrusted turn keeps none of root's powers
  // even if the image runs as root. --privileged is never passed.
  args.push('--cap-drop', 'ALL');
  args.push('--security-opt', 'no-new-privileges');
  // Read-only root filesystem with a small writable tmpfs for /tmp. The
  // workspace bind (below) stays writable and HOME=/workspace, so real work has
  // a place to write while the rest of the container FS is immutable. Opt out
  // with SUDO_DOCKER_READONLY=0 for images that need a writable rootfs.
  if (process.env['SUDO_DOCKER_READONLY'] !== '0') {
    args.push('--read-only');
    args.push('--tmpfs', '/tmp:rw,nosuid,nodev,size=64m');
  }

  // Network isolation mirrors bwrap: policy.network 'none' → --network none.
  // With --network none there is NO interface at all, so the cloud metadata
  // endpoint (169.254.169.254) and every other host are unreachable by
  // construction — untrusted turns are pinned to 'none' by the routing layer.
  // 'allowlist' → the internal egress network: no NAT/route/DNS, only the
  // gateway-bound egress proxy is reachable (run() starts it and exports
  // HTTP(S)_PROXY into the scrubbed env before this builder is called).
  args.push(
    '--network',
    policy.network === 'host'
      ? 'host'
      : policy.network === 'allowlist'
        ? resolveEgressNetworkName()
        : 'none',
  );

  // Workspace bind + working directory. A ':' in the host path would corrupt the
  // -v spec, so reject it up front (bwrap passes it as a separate token).
  assertNoColon(workspaceDir, 'workspaceDir');
  args.push('-v', `${workspaceDir}:/workspace`);
  args.push('-w', '/workspace');

  // Container-level resource caps (defense in depth alongside the ulimit wrapper).
  // --memory-swap == --memory disables swap, so the memory cap is actually
  // enforced (without it a 600MB alloc under a 512m cap just swaps and survives —
  // verified). --pids-limit caps a fork bomb.
  const memMB = policy.memoryMB ?? 512;
  args.push('--memory', `${memMB}m`);
  args.push('--memory-swap', `${memMB}m`);
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

    // Default the container user to the workspace OWNER (uid:gid) so the
    // bind-mounted /workspace is readable + writable. Without this, the image's
    // non-root user (uid 999) cannot touch a root-owned session dir and every
    // untrusted turn fails on its own workspace. cap-drop ALL + no-new-privileges
    // + read-only rootfs + no network keep the turn contained even at uid 0.
    // An explicit SUDO_DOCKER_USER always wins.
    if (!config.user) {
      try {
        const st = statSync(opts.workspaceDir);
        config.user = `${st.uid}:${st.gid}`;
      } catch {
        /* stat failed — leave the image default USER */
      }
    }

    const env = buildSandboxEnv(opts.policy);

    // network:'allowlist' — bring up the enforced egress path BEFORE building
    // argv (the proxy env vars must be in `env` so the `-e KEY` loop forwards
    // them). Any setup failure refuses the run (exit 126) — the sandbox never
    // silently runs with a more open network than the policy asked for.
    let egressProxy: EgressProxyHandle | undefined;
    if (opts.policy.network === 'allowlist') {
      try {
        const networkName = resolveEgressNetworkName();
        const { gatewayIp } = await ensureEgressNetwork(config.bin, networkName);
        egressProxy = await startEgressProxy({
          bindHost: gatewayIp,
          allowedHosts: resolveEgressAllowlist(opts.policy),
        });
        for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
          env[key] = egressProxy.url;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          stdout: '',
          stderr: `docker exec backend: egress allowlist setup failed (refusing to run — fail closed): ${message}`,
          exitCode: 126,
        };
      }
    }

    let args: string[];
    try {
      args = buildDockerArgs(opts, env, config);
    } catch (err) {
      await egressProxy?.close();
      throw err;
    }

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
        code?: string | number;
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

      // docker run exits with the container's exit code; execFile puts it on .code
      const exitCode = exitCodeFromError(error);
      return { stdout, stderr, exitCode };
    } finally {
      await egressProxy?.close();
    }
  },
};
