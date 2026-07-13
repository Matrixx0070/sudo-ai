/**
 * @file sandbox/sandbox-runner.ts
 * @description bwrap (Linux) / Seatbelt (macOS) process isolation runner.
 *
 * runInSandbox: spawns a command inside bubblewrap (Linux hosts) or
 *   sandbox-exec/Seatbelt (macOS hosts).
 *   Falls back to raw execFile when SUDO_SANDBOX_DISABLE=1 (all platforms)
 *   or SUDO_SANDBOX_ALLOW_UNCONFINED=1 (macOS Seatbelt path only).
 *   On every fallback call logs a loud warning — not just at startup.
 *
 * buildBwrapArgs: exported for unit testing.
 * buildSandboxEnv: exported for unit testing.
 *
 * Security invariants:
 *   - buildSandboxEnv reads ONLY allowlisted keys from process.env.
 *   - HOME is always /workspace, USER is always 'sandbox'.
 *   - lib64 bind is conditional on existsSync('/lib64').
 */

import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { promisify } from 'node:util';
import { createLogger } from '../shared/logger.js';
import {
  type SandboxPolicy,
  ENV_ALLOWLIST_BASE,
  SECRET_ENV_DENYLIST,
  SandboxPolicyError,
} from './sandbox-types.js';
import { validateBindPath } from './sandbox-policy.js';
import { selectExecBackendName, resolveExecBackend } from './exec-backend.js';

const log = createLogger('sandbox:runner');
const execFileAsync = promisify(execFile);

export const BWRAP_BIN = '/usr/bin/bwrap';

/** macOS Seatbelt runner binary (ships with every macOS install). */
export const SANDBOX_EXEC_BIN = '/usr/bin/sandbox-exec';

/**
 * Read-only host paths bound into the sandbox ONLY when policy.network === 'host'.
 *
 * Sharing the host network namespace (omitting --unshare-net) is necessary but
 * NOT sufficient for real egress: buildBwrapArgs otherwise mounts no /etc, so
 * glibc cannot resolve DNS (needs /etc/resolv.conf + nsswitch) and curl/openssl
 * cannot complete TLS (needs the CA bundle). Without these a shared-net sandbox
 * still fails with "Could not resolve host" or a missing-CA TLS error — verified
 * empirically against huggingface.co.
 *
 * Each entry is existence-gated in buildBwrapArgs: the set varies across distros
 * (Debian/Ubuntu use /etc/ssl/certs, RHEL/Fedora use /etc/pki) and a --ro-bind
 * with a missing source path makes bwrap abort. All are read-only and specific
 * files/dirs — never the whole /etc.
 */
const HOST_NETWORK_RO_BINDS: ReadonlyArray<string> = [
  '/etc/resolv.conf',
  '/etc/nsswitch.conf',
  '/etc/hosts',
  '/etc/host.conf',
  '/etc/gai.conf',
  '/etc/ssl/certs', // Debian/Ubuntu CA bundle dir
  '/etc/pki', // RHEL/Fedora CA location
  '/etc/ca-certificates', // additional CA store on some distros
];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RunInSandboxOptions {
  command: string;
  workspaceDir: string;
  policy: SandboxPolicy;
  timeoutMs: number;
  signal?: AbortSignal;
  // Cross-platform target
  platform?: 'linux' | 'win' | 'mac';
}

export interface SandboxRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ---------------------------------------------------------------------------
// buildSandboxEnv
// ---------------------------------------------------------------------------

/**
 * Build the filtered env object passed to bwrap child process.
 * ONLY ENV_ALLOWLIST_BASE keys + policy.allowedEnvVars are copied from
 * process.env. HOME and USER are always overridden. No other keys pass through.
 */
/** Pattern matching variable names that indicate secrets. */
const SECRET_NAME_PATTERN = /(_KEY|_SECRET|_TOKEN|_PASSWORD|_AUTH|_CREDENTIAL|_APIKEY)$/i;

/** Check if an env var name is denylisted as a secret. */
function isSecretEnvVar(name: string): boolean {
  if ((SECRET_ENV_DENYLIST as ReadonlyArray<string>).includes(name)) return true;
  if (SECRET_NAME_PATTERN.test(name)) return true;
  return false;
}

export function buildSandboxEnv(policy: SandboxPolicy): NodeJS.ProcessEnv {
  const allowedKeys = [
    ...ENV_ALLOWLIST_BASE,
    ...(policy.allowedEnvVars ?? []),
  ];

  const env: NodeJS.ProcessEnv = {};

  for (const key of allowedKeys) {
    if (isSecretEnvVar(key)) {
      log.warn({ key }, 'buildSandboxEnv: secret env var denied');
      continue;
    }
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  // Always override — never inherited from process.env.
  env['HOME'] = '/workspace';
  env['USER'] = 'sandbox';

  return env;
}

/**
 * Wrap a command with hard+soft ulimits (-SH so the child cannot raise them):
 * -t cpu seconds, -f file blocks (maxFileMB * 2048), -u processes, -v virtual
 * memory (MB * 1024). Shared by the bwrap runner and alternate exec backends so
 * the resource caps stay identical across execution environments.
 */
export function buildUlimitWrappedCommand(
  command: string,
  policy: SandboxPolicy,
  targetPlatform: 'linux' | 'mac' = 'linux',
): string {
  const cpuSeconds = policy.cpuSeconds ?? 30;
  const maxFileMB = policy.maxFileMB ?? 100;
  const memoryMB = policy.memoryMB ?? 512;
  const fileBlocks = maxFileMB * 2048;
  const kb = memoryMB * 1024;
  // macOS does not support RLIMIT_AS (`ulimit -v` fails with "invalid argument"
  // on darwin bash/zsh), so the virtual-memory cap is omitted there. All other
  // limits (-t/-f/-u) behave the same on BSD userland. Default 'linux' keeps
  // the Linux command string byte-for-byte identical.
  const vLimit = targetPlatform === 'mac' ? '' : `ulimit -SHv ${kb}; `;
  return (
    `ulimit -SHt ${cpuSeconds}; ` +
    `ulimit -SHf ${fileBlocks}; ` +
    `ulimit -SHu 64; ` +
    vLimit +
    command
  );
}

/**
 * Resolve a child-process exit code from a rejected execFile/exec error.
 *
 * `promisify(execFile)` puts the numeric exit code on `error.code` (a number),
 * NOT on `error.status` — `.status` is a `spawnSync`-only field and is
 * `undefined` for async execFile. Reading `.status` alone silently collapses
 * EVERY nonzero exit to 1 (e.g. a command that exits 7 is reported as 1).
 * Order: numeric `.code` → numeric `.status` → 1. Callers must handle string
 * `error.code` cases (ENOENT/ABORT_ERR) BEFORE calling this.
 */
export function exitCodeFromError(error: { code?: string | number; status?: number }): number {
  if (typeof error.code === 'number') return error.code;
  if (typeof error.status === 'number') return error.status;
  return 1;
}

// ---------------------------------------------------------------------------
// buildBwrapArgs
// ---------------------------------------------------------------------------

/**
 * Build the argv array for bwrap (does NOT include the bwrap binary itself).
 * The returned array is ready to pass as the args param to execFile(BWRAP_BIN, ...).
 *
 * @param _existsSync - optional override for existsSync (for unit testing only)
 * @param _realpathSync - optional override for realpathSync (for unit testing only)
 */
export function buildBwrapArgs(
  command: string,
  workspaceDir: string,
  policy: SandboxPolicy,
  _existsSync?: (p: string) => boolean,
  _realpathSync?: (p: string) => string,
  _platform?: string, // cross-platform override (ignored for bwrap linux-only)
): string[] {
  const checkExists = _existsSync ?? existsSync;
  // FIX #4: resolve symlinks before validating bind paths to prevent symlink bypass
  const resolveRealpath = _realpathSync ?? realpathSync;
  const args: string[] = [
    '--die-with-parent',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--new-session',
  ];

  if (policy.network === 'none') {
    args.push('--unshare-net');
  } else {
    // network === 'host': share the host network namespace AND bind the DNS +
    // CA files the sandbox needs to actually reach hosts (see HOST_NETWORK_RO_BINDS).
    // Existence-gated — a missing --ro-bind source makes bwrap abort.
    for (const p of HOST_NETWORK_RO_BINDS) {
      if (checkExists(p)) {
        args.push('--ro-bind', p, p);
      }
    }
  }

  // Workspace: writable bind at /workspace AND at its real host path. Binding the
  // SAME directory at a second path exposes nothing the /workspace mount doesn't
  // already — it just lets the agent reference files by the real path it authored
  // them with (e.g. `python3 <workspaceDir>/x.py`) instead of only the /workspace
  // alias, closing the write-here / run-there mismatch. Safe by construction: it is
  // the identical provisioned per-session dir; no parent or sibling (e.g. the secret
  // workspace/vault) is bound, and bwrap creates the intermediate path dirs empty.
  args.push('--bind', workspaceDir, '/workspace');
  args.push('--bind', workspaceDir, workspaceDir);

  // Core read-only system paths
  args.push('--ro-bind', '/usr', '/usr');
  args.push('--ro-bind', '/bin', '/bin');
  args.push('--ro-bind', '/lib', '/lib');

  // lib64 is conditional — not present on all Ubuntu configs
  if (checkExists('/lib64')) {
    args.push('--ro-bind', '/lib64', '/lib64');
  }

  // Pseudo-filesystems
  args.push('--proc', '/proc');
  args.push('--dev', '/dev');
  args.push('--tmpfs', '/tmp');

  // Working directory inside sandbox
  args.push('--chdir', '/workspace');

  // Extra read-only binds from policy — resolve symlinks + validate before appending
  for (const bind of policy.extraReadOnlyBinds ?? []) {
    // FIX #4: resolve symlinks first so a symlink pointing to /etc won't bypass denylist
    let resolvedBind: string;
    try {
      resolvedBind = resolveRealpath(bind);
    } catch {
      throw new SandboxPolicyError(
        `buildBwrapArgs: bind path does not exist: ${JSON.stringify(bind)}`,
      );
    }
    if (!validateBindPath(resolvedBind)) {
      throw new SandboxPolicyError(
        `buildBwrapArgs: resolved bind path unsafe: ${JSON.stringify(resolvedBind)}`,
      );
    }
    args.push('--ro-bind', resolvedBind, resolvedBind);
  }

  // Extra writable binds from policy — resolve symlinks + validate before appending
  for (const bind of policy.extraWritableBinds ?? []) {
    // FIX #4: resolve symlinks first so a symlink pointing to /etc won't bypass denylist
    let resolvedBind: string;
    try {
      resolvedBind = resolveRealpath(bind);
    } catch {
      throw new SandboxPolicyError(
        `buildBwrapArgs: bind path does not exist: ${JSON.stringify(bind)}`,
      );
    }
    if (!validateBindPath(resolvedBind)) {
      throw new SandboxPolicyError(
        `buildBwrapArgs: resolved bind path unsafe: ${JSON.stringify(resolvedBind)}`,
      );
    }
    args.push('--bind', resolvedBind, resolvedBind);
  }

  // Command separator
  args.push('--');
  args.push('/bin/bash', '-c');

  // Ulimit wrapper: set both soft AND hard limits (-SH) so the child cannot raise them.
  args.push(buildUlimitWrappedCommand(command, policy));

  return args;
}

// ---------------------------------------------------------------------------
// Platform resolution
// ---------------------------------------------------------------------------

export type SandboxTargetPlatform = 'linux' | 'win' | 'mac';

/**
 * Resolve the effective sandbox target platform.
 *
 * Precedence: explicit call option → policy.platform → host detection.
 * 'auto' (and any unknown value) falls through to host detection — on a Linux
 * host that resolves to 'linux' → bwrap, i.e. the fail-safe direction (never
 * silently unsandboxed).
 *
 * On a Linux host with no explicit platform (the production case) this returns
 * 'linux', exactly like the previous `platform || policy.platform || 'linux'`
 * default — the bwrap path is unchanged.
 *
 * @param hostPlatform - injectable for unit tests; defaults to process.platform.
 */
export function resolveSandboxPlatform(
  explicit?: string,
  policyPlatform?: string,
  hostPlatform: NodeJS.Platform = process.platform,
): SandboxTargetPlatform {
  const pick = (v?: string): SandboxTargetPlatform | undefined =>
    v === 'linux' || v === 'win' || v === 'mac' ? v : undefined;
  const fromExplicit = pick(explicit);
  if (fromExplicit) return fromExplicit;
  const fromPolicy = pick(policyPlatform);
  if (fromPolicy) return fromPolicy;
  if (hostPlatform === 'darwin') return 'mac';
  if (hostPlatform === 'win32') return 'win';
  return 'linux';
}

// ---------------------------------------------------------------------------
// macOS Seatbelt (sandbox-exec) profile
// ---------------------------------------------------------------------------

/** Escape a filesystem path for embedding in a Seatbelt profile string literal. */
function seatbeltQuote(p: string): string {
  return `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Build a macOS Seatbelt (.sb) profile that translates the bwrap policy:
 *
 *   - deny-default, like bwrap's empty mount namespace.
 *   - file-read limited to system paths (macOS needs /System + /Library +
 *     dyld caches where Linux needs /usr,/bin,/lib) + the workspace +
 *     policy.extraReadOnlyBinds — NOT the whole filesystem, so host secrets
 *     (config/.env, ~/.ssh) stay unreadable, matching bwrap's bind set.
 *   - file-write limited to the workspace (+ /private/tmp as the /tmp tmpfs
 *     analogue) + policy.extraWritableBinds.
 *   - network allowed only when policy.network === 'host', mirroring
 *     --unshare-net.
 *
 * Extra binds get the same symlink-resolution + validateBindPath treatment as
 * buildBwrapArgs (throws SandboxPolicyError on unsafe/missing paths).
 *
 * NOTE: resource limits are NOT expressed here — they come from the same
 * ulimit wrapper the bwrap path uses (see buildUlimitWrappedCommand).
 */
export function buildSeatbeltProfile(
  workspaceDir: string,
  policy: SandboxPolicy,
  _realpathSync?: (p: string) => string,
): string {
  const resolveRealpath = _realpathSync ?? realpathSync;

  const resolveValidatedBinds = (binds: string[] | undefined, label: string): string[] =>
    (binds ?? []).map((bind) => {
      let resolved: string;
      try {
        resolved = resolveRealpath(bind);
      } catch {
        throw new SandboxPolicyError(
          `buildSeatbeltProfile: ${label} bind path does not exist: ${JSON.stringify(bind)}`,
        );
      }
      if (!validateBindPath(resolved)) {
        throw new SandboxPolicyError(
          `buildSeatbeltProfile: resolved ${label} bind path unsafe: ${JSON.stringify(resolved)}`,
        );
      }
      return resolved;
    });

  const roBinds = resolveValidatedBinds(policy.extraReadOnlyBinds, 'read-only');
  const rwBinds = resolveValidatedBinds(policy.extraWritableBinds, 'writable');

  // System paths a darwin process needs to load dyld/frameworks and run
  // /bin/bash + common tools — the macOS analogue of bwrap's /usr,/bin,/lib
  // ro-binds. /etc,/tmp,/var are symlinks into /private on macOS; Seatbelt
  // matches on resolved paths, hence the /private forms.
  const readPaths = [
    '/usr',
    '/bin',
    '/sbin',
    '/System',
    '/Library',
    '/private/etc',
    '/private/var/db',
    '/private/var/select',
    '/opt/homebrew',
    '/dev',
    workspaceDir,
    ...roBinds,
    ...rwBinds,
  ];
  const writePaths = [workspaceDir, '/private/tmp', ...rwBinds];

  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process-fork)',
    '(allow process-exec*)',
    '(allow signal (target same-sandbox))',
    '(allow process-info* (target same-sandbox))',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    // Path metadata (existence/stat) must be broadly readable for path
    // resolution through symlinks like /etc → /private/etc.
    '(allow file-read-metadata)',
    `(allow file-read* ${readPaths.map((p) => `(subpath ${seatbeltQuote(p)})`).join(' ')})`,
    `(allow file-write* ${writePaths.map((p) => `(subpath ${seatbeltQuote(p)})`).join(' ')})`,
    '(allow file-write-data (literal "/dev/null") (literal "/dev/dtracehelper") (regex #"^/dev/tty"))',
    '(allow file-ioctl (literal "/dev/null") (regex #"^/dev/tty"))',
    policy.network === 'host' ? '(allow network*)' : '(deny network*)',
  ];
  return lines.join('\n');
}

/**
 * Build the argv array for sandbox-exec (does NOT include the binary itself).
 * Mirrors the bwrap contract: /bin/bash -c '<ulimit-wrapped command>'.
 */
export function buildSeatbeltArgs(
  command: string,
  workspaceDir: string,
  policy: SandboxPolicy,
  _realpathSync?: (p: string) => string,
): string[] {
  return [
    '-p',
    buildSeatbeltProfile(workspaceDir, policy, _realpathSync),
    '/bin/bash',
    '-c',
    buildUlimitWrappedCommand(command, policy, 'mac'),
  ];
}

/**
 * Run a shell command under macOS Seatbelt via sandbox-exec.
 * Same {stdout, stderr, exitCode} contract and timeout/maxBuffer/abort
 * handling as the bwrap path.
 *
 * Escape hatch: SUDO_SANDBOX_ALLOW_UNCONFINED=1 runs unsandboxed on darwin
 * with a loud per-call warning (for workloads the Seatbelt profile breaks),
 * mirroring the global SUDO_SANDBOX_DISABLE=1 kill-switch but scoped to macOS.
 */
async function runInSeatbelt(
  command: string,
  workspaceDir: string,
  policy: SandboxPolicy,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<SandboxRunResult> {
  if (process.env['SUDO_SANDBOX_ALLOW_UNCONFINED'] === '1') {
    log.warn(
      'SUDO_SANDBOX_ALLOW_UNCONFINED=1 — macOS Seatbelt sandbox bypassed, running ' +
        'unsandboxed on host. This is a security risk. Do not use in production.',
    );
    return runUnsandboxed(command, workspaceDir, policy, timeoutMs, signal);
  }

  const args = buildSeatbeltArgs(command, workspaceDir, policy);
  const env = buildSandboxEnv(policy);

  try {
    const result = await execFileAsync(SANDBOX_EXEC_BIN, args, {
      env,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
      signal,
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
    const outRaw = error.stdout;
    const errRaw = error.stderr;
    const stdout = typeof outRaw === 'string' ? outRaw : outRaw ? String(outRaw) : '';
    const stderr = typeof errRaw === 'string' ? errRaw : errRaw ? String(errRaw) : '';

    if (error.code === 'ABORT_ERR' || error.code === 'ERR_ABORT' || signal?.aborted) {
      return { stdout, stderr: stderr || 'Process aborted', exitCode: 130 };
    }

    if (error.code === 'ENOENT') {
      return {
        stdout: '',
        stderr:
          `sandbox error: sandbox-exec not found at ${SANDBOX_EXEC_BIN} (it ships with macOS). ` +
          'Set SUDO_SANDBOX_ALLOW_UNCONFINED=1 (or SUDO_SANDBOX_DISABLE=1) to run without a sandbox — unsafe.',
        exitCode: 127,
      };
    }

    return { stdout, stderr, exitCode: exitCodeFromError(error) };
  }
}

// ---------------------------------------------------------------------------
// runInSandbox
// ---------------------------------------------------------------------------

/**
 * Run a shell command inside bwrap.
 * When SUDO_SANDBOX_DISABLE=1, falls back to raw execFile with a per-call warning.
 */
export async function runInSandbox(
  opts: RunInSandboxOptions,
): Promise<SandboxRunResult> {
  const { command, workspaceDir, policy, timeoutMs, signal, platform } = opts;

  // Kill-switch precedence: an explicit SUDO_SANDBOX_DISABLE=1 means "no sandbox,
  // host exec" and MUST win over backend selection — otherwise a lingering
  // SUDO_EXEC_BACKEND would silently override the operator's decision to disable
  // sandboxing. Checked before backend dispatch and before platform gating so the
  // kill-switch is authoritative.
  if (process.env['SUDO_SANDBOX_DISABLE'] === '1') {
    log.warn(
      'SUDO_SANDBOX_DISABLE=1 — sandbox disabled, running unsandboxed on host. ' +
        'This is a security risk. Do not use in production.',
    );
    return runUnsandboxed(command, workspaceDir, policy, timeoutMs, signal);
  }

  // Pluggable exec backend (gap #27): when SUDO_EXEC_BACKEND selects a non-default
  // backend (e.g. docker), route through it. The default 'local'/'bwrap' path
  // below is unchanged. An unknown/unloadable backend warns and falls back to
  // bwrap — fail-safe, never silently to less isolation.
  const backendName = selectExecBackendName(policy);
  if (backendName !== 'local' && backendName !== 'bwrap') {
    const backend = await resolveExecBackend(backendName);
    if (backend) {
      return backend.run(opts);
    }
    // FAIL CLOSED (Feature 8): when the policy marks this backend as a REQUIRED
    // isolation boundary (an untrusted turn), a backend that cannot be resolved
    // must NOT downgrade to the host bwrap path — that would run untrusted code
    // on the host. Refuse and surface an error instead. (The Docker-daemon-down
    // case surfaces separately as a nonzero exit from backend.run, which also
    // never touches the host.)
    if (policy.requireIsolatedBackend) {
      log.error(
        { backend: backendName },
        'Required isolated exec backend unavailable — refusing to run untrusted command on host (fail-closed)',
      );
      return {
        stdout: '',
        stderr:
          `sandbox: required isolation backend '${backendName}' is unavailable ` +
          `(is Docker installed and running?) — refusing to execute an untrusted command on the host.`,
        exitCode: 126,
      };
    }
    log.warn(
      { backend: backendName },
      `SUDO_EXEC_BACKEND='${backendName}' could not be loaded or resolved — falling back to bwrap`,
    );
  }

  const effectivePlatform = resolveSandboxPlatform(platform, policy.platform);
  if (effectivePlatform !== 'linux') {
    // Real sandbox on macOS hosts: Seatbelt via sandbox-exec.
    if (effectivePlatform === 'mac' && process.platform === 'darwin') {
      return runInSeatbelt(command, workspaceDir, policy, timeoutMs, signal);
    }
    // Hardened cross-platform shim: always scrub via buildSandboxEnv; non-linux = host exec (full power per SOUL but logged); route control.file/gui via denylist in backends
    log.warn({ platform: effectivePlatform }, 'cross-platform sandbox shim (non-linux) - native with FULL env/policy scrub; file/gui/desktop control have separate denylists');
    return runUnsandboxed(command, workspaceDir, policy, timeoutMs, signal);
  }

  const bwrapArgs = buildBwrapArgs(command, workspaceDir, policy);
  const env = buildSandboxEnv(policy);

  const execOptions: Parameters<typeof execFileAsync>[2] = {
    env,
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024, // 10 MB
    signal,
  };

  try {
    const result = await execFileAsync(BWRAP_BIN, bwrapArgs, execOptions);
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

    // execFile rejects on nonzero exit — capture stdout/stderr from the error
    const outRaw = error.stdout;
    const errRaw = error.stderr;
    const stdout = typeof outRaw === 'string' ? outRaw : outRaw ? String(outRaw) : '';
    const stderr = typeof errRaw === 'string' ? errRaw : errRaw ? String(errRaw) : '';

    if (
      error.code === 'ABORT_ERR' ||
      error.code === 'ERR_ABORT' ||
      signal?.aborted
    ) {
      return { stdout, stderr: stderr || 'Process aborted', exitCode: 130 };
    }

    // Missing sandbox binary: previously surfaced as a confusing nonzero exit
    // with empty output. Make it actionable instead.
    if (error.code === 'ENOENT') {
      log.error({ bin: BWRAP_BIN }, 'bwrap binary not found — sandboxed exec unavailable');
      return {
        stdout: '',
        stderr:
          `sandbox error: bwrap not found at ${BWRAP_BIN}. Install bubblewrap ` +
          '(e.g. `apt install bubblewrap`) or set SUDO_SANDBOX_DISABLE=1 to run ' +
          'commands unsandboxed — unsafe.',
        exitCode: 127,
      };
    }

    // Numeric exit code from the child process (execFile puts it on .code)
    const exitCode = exitCodeFromError(error);

    return { stdout, stderr, exitCode };
  }
}

// ---------------------------------------------------------------------------
// Internal: unsandboxed fallback
// ---------------------------------------------------------------------------

async function runUnsandboxed(
  command: string,
  cwd: string,
  policy: SandboxPolicy,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<SandboxRunResult> {
  try {
    const env = buildSandboxEnv(policy);
    const result = await execFileAsync(
      '/bin/bash',
      ['-c', command],
      { cwd, env, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, signal },
    );
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
    const outRaw = error.stdout;
    const errRaw = error.stderr;
    const stdout = typeof outRaw === 'string' ? outRaw : outRaw ? String(outRaw) : '';
    const stderr = typeof errRaw === 'string' ? errRaw : errRaw ? String(errRaw) : '';

    // Abort → 130, parity with the bwrap + docker paths (an aborted run otherwise
    // surfaces as a generic exit 1).
    if (error.code === 'ABORT_ERR' || error.code === 'ERR_ABORT' || signal?.aborted) {
      return { stdout, stderr: stderr || 'Process aborted', exitCode: 130 };
    }

    const exitCode = exitCodeFromError(error);
    return { stdout, stderr, exitCode };
  }
}
