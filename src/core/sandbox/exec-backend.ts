/**
 * @file sandbox/exec-backend.ts
 * @description Pluggable exec-backend abstraction (gap #27).
 *
 * Opens the otherwise-hardcoded bwrap runner: a command can execute in a
 * different isolation environment (a Docker container, a remote SSH host, …)
 * selected at runtime via `SUDO_EXEC_BACKEND`. The default `local` / `bwrap`
 * path in sandbox-runner.ts is unchanged — backends are ADDITIVE.
 *
 * A backend takes the same RunInSandboxOptions the bwrap runner does and returns
 * the same SandboxRunResult, so it is a drop-in at the single dispatch point
 * (runInSandbox). Backends are registry-driven (registerExecBackend) so a
 * plugin / future module can add one without editing core; the built-in docker
 * backend is lazy-loaded only when selected.
 */

import { createLogger } from '../shared/logger.js';
import type { RunInSandboxOptions, SandboxRunResult } from './sandbox-runner.js';

const log = createLogger('sandbox:exec-backend');

/**
 * An execution backend: runs a (shell) command in some isolated environment and
 * returns its captured output. Must honor opts.timeoutMs + opts.signal and must
 * NOT throw on a nonzero command exit — surface it as `exitCode`.
 */
export interface ExecBackend {
  /** Selector token used in SUDO_EXEC_BACKEND and the registry key. */
  readonly name: string;
  run(opts: RunInSandboxOptions): Promise<SandboxRunResult>;
}

const registry = new Map<string, ExecBackend>();

/** Register (or replace) an exec backend by its name. */
export function registerExecBackend(backend: ExecBackend): void {
  registry.set(backend.name, backend);
}

export function getRegisteredExecBackend(name: string): ExecBackend | null {
  return registry.get(name) ?? null;
}

export function listExecBackends(): string[] {
  return [...registry.keys()];
}

/**
 * Reset the registry. Test-only — not re-exported from sandbox/index.ts, so it is
 * not part of the public surface.
 * @internal
 */
export function clearExecBackends(): void {
  registry.clear();
}

/** The selected backend name (default 'local' = the built-in bwrap path). */
export function selectExecBackendName(): string {
  return (process.env['SUDO_EXEC_BACKEND'] ?? 'local').trim().toLowerCase() || 'local';
}

/**
 * Resolve the backend for a name. Returns null for the default local/bwrap path
 * (the caller runs its existing inline logic) and for an unknown name (the
 * caller warns + falls back to bwrap — fail-safe, never to less isolation).
 * Built-in backends are lazy-loaded on first use.
 */
export async function resolveExecBackend(name: string): Promise<ExecBackend | null> {
  if (name === 'local' || name === 'bwrap') return null;

  const existing = registry.get(name);
  if (existing) return existing;

  if (name === 'docker') {
    try {
      const { dockerBackend } = await import('./backends/docker-backend.js');
      registry.set('docker', dockerBackend);
      return dockerBackend;
    } catch (err) {
      log.warn({ err: String(err) }, 'failed to load the docker exec backend');
      return null;
    }
  }

  return null;
}
