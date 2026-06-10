/**
 * @file sandbox/index.ts
 * @description Public barrel for the sandbox module.
 *
 * Capability flag: set SUDO_WASM_SANDBOX=1 to enable the wasmtime-based runner.
 * If wasmtime is not installed, WasmRunner.isAvailable returns false and run()
 * returns a graceful error result. The bwrap sandbox is unaffected.
 */

export {
  type SandboxPolicy,
  DEFAULT_SANDBOX_POLICY,
  ENV_ALLOWLIST_BASE,
} from './sandbox-types.js';
// Cross-platform: platform + enableCrossPlatform now in SandboxPolicy (see types + runner shims for win/mac)

export {
  mergePolicy,
  parsePolicy,
} from './sandbox-policy.js';

export {
  type RunInSandboxOptions,
  type SandboxRunResult,
  buildBwrapArgs,
  buildSandboxEnv,
  runInSandbox,
} from './sandbox-runner.js';

export {
  type SandboxManagerOptions,
  SandboxManager,
} from './sandbox-manager.js';

// ---------------------------------------------------------------------------
// WASM sandbox runner (coexists with bwrap sandbox above)
// Enable via SUDO_WASM_SANDBOX=1 env var; graceful no-op if wasmtime absent.
// ---------------------------------------------------------------------------

export {
  type WasmRunInput,
  type WasmRunResult,
  WasmRunner,
  wasmRunner,
  isAvailable as wasmSandboxAvailable,
  checkWasmAvailability,
} from './wasm-runner.js';
