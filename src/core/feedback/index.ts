/**
 * feedback/index.ts — public surface of the Feedback module.
 *
 * Exports:
 *  - YouTubeAnalytics / LearningEngine — YouTube performance loop
 *  - Task feedback store + Telegram keyboard builder
 */

export { YouTubeAnalytics } from './youtube-analytics.js';
export type { VideoPerformance, PerformanceInsight } from './youtube-analytics.js';

export { LearningEngine } from './learning-engine.js';
export { parseDuration, listChannelVideoIds, fetchVideoStats, enrichWithAnalytics } from './youtube-api.js';

// Task feedback (👍/👎 after every Telegram reply)
export { saveFeedback, addNoteToFeedback, getFeedbackStats, detectTaskType } from './store.js';
export type { FeedbackEntry, FeedbackStats, Rating } from './store.js';
export { createFeedbackKeyboard } from './keyboard.js';
export type { PendingFeedback } from './keyboard.js';
