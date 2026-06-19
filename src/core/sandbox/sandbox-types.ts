/**
 * @file sandbox/sandbox-types.ts
 * @description Types and constants for the bwrap container sandbox system.
 * Provides SandboxPolicy interface and base environment allowlist.
 */

// ---------------------------------------------------------------------------
// SandboxPolicy
// ---------------------------------------------------------------------------

export interface SandboxPolicy {
  /** Whether sandboxing is active. Default: true. */
  enabled: boolean;
  /** Network isolation mode. Default: 'none'. */
  network: 'none' | 'host';
  /** CPU time limit in seconds (ulimit -t). Default: 30. */
  cpuSeconds?: number;
  /** Memory limit in MB (ulimit -v in KB). Default: 512. */
  memoryMB?: number;
  /** Max file size in MB (ulimit -f in 512-byte blocks). Default: 100. */
  maxFileMB?: number;
  /** Additional read-only bind mounts inside bwrap. e.g. ['/opt/python'] */
  extraReadOnlyBinds?: string[];
  /** Additional writable bind mounts inside bwrap. */
  extraWritableBinds?: string[];
  /** Additional env var names allowed beyond ENV_ALLOWLIST_BASE. */
  allowedEnvVars?: string[];

  /**
   * Per-policy exec backend selector (gap #27). When set, takes precedence over
   * the global SUDO_EXEC_BACKEND env so different policies/profiles can route to
   * different backends (e.g. 'docker', 'ssh', 'local'/'bwrap'). Unset → the env
   * default. Cannot disable sandboxing — that is the env-only SUDO_SANDBOX_DISABLE
   * kill-switch, which still wins over any backend selection.
   */
  execBackend?: string;

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
  memoryMB: 512,
  maxFileMB: 100,
};

/**
 * Advisory trusted-host set for the agent's outbound network, seeded from the
 * hosts the operator flagged as needed (Hugging Face model files, Python/npm
 * packages, GitHub assets, external LLM APIs).
 *
 * IMPORTANT: in network:'host' mode this is NOT enforced — the sandbox shares
 * the full host network and can reach any host. It is logged at startup as the
 * declared trusted set and is the seed for a future per-host allowlist mode.
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
  // External LLM APIs
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'api.x.ai',
  'api.deepseek.com',
];

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
