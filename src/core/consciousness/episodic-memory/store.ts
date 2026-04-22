/**
 * @file store.ts
 * @description Re-export barrel for the episodic memory store.
 *
 * Consumers import from here and remain unaware of the internal split into
 * store-row / store-read / store-write modules.
 */

export { rowToEpisode, type EpisodeRow } from './store-row.js';
export { saveEpisode, strengthenEpisode, weakenEpisode } from './store-write.js';
export { queryEpisodes, getRecent, getBySignificance, getByEmotion } from './store-read.js';
