/**
 * @file gdrive/index.ts
 * @description Barrel for the Google Drive foundation layer (Drive roadmap
 * Phase 0). The ONLY intended import surface for other modules.
 *
 * INVARIANT: nothing under src/core/agent/, src/llm/, or the retrieval path
 * may import this module — Drive I/O is background-only. Enforced by
 * tests/gdrive/hot-path.test.ts.
 */

export * from './types.js';
export { GdriveConfigError, isGdriveEnabled, loadGdriveConfig } from './config.js';
export { GdriveApiError, mapGdriveError } from './errors.js';
export { TokenBucketLimiter, type TokenBucketOptions } from './rate-limiter.js';
export { withBackoff, backoffDelayMs, type BackoffOptions } from './backoff.js';
export { createAuthClient, createOAuthClient, runOAuthLoopbackFlow, GDRIVE_SCOPES } from './auth.js';
export { DriveClient, FOLDER_MIME, type DriveClientDeps, type CallOpts } from './client.js';
export {
  CANONICAL_FOLDERS,
  ensureFolderTree,
  loadFolderIdCache,
  saveFolderIdCache,
  folderIdCachePath,
} from './bootstrap.js';
export { emitGdriveAudit, auditedJob, digestInputs, GDRIVE_AUDIT_ACTOR } from './audit.js';
export { writeHeartbeat, buildHeartbeatBody, HEARTBEAT_FILE_NAME } from './heartbeat.js';
export { getGdriveRuntime, runGdriveHeartbeatJob, _resetGdriveRuntime } from './runtime.js';
