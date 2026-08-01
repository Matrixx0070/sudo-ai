/**
 * YouTube module — public re-exports.
 *
 * Import from here rather than reaching into sub-files directly.
 */

export { CommentEngine } from './comment-engine.js';
export type { YouTubeComment, CommentStats } from './comment-types.js';

export { ThumbnailABTester } from './thumbnail-ab.js';
export type { ABTest, ThumbnailVariant } from './thumbnail-ab-schema.js';

export {
  getYouTubeAccessToken,
  hasYouTubeCredential,
  readAuthConfigFromEnv,
  YouTubeAuthError,
} from './auth.js';
export type { TokenResult, YouTubeAuthConfig } from './auth.js';

export {
  QuotaLedger,
  QuotaExceededError,
  SearchDeniedError,
  QUOTA_COSTS,
  pacificDay,
} from './quota-ledger.js';
export type { QuotaStatus, QuotaMethod } from './quota-ledger.js';

export { assessPublishCandidate, mayPublish, similarity } from './policy-gate.js';
export type {
  PolicyAssessment,
  PolicyVerdict,
  PublishCandidate,
  PublishedVideo,
  JudgeVerdict,
} from './policy-gate.js';
