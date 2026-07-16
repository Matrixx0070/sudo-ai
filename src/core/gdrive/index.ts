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
// Phase 1 — integrity substrate (F17/F16/F29)
export { canonicalJson, CanonicalJsonError } from './canonical-json.js';
export { loadHmacKey, loadEncKey, type BrainKeys } from './keys.js';
export {
  encryptZone1,
  decryptZone1,
  classifyZone,
  ZoneCryptoError,
  type Zone,
} from './zones.js';
export {
  deriveTrustTier,
  TRUST_WEIGHTS,
  type TrustTier,
  type TrustContext,
  type PermissionLike,
  type ProvenanceRecord,
} from './trust.js';
export {
  buildManifest,
  verifyManifest,
  computeManifestHmac,
  isNewerManifest,
  sha256Hex,
  ManifestVerifyError,
  type BrainManifest,
  type ManifestEntry,
  type EntryCategory,
} from './manifest.js';
export {
  pushBrain,
  hydrateBrain,
  gcBlobs,
  prepareBlobs,
  MANIFEST_FILE_NAME,
  type BrainBlobInput,
  type PushResult,
  type HydrateResult,
} from './blob-store.js';
// Phase 2 — durability & reproducibility (F2/F36/F10/F9)
export {
  loadVersionedManifest,
  CURRENT_MANIFEST_SCHEMA,
  MIGRATIONS,
  type ManifestMigration,
} from './migrations.js';
export {
  collectBrainSnapshot,
  applyBrainSnapshot,
  type BrainSnapshotDeps,
  type ChunkStoreLike,
  type StructuredStoreLike,
  type ApplyReport,
} from './brain-serializer.js';
export {
  runCheckpoint,
  runRestoreCheck,
  runRestoreDrill,
  loadBrainState,
  saveBrainState,
  type CheckpointDeps,
  type BrainState,
  type RestoreOutcome,
  type DrillResult,
} from './checkpoint.js';
export { createRelease, getRelease, MAX_PINNED_REVISIONS, type ReleaseResult } from './releases.js';
export { bisectBrain, diffManifests, type BisectJudge, type BisectResult, type ManifestDiff } from './bisect.js';
export {
  buildRunBundle,
  packBundle,
  unpackBundle,
  verifyBundle,
  uploadBundle,
  type RunBundle,
  type BuildBundleParams,
} from './flight-recorder.js';
export {
  runGdriveCheckpointJob,
  runGdriveRestoreCheckJob,
  runGdriveRestoreDrillJob,
  runGdriveInboxJob,
  setGdriveInspectorBrain,
} from './runtime.js';
// Phase 3 — guarded ingestion (F18/F1/F15/F19)
export {
  inspectContent,
  scoreContentDeterministic,
  quarantineAndInspect,
  buildInspectorPrompt,
  DEFAULT_RISK_THRESHOLD,
  type InspectionVerdict,
  type InspectorBrainCall,
  type InspectOptions,
  type QuarantineResult,
} from './quarantine.js';
export {
  loadCanaryConfig,
  checkCanaryFileId,
  checkCanaryPayload,
  tripCanary,
  isGdrivePaused,
  setGdrivePaused,
  clearGdrivePause,
  canaryConfigPath,
  type CanaryConfig,
  type CanaryHit,
} from './canary.js';
export { ocrViaDriveImport, looksLikeUsableText, OCR_CONVERTIBLE_MIMES, type OcrResult } from './ocr.js';
export {
  processInboxOnce,
  chunkText,
  DEFAULT_MAX_SOURCE_BYTES,
  type InboxDeps,
  type InboxSweepResult,
} from './inbox.js';
