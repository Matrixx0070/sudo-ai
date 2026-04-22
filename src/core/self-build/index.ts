/**
 * @file self-build/index.ts
 * @description Barrel export for the self-build module.
 *
 * Builder L imports from here to wire the orchestrator into cli.ts.
 * Builder J imports PROTECTED_PATHS to validate git hooks.
 */

export {
  runSelfBuildTick,
  type SelfBuildDeps,
  type TickResult,
  type TickStatus,
} from './orchestrator.js';

export {
  PROTECTED_PATHS,
  isProtectedPath,
} from './protected-paths.js';
