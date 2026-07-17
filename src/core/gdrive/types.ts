/**
 * @file gdrive/types.ts
 * @description Shared types for the Google Drive foundation layer (Phase 0 of
 * the Drive roadmap, docs/DRIVE_ROADMAP_STATUS.md).
 *
 * Prime directive 1: nothing in this module is ever awaited on the agent
 * hot path — all Drive I/O is background-job plumbing. A vitest guard
 * (tests/gdrive/hot-path.test.ts) asserts the agent loop / llm transport
 * never import from src/core/gdrive.
 */

/** Which auth flow the client uses. Service account is the default. */
export type GdriveAuthMode = 'service_account' | 'oauth';

/** Request priority lane. Interactive drains strictly before background. */
export type GdriveLane = 'interactive' | 'background';

/** Validated runtime configuration (from env; see config.ts). */
export interface GdriveConfig {
  enabled: boolean;
  authMode: GdriveAuthMode;
  /** Path to the service-account JSON key (GOOGLE_APPLICATION_CREDENTIALS). */
  credentialsPath?: string;
  /** OAuth loopback mode: client-secret JSON + stored-token file paths. */
  oauthClientFile?: string;
  oauthTokenFile?: string;
  /** Drive fileId of the shared `sudo-ai/` root folder. */
  rootFolderId?: string;
  /** Token-bucket sustained rate (req/s). */
  requestsPerSecond: number;
  /** Token-bucket burst capacity. */
  burst: number;
  /** Max retry attempts on retryable errors. */
  maxRetries: number;
  /** Heartbeat cadence (ms) for ops/heartbeat.json. */
  heartbeatIntervalMs: number;
}

/** Typed error classification for Drive/Sheets API failures. */
export type GdriveErrorKind =
  | 'rate' // 429 / 403 rate-limit reasons — retryable
  | 'auth' // 401 / 403 permission — NOT retryable
  | 'not_found' // 404
  | 'server' // 5xx — retryable
  | 'network' // DNS/conn/reset/timeout — retryable
  | 'invalid'; // 400-class caller errors — NOT retryable

/** One entry in the audit record every background job emits (invariant 9). */
export interface GdriveJobAudit {
  job: string;
  inputsDigest?: string;
  filesTouched?: string[];
  bytes?: number;
  outcome: 'success' | 'failure' | 'denied' | 'error';
  durationMs: number;
  detail?: Record<string, unknown>;
}

/** Minimal file metadata surface the foundation exposes. */
export interface GdriveFileMeta {
  id: string;
  name: string;
  mimeType?: string;
  parents?: string[];
  modifiedTime?: string;
  size?: string;
  trashed?: boolean;
  headRevisionId?: string;
}

/** Map of canonical logical folder path (e.g. "memory/blobs") -> Drive folderId. */
export type FolderIdMap = Record<string, string>;
