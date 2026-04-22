/**
 * YouTube module — public re-exports.
 *
 * Import from here rather than reaching into sub-files directly.
 */

export { CommentEngine } from './comment-engine.js';
export type { YouTubeComment, CommentStats } from './comment-types.js';

export { ThumbnailABTester } from './thumbnail-ab.js';
export type { ABTest, ThumbnailVariant } from './thumbnail-ab-schema.js';
