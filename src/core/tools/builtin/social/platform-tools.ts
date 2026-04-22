/**
 * Social platform tools: social.multi-post, social.schedule-post.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { genId } from '../../../shared/utils.js';
import { postToMastodon, MastodonError } from './mastodon.js';
import { getDispatcherInstance } from '../../../social/schedule-dispatcher.js';

const logger = createLogger('social-platform');

// ---------------------------------------------------------------------------
// Shared helpers (not exported)
// ---------------------------------------------------------------------------

/**
 * Validate and canonicalize a scheduleTime string.
 * Throws Error (not ToolResult) so callers can handle in try/catch.
 */
function validateScheduleTime(raw: string | undefined): string {
  if (!raw) throw new Error('scheduleTime required');
  const d = new Date(raw);
  if (isNaN(d.getTime())) throw new Error(`scheduleTime is not a valid ISO 8601 date: ${raw}`);
  if (d.getTime() <= Date.now()) throw new Error(`scheduleTime must be in the future: ${raw}`);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// social.multi-post
// ---------------------------------------------------------------------------

export const multiPostTool: ToolDefinition = {
  name: 'social.multi-post',
  description: 'Post content to multiple social platforms simultaneously: twitter, mastodon, schedule. Returns per-platform success/error status.',
  category: 'social',
  timeout: 120_000,
  parameters: {
    content: { type: 'string', required: true, description: 'Post text to publish.' },
    platforms: {
      type: 'array', required: true, description: 'Target platforms.',
      items: { type: 'string', description: 'Platform name.', enum: ['twitter', 'mastodon', 'schedule'] },
    },
    mediaUrls: { type: 'array', description: 'Optional media URLs.', items: { type: 'string', description: 'Media URL or path.' } },
    scheduleTime: { type: 'string', description: 'ISO 8601 datetime for deferred posting (required when "schedule" in platforms).' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const content = params['content'] as string | undefined;
    const platforms = params['platforms'] as string[] | undefined;
    const scheduleTime = params['scheduleTime'] as string | undefined;
    const mediaUrls = (params['mediaUrls'] as string[] | undefined) ?? [];

    if (!content?.trim()) return { success: false, output: 'content is required.' };
    if (!Array.isArray(platforms) || platforms.length === 0) return { success: false, output: 'platforms must be a non-empty array.' };

    logger.info({ session: ctx.sessionId, platforms }, 'social.multi-post invoked');

    const results: Record<string, unknown> = {};
    const errors: string[] = [];

    for (const platform of platforms) {
      try {
        if (platform === 'twitter') {
          const oauthToken = process.env['TWITTER_OAUTH2_TOKEN'];
          if (!oauthToken) {
            results[platform] = { success: false, error: 'TWITTER_OAUTH2_TOKEN not configured.' };
            errors.push('twitter: missing credentials'); continue;
          }
          const res = await fetch('https://api.twitter.com/2/tweets', {
            method: 'POST',
            headers: { Authorization: `Bearer ${oauthToken}`, 'Content-Type': 'application/json' },
            signal: ctx.signal,
            body: JSON.stringify({ text: content }),
          });
          let data: { data?: { id: string }; errors?: Array<{ message: string }> };
          try {
            data = await res.json() as { data?: { id: string }; errors?: Array<{ message: string }> };
          } catch {
            const parseErrMsg = `Twitter API returned non-JSON (HTTP ${res.status})`;
            logger.warn({ status: res.status }, parseErrMsg);
            results[platform] = { success: false, error: parseErrMsg };
            errors.push(`twitter: ${parseErrMsg}`);
            continue;
          }
          if (!res.ok || data.errors) {
            const errMsg = data.errors?.[0]?.message ?? `HTTP ${res.status}`;
            results[platform] = { success: false, error: errMsg };
            errors.push(`twitter: ${errMsg}`);
          } else {
            results[platform] = { success: true, tweetId: data.data?.id };
          }

        } else if (platform === 'mastodon') {
          try {
            const mastodonResult = await postToMastodon({
              status: content,
              mediaIds: undefined, // multi-post flow does not resolve media URLs to Mastodon IDs
              visibility: 'public',
              signal: ctx.signal,
            });
            results[platform] = { success: true, id: mastodonResult.id, url: mastodonResult.url };
          } catch (mastodonErr) {
            const isMastodonErr = mastodonErr instanceof MastodonError;
            const errMsg = mastodonErr instanceof Error ? mastodonErr.message : String(mastodonErr);
            const statusCode = isMastodonErr ? mastodonErr.statusCode : undefined;
            results[platform] = { success: false, error: errMsg, statusCode };
            errors.push(`mastodon: ${errMsg}`);
          }

        } else if (platform === 'schedule') {
          let validated: string;
          try {
            validated = validateScheduleTime(scheduleTime);
          } catch (validErr) {
            const msg = validErr instanceof Error ? validErr.message : String(validErr);
            results[platform] = { success: false, error: msg };
            errors.push(`schedule: ${msg}`); continue;
          }
          const store = getDispatcherInstance().store;
          const now = new Date().toISOString();
          const realPlatforms = platforms.filter((p) => p !== 'schedule');
          const scheduleResults: Record<string, { success: true; scheduleId: string; scheduleTime: string }> = {};
          for (const p of realPlatforms) {
            const entry = store.insert({
              id: genId(),
              content,
              platforms: [p],
              mediaUrls,
              scheduleTime: validated,
              createdAt: now,
            });
            scheduleResults[p] = { success: true, scheduleId: entry.id, scheduleTime: validated };
          }
          // Expose per-platform schedule results in top-level results map
          for (const [p, r] of Object.entries(scheduleResults)) {
            results[p] = r;
          }
          results[platform] = { success: true, scheduled: scheduleResults };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results[platform] = { success: false, error: msg };
        errors.push(`${platform}: ${msg}`);
        logger.error({ platform, err: msg }, 'social.multi-post platform error');
      }
    }

    const successCount = Object.values(results).filter((r) => (r as { success?: boolean }).success).length;
    return {
      success: errors.length === 0,
      output: `Posted to ${successCount}/${platforms.length} platforms.${errors.length > 0 ? ` Errors: ${errors.join('; ')}` : ''}`,
      data: results,
    };
  },
};

// ---------------------------------------------------------------------------
// social.schedule-post
// ---------------------------------------------------------------------------

export const schedulePostTool: ToolDefinition = {
  name: 'social.schedule-post',
  description: 'Schedule a social media post for a future time. Stores entries in the SQLite scheduled_posts table. Actions: create, list, cancel.',
  category: 'social',
  timeout: 10_000,
  parameters: {
    action: { type: 'string', required: true, description: 'Operation.', enum: ['create', 'list', 'cancel'] },
    content: { type: 'string', description: 'Post text (required for create).' },
    platforms: { type: 'array', description: 'Target platforms (required for create).', items: { type: 'string', description: 'Platform name.' } },
    scheduleTime: { type: 'string', description: 'ISO 8601 datetime (required for create).' },
    scheduleId: { type: 'string', description: 'Schedule entry ID (required for cancel).' },
    mediaUrls: { type: 'array', description: 'Optional media URLs.', items: { type: 'string', description: 'URL or path.' } },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    logger.info({ session: ctx.sessionId, action }, 'social.schedule-post invoked');

    try {
      const store = getDispatcherInstance().store;

      switch (action) {
        case 'create': {
          const content = params['content'] as string | undefined;
          const platformsRaw = params['platforms'] as string | string[] | undefined;
          const scheduleTime = params['scheduleTime'] as string | undefined;
          // Backward-compat: accept single platform string or array
          const platformList: string[] = typeof platformsRaw === 'string'
            ? [platformsRaw]
            : Array.isArray(platformsRaw) ? platformsRaw : [];
          if (!content?.trim()) return { success: false, output: 'content is required.' };
          if (platformList.length === 0) return { success: false, output: 'platforms must be a non-empty array.' };
          let validated: string;
          try {
            validated = validateScheduleTime(scheduleTime);
          } catch (validErr) {
            const msg = validErr instanceof Error ? validErr.message : String(validErr);
            return { success: false, output: msg };
          }
          const mediaUrls = (params['mediaUrls'] as string[] | undefined) ?? [];
          const now = new Date().toISOString();
          if (platformList.length === 1) {
            const entry = store.insert({
              id: genId(),
              content,
              platforms: [platformList[0]!],
              mediaUrls,
              scheduleTime: validated,
              createdAt: now,
            });
            return { success: true, output: `Post scheduled for ${entry.scheduleTime} (id: ${entry.id})`, data: entry };
          }
          // Multi-platform: one row per platform
          const entries = platformList.map((p) => store.insert({
            id: genId(),
            content,
            platforms: [p],
            mediaUrls,
            scheduleTime: validated,
            createdAt: now,
          }));
          return {
            success: true,
            output: `Post scheduled for ${validated} across ${platformList.length} platform(s).`,
            data: { scheduled: entries },
          };
        }

        case 'list': {
          const pending = store.list().filter((p) => p.status === 'pending');
          return { success: true, output: pending.length > 0 ? `${pending.length} pending post(s).` : 'No pending scheduled posts.', data: pending };
        }

        case 'cancel': {
          const scheduleId = params['scheduleId'] as string | undefined;
          if (!scheduleId?.trim()) return { success: false, output: 'scheduleId is required.' };
          const existing = store.list().find((p) => p.id === scheduleId);
          if (!existing) return { success: false, output: `No scheduled post found with id: ${scheduleId}` };
          store.cancel(scheduleId);
          return { success: true, output: `Scheduled post ${scheduleId} cancelled.`, data: { ...existing, status: 'cancelled' } };
        }

        default:
          return { success: false, output: `Unknown action: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'social.schedule-post error');
      return { success: false, output: `Schedule-post error: ${msg}` };
    }
  },
};
