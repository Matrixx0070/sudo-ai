/**
 * @file sandbox/sandbox-types.ts
 * @description Types and constants for the bwrap container sandbox system.
 * Provides SandboxPolicy interface and base environment allowlist.
 */

import { PROVIDER_BASE_URLS } from '../../llm/endpoints.js';

/** Hostname of an LLM provider, derived from the src/llm endpoint choke point. */
function providerHost(provider: keyof typeof PROVIDER_BASE_URLS): string {
  return new URL(PROVIDER_BASE_URLS[provider]).hostname;
}

// ---------------------------------------------------------------------------
// SandboxPolicy
// ---------------------------------------------------------------------------

export interface SandboxPolicy {
  /** Whether sandboxing is active. Default: true. */
  enabled: boolean;
  /**
   * Network isolation mode. Default: 'none'.
   *  - 'none'      — no interface at all.
   *  - 'host'      — full host network (owner-tier only).
   *  - 'allowlist' — ENFORCED egress allowlist (Spec 8 step 4): the docker
   *    backend runs the container on an internal (no-NAT, no-DNS, no-route)
   *    network whose only reachable endpoint is a host-side proxy that admits
   *    just `allowedEgressHosts` on ports 80/443 and refuses targets resolving
   *    to private/link-local/metadata ranges. Backends that cannot enforce it
   *    (bwrap/host) treat it as 'none' — fail closed, never open.
   */
  network: 'none' | 'host' | 'allowlist';
  /** CPU time limit in seconds (ulimit -t). Default: 30. */
  cpuSeconds?: number;
  /**
   * Virtual-memory limit in MB (ulimit -v, applied in KB). Default: 4096.
   * NOTE: this caps VIRTUAL address space, not resident memory. Modern Node/V8
   * reserves a ~4 GB virtual "pointer-compression cage" at startup, so any value
   * below ~4096 makes `node` (and thus npm/npx/claude) fail to boot with
   * "Failed to reserve virtual memory for CodeRange" / fatal OOM — even though
   * actual resident use is tiny. Do not lower below 4096 unless the sandbox will
   * never run a Node process.
   */
  memoryMB?: number;
  /**
   * Max file size in MB (ulimit -f, applied in 512-byte blocks). Default: 1024.
   * Too low a value makes large package installs (e.g. bundled CLIs) die with
   * SIGXFSZ while unpacking. 1 GB comfortably covers npm/pip artifacts.
   */
  maxFileMB?: number;
  /** Additional read-only bind mounts inside bwrap. e.g. ['/opt/python'] */
  extraReadOnlyBinds?: string[];
  /** Additional writable bind mounts inside bwrap. */
  extraWritableBinds?: string[];
  /** Additional env var names allowed beyond ENV_ALLOWLIST_BASE. */
  allowedEnvVars?: string[];

  /**
   * Hostnames reachable in network:'allowlist' mode (`*.example.com` entries
   * match subdomains). Unset → SUDO_SANDBOX_EGRESS_ALLOWLIST env override or
   * DEFAULT_EGRESS_ALLOWLIST. Ignored in 'none'/'host' modes.
   */
  allowedEgressHosts?: string[];

  /**
   * Per-policy exec backend selector (gap #27). When set, takes precedence over
   * the global SUDO_EXEC_BACKEND env so different policies/profiles can route to
   * different backends (e.g. 'docker', 'ssh', 'local'/'bwrap'). Unset → the env
   * default. Cannot disable sandboxing — that is the env-only SUDO_SANDBOX_DISABLE
   * kill-switch, which still wins over any backend selection.
   */
  execBackend?: string;

  /**
   * When true, the selected `execBackend` is MANDATORY — a required isolation
   * boundary for an untrusted turn (Feature 8 trust-tier routing). If that
   * backend cannot be resolved/loaded (e.g. Docker is down), runInSandbox must
   * FAIL CLOSED: refuse to run and surface an error, NEVER silently downgrade to
   * the host bwrap path. Owner/internal turns leave this unset and keep the
   * existing fail-safe fallback. Set programmatically per turn, not from config.
   */
  requireIsolatedBackend?: boolean;

  // Cross-platform expansion (compat for Win/Mac shims + policy)
  platform?: 'linux' | 'win' | 'mac' | 'auto';
  enableCrossPlatform?: boolean;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_SANDBOX_POLICY: SandboxPolicy = {
  enabled: true,
  network: 'none',
  cpuSeconds: 30,
  // 4 GB virtual (not resident) — the minimum that lets Node/V8 reserve its
  // pointer-compression cage and boot. Below this every node/npm/claude call OOMs.
  memoryMB: 4096,
  // 1 GB max file size — large enough to unpack bundled CLIs without SIGXFSZ.
  maxFileMB: 1024,
};

/**
 * Advisory trusted-host set for the agent's outbound network, seeded from the
 * hosts the operator flagged as needed (Hugging Face model files, Python/npm
 * packages, GitHub assets, external LLM APIs).
 *
 * IMPORTANT: in network:'host' mode this is NOT enforced — the sandbox shares
 * the full host network and can reach any host. In network:'allowlist' mode it
 * IS enforced (egress-proxy.ts) as the default host set when the policy does
 * not name its own `allowedEgressHosts`.
 * Override with SUDO_SANDBOX_EGRESS_ALLOWLIST (comma-separated hostnames).
 */
export const DEFAULT_EGRESS_ALLOWLIST: ReadonlyArray<string> = [
  // Hugging Face — model files (e.g. Kokoro ONNX TTS)
  'huggingface.co',
  'cdn-lfs.huggingface.co',
  'hf.co',
  // Python / npm packages
  'pypi.org',
  'files.pythonhosted.org',
  'registry.npmjs.org',
  // GitHub release assets + raw content
  'github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  // External LLM APIs — derived from src/llm/endpoints.ts so the allowlist can
  // never drift from the URLs the code actually calls. NOTE: deliberately NOT
  // the full PROVIDER_HOSTNAMES set (groq is not in the historical allowlist).
  providerHost('openai'),
  providerHost('anthropic'),
  providerHost('google'),
  providerHost('xai'),
  providerHost('deepseek'),
];

/**
 * The host set enforced for a policy in network:'allowlist' mode: the policy's
 * own list wins, then the SUDO_SANDBOX_EGRESS_ALLOWLIST env override, then
 * DEFAULT_EGRESS_ALLOWLIST.
 */
export function resolveEgressAllowlist(policy: Pick<SandboxPolicy, 'allowedEgressHosts'>): string[] {
  if (policy.allowedEgressHosts && policy.allowedEgressHosts.length > 0) {
    return [...policy.allowedEgressHosts];
  }
  const envList = (process.env['SUDO_SANDBOX_EGRESS_ALLOWLIST'] ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  if (envList.length > 0) return envList;
  return [...DEFAULT_EGRESS_ALLOWLIST];
}

/**
 * Base set of environment variable names passed through to the sandbox.
 * HOME and USER are always overridden (not inherited from process.env).
 */
export const ENV_ALLOWLIST_BASE: ReadonlyArray<string> = [
  'PATH',
  'LANG',
  'LC_ALL',
  'TERM',
];

/**
 * Exact environment variable names that must never be passed into the sandbox,
 * regardless of what policy.allowedEnvVars requests.
 */
export const SECRET_ENV_DENYLIST: ReadonlyArray<string> = [
  'ANTHROPIC_API_KEY',
  'TWILIO_AUTH_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'OPENAI_API_KEY',
  'GROK_API_KEY',
  'DEEPSEEK_API_KEY',
  'GEMINI_API_KEY',
];

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/**
 * Thrown when a SandboxPolicy contains an invalid or unsafe bind path.
 */
export class SandboxPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxPolicyError';
  }
}

/**
 * Thrown by SandboxManager when an operation receives an invalid argument.
 */
export class SandboxManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxManagerError';
  }
}
