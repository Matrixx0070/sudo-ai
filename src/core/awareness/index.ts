/**
 * Awareness module — real-time world monitoring for SUDO-AI v4.
 *
 * Exports:
 *   TrendRadar   — interval-based scanner for HN, Reddit, Google Trends
 *   TrendItem    — normalised trend record type
 *   TrendAlert   — actionable alert derived from a niche-matching trend
 */

export { TrendRadar } from './trend-radar.js';
export type { TrendItem, TrendAlert } from './trend-radar-types.js';

// Upgrade 65: Proactive Notifications
export {
  notify,
  onNotification,
  getUnread,
  dismiss,
  dismissAll,
  getByPriority,
} from './proactive-notifier.js';
export type { ProactiveNotification, NotificationType } from './proactive-notifier.js';

// F91: user-adapter (Upgrade 67) removed — never wired to any consumer.
