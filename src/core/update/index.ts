/**
 * @file index.ts
 * @description Barrel export for the SUDO-AI Auto-Update System.
 *
 * All public classes, interfaces, and types for the update module
 * are re-exported from this single entry point.
 */

export type {
  UpdateChannel,
  UpdateStage,
  VersionCheckResult,
  UpdateResult,
  AutoUpdateConfig,
  VersionRecord,
  UpdateEventPayload,
  LockInfo,
  RemoteVersionInfo,
} from './update-manager-types.js';

export { DEFAULT_UPDATE_CONFIG } from './update-manager-types.js';
export { UpdateLock } from './update-lock.js';
export { RollbackStore } from './rollback-store.js';
export { VersionResolver, compareSemver } from './version-resolver.js';
export { AutoUpdateManager } from './update-manager.js';