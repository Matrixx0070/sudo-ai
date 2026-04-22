/**
 * Social media toolkit — registers 6 social tools into the ToolRegistry.
 *
 * Tools registered:
 *   social.multi-post         — Post to multiple platforms simultaneously
 *   social.schedule-post      — Schedule posts with optimal timing
 *   social.youtube-upload     — Upload videos to YouTube with metadata
 *   social.youtube-analytics  — Pull YouTube channel analytics (Data API v3)
 *   social.twitter-manager    — Tweet, reply, threads, DMs, schedule (API v2)
 *   social.trend-scanner      — Scan trending topics across platforms
 *
 * Module layout:
 *   helpers.ts       — Shared utilities (missingKey, ensureDir, schedule persistence)
 *   platform-tools.ts — social.multi-post, social.schedule-post
 *   twitter-tools.ts  — social.twitter-manager, social.trend-scanner
 *   youtube-tools.ts  — social.youtube-upload, social.youtube-analytics
 */

import type { ToolRegistry } from '../../registry.js';
import type { ToolDefinition } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';

import { multiPostTool, schedulePostTool } from './platform-tools.js';
import { twitterManagerTool, trendScannerTool } from './twitter-tools.js';
import { youtubeUploadTool, youtubeAnalyticsTool } from './youtube-tools.js';

const logger = createLogger('social-builtin');

// ---------------------------------------------------------------------------
// Tool manifest
// ---------------------------------------------------------------------------

const SOCIAL_TOOLS: ToolDefinition[] = [
  multiPostTool,
  schedulePostTool,
  youtubeUploadTool,
  youtubeAnalyticsTool,
  twitterManagerTool,
  trendScannerTool,
];

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register all social tools with the given registry.
 * Called automatically by the built-in tool loader.
 *
 * @param registry - The application's central {@link ToolRegistry}.
 */
export function registerSocialTools(registry: ToolRegistry): void {
  logger.info({ count: SOCIAL_TOOLS.length }, 'Registering social tools');
  for (const tool of SOCIAL_TOOLS) {
    registry.register(tool);
  }
  logger.info({ count: SOCIAL_TOOLS.length }, 'Social tools registered');
}
