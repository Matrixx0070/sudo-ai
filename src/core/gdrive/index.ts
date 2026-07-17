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
// Phase 4 — human interface (F3/F4/F6/F7/F30/F21)
export {
  buildDailyReport,
  publishDailyReport,
  listHeldQuarantine,
  type DailyReportInputs,
} from './report.js';
export {
  ensureScorecard,
  appendEvalRow,
  appendTelemetryRow,
  SCORECARD_NAME,
  type EvalRow,
  type TelemetryRow,
} from './scorecard.js';
export {
  ensureControlPanel,
  pollControlPanel,
  defaultTunables,
  frozenKeySet,
  CONTROL_PANEL_NAME,
  type TunableSpec,
  type PanelPollResult,
} from './control-panel.js';
export { pollComments, watchDoc, loadWatchedDocs, type CommentsDeps, type CommentsPollResult } from './comments.js';
export { buildAtlas, publishAtlas, ATLAS_NAME, type AtlasInputs } from './atlas.js';
export { verifyPing, signPing, handlePushPing, PING_TOLERANCE_MS, type PushPing, type PushKind } from './push.js';
export {
  runGdriveDailyReportJob,
  runGdriveControlPanelJob,
  runGdriveCommentsJob,
  runGdriveAtlasJob,
} from './runtime.js';
// Phase 5 — epistemics (F22/F23/F24/F31/F33/F37 + ranking rider)
export {
  loadBeliefs,
  saveBeliefs,
  upsertBelief,
  flagSourceChanged,
  flagSourceDeleted,
  dueForReview,
  recordValidationPass,
  recordValidationFail,
  runRevalidationSweep,
  buildEpistemicAdjuster,
  unhealthyBeliefs,
  REVIEW_LADDER_DAYS,
  type Belief,
  type BeliefsGraph,
} from './beliefs.js';
export { runChangesSweep, loadChangesToken, saveChangesToken, type ChangesSweepResult } from './changes.js';
export {
  noteToFutureSelf,
  listDueNotes,
  listPendingNotes,
  deliverDueNotes,
  type ProspectiveNote,
} from './prospective.js';
export {
  appendChronicle,
  opsFromManifestDiff,
  readChronicle,
  uploadChronicle,
  knewAt,
  type ChronicleOp,
  type KnewAtView,
} from './chronicle.js';
export {
  draftDeadEnd,
  confirmDeadEnd,
  listDeadEnds,
  matchDeadEnds,
  uploadDeadEnds,
  type DeadEnd,
} from './dead-ends.js';
export {
  runMirrorSweep,
  loadMirrorConfig,
  defaultFetcher,
  type MirrorRef,
  type MirrorConfig,
  type MirrorSweepResult,
} from './mirror.js';
export {
  runGdriveChangesJob,
  runGdriveRevalidationJob,
  runGdriveMirrorJob,
} from './runtime.js';
// Phase 6 — autonomy & continuity (F12/F11/F27/F28/F35/F14)
export { runDreamCycle, type DreamDeps, type DreamReport } from './dream.js';
export {
  freezeFile,
  runFreezeSweep,
  searchStubs,
  recallFrozen,
  prefetchFrozen,
  freeRecall,
  type FreezeStub,
} from './deep-freeze.js';
export {
  exportEmbeddingCache,
  importEmbeddingCache,
  packSnapshot,
  unpackSnapshot,
  uploadIndexSnapshot,
  hydrateIndexSnapshot,
  SNAPSHOT_FORMAT_VERSION,
  type IndexSnapshot,
} from './index-snapshot.js';
export {
  hibernateTask,
  resumeTask,
  archiveTask,
  type HibernatedTask,
  type ResumeOutcome,
} from './hibernate.js';
export {
  getInstanceId,
  writeMyStatus,
  readPeers,
  resolveClaim,
  type BlackboardStatus,
} from './blackboard.js';
export {
  runGdriveDreamJob,
  runGdriveFreezeJob,
  runGdriveBlackboardJob,
  runGdriveIndexSnapshotJob,
  runGdriveCuriosityJob,
} from './runtime.js';
// Phase 7 — experimentation & ops backbone (F8/F32/F25/F26/F38)
export {
  listCandidates,
  evalCandidate,
  readApprovals,
  promoteCandidate,
  rollbackSkill,
  stableSkillsDir,
  type SkillCandidate,
  type SkillEvalRunner,
  type PromotionOutcome,
} from './skill-registry.js';
export {
  exportDecisionPacket,
  writeDissent,
  awaitDissent,
  resolveDissent,
  type DecisionPacket,
  type ReviewerCall,
  type SecondOpinionOutcome,
} from './second-opinion.js';
export { forkBrain, recordForkScore, adoptFork } from './forks.js';
export {
  appendDatasetRow,
  readDataset,
  retrieveExemplars,
  uploadDatasets,
  type DatasetName,
  type Exemplar,
} from './datasets.js';
export {
  appendCuriosity,
  listCuriosity,
  drainCuriosity,
  type ResearchCall,
  type DrainResult,
} from './curiosity.js';
