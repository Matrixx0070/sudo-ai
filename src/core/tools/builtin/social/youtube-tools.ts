/**
 * Social YouTube tools: social.youtube-upload, social.youtube-analytics.
 */

import { readFileSync, statSync } from 'node:fs';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { missingKey } from './helpers.js';
import { toolFetch } from '../../../security/guarded-fetch.js';
import { getYouTubeAccessToken, hasYouTubeCredential } from '../../../youtube/auth.js';
import { QuotaLedger, QuotaExceededError } from '../../../youtube/quota-ledger.js';

const logger = createLogger('social-youtube');

/**
 * Master publish kill switch (roadmap gate 16). Default OFF.
 *
 * Publishing to a real channel is irreversible and, once monetised, touches real
 * money. It stays disabled until an operator turns it on deliberately. Read-only
 * analytics is unaffected.
 */
function publishEnabled(): boolean {
  return process.env['SUDO_YT_PUBLISH_ENABLED'] === '1';
}

function quotaLedger(): QuotaLedger {
  return new QuotaLedger({
    dbPath: process.env['SUDO_YT_QUOTA_DB'] ?? 'data/youtube-quota.db',
  });
}

/**
 * Resolve a usable access token, refreshing it if needed (GAP-01).
 *
 * Returns a ToolResult on failure so callers keep the existing "missing key"
 * contract instead of throwing out of the tool boundary.
 */
async function resolveToken(
  toolName: string,
): Promise<{ token: string } | { error: ToolResult }> {
  if (!hasYouTubeCredential()) {
    return { error: missingKey('YOUTUBE_OAUTH_REFRESH_TOKEN (or legacy YOUTUBE_OAUTH_TOKEN)', toolName) };
  }
  try {
    const { accessToken } = await getYouTubeAccessToken();
    return { token: accessToken };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ tool: toolName, err: msg }, 'YouTube auth failed');
    return { error: { success: false, output: `YouTube auth failed: ${msg}` } };
  }
}

// ---------------------------------------------------------------------------
// social.youtube-upload
// ---------------------------------------------------------------------------

export const youtubeUploadTool: ToolDefinition = {
  name: 'social.youtube-upload',
  description: 'Upload a video to YouTube via the Data API v3 resumable upload. Requires YOUTUBE_OAUTH_TOKEN (OAuth 2.0 access token with youtube.upload scope).',
  category: 'social',
  timeout: 600_000,
  requiresConfirmation: true,
  parameters: {
    videoPath: { type: 'string', required: true, description: 'Absolute path to the video file.' },
    title: { type: 'string', required: true, description: 'Video title (max 100 characters).' },
    description: { type: 'string', description: 'Video description.' },
    tags: { type: 'array', description: 'Keyword tags.', items: { type: 'string', description: 'Tag string.' } },
    categoryId: { type: 'string', description: 'YouTube category ID (default: 22 = People & Blogs).', default: '22' },
    privacyStatus: { type: 'string', description: 'Privacy (default: private).', enum: ['public', 'private', 'unlisted'], default: 'private' },
    madeForKids: { type: 'boolean', description: 'Made for kids (default: false).', default: false },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const videoPath = params['videoPath'] as string | undefined;
    const title = params['title'] as string | undefined;
    const description = (params['description'] as string | undefined) ?? '';
    const tags = (params['tags'] as string[] | undefined) ?? [];
    const categoryId = (params['categoryId'] as string | undefined) ?? '22';
    const privacyStatus = (params['privacyStatus'] as string | undefined) ?? 'private';
    const madeForKids = (params['madeForKids'] as boolean | undefined) ?? false;

    if (!videoPath?.trim()) return { success: false, output: 'videoPath is required.' };
    if (!title?.trim()) return { success: false, output: 'title is required.' };

    if (!publishEnabled()) {
      logger.warn({ session: ctx.sessionId, title }, 'Upload refused — publishing is disabled');
      return {
        success: false,
        output:
          'YouTube publishing is disabled. Uploading is irreversible and, on a monetised channel, ' +
          'spends real money — so it is off by default. Set SUDO_YT_PUBLISH_ENABLED=1 to enable.',
        data: { wouldUpload: { title, privacyStatus, videoPath }, blockedBy: 'SUDO_YT_PUBLISH_ENABLED' },
      };
    }

    const auth = await resolveToken('social.youtube-upload');
    if ('error' in auth) return auth.error;
    const oauthToken = auth.token;

    // GAP-02: refuse before spending an hour uploading into an exhausted quota.
    const ledger = quotaLedger();
    try {
      ledger.spend('videos.insert');
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        logger.warn({ remaining: err.remaining }, 'Upload refused — daily quota exhausted');
        return { success: false, output: err.message, data: { blockedBy: 'quota' } };
      }
      throw err;
    } finally {
      ledger.close();
    }

    logger.info({ session: ctx.sessionId, videoPath, title, privacyStatus }, 'social.youtube-upload invoked');

    try {
      const stat = statSync(videoPath);
      const fileSize = stat.size;
      const mimeType = videoPath.endsWith('.webm')
        ? 'video/webm'
        : videoPath.endsWith('.mov') ? 'video/quicktime' : 'video/mp4';

      // Step 1: Initiate resumable upload session
      const metadata = {
        snippet: { title: title.slice(0, 100), description, tags, categoryId },
        status: { privacyStatus, selfDeclaredMadeForKids: madeForKids },
      };

      const initRes = await toolFetch(
        'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${oauthToken}`,
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Type': mimeType,
            'X-Upload-Content-Length': String(fileSize),
          },
          signal: ctx.signal,
          body: JSON.stringify(metadata),
        }
      );

      if (!initRes.ok) {
        const body = await initRes.text();
        throw new Error(`YouTube init error ${initRes.status}: ${body.slice(0, 300)}`);
      }

      const uploadUrl = initRes.headers.get('location');
      if (!uploadUrl) throw new Error('YouTube did not return upload session URL.');

      // Step 2: Upload file buffer
      const fileBuffer = readFileSync(videoPath);
      const uploadRes = await toolFetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': mimeType, 'Content-Length': String(fileSize) },
        signal: ctx.signal,
        body: fileBuffer,
      });

      if (!uploadRes.ok) {
        const body = await uploadRes.text();
        throw new Error(`YouTube upload error ${uploadRes.status}: ${body.slice(0, 300)}`);
      }

      const videoData = await uploadRes.json() as {
        id?: string;
        snippet?: { title?: string };
        status?: { uploadStatus?: string };
      };
      const videoId = videoData.id;
      const videoUrl = videoId ? `https://youtube.com/watch?v=${videoId}` : 'unknown';

      logger.info({ videoId, privacyStatus }, 'YouTube upload complete');
      return {
        success: true,
        output: `Video uploaded. URL: ${videoUrl} | Status: ${videoData.status?.uploadStatus ?? 'uploaded'}`,
        data: { videoId, videoUrl, title, privacyStatus, uploadStatus: videoData.status?.uploadStatus },
      };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ videoPath, err: msg }, 'social.youtube-upload failed');
      return { success: false, output: `YouTube upload failed: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// social.youtube-analytics
// ---------------------------------------------------------------------------

export const youtubeAnalyticsTool: ToolDefinition = {
  name: 'social.youtube-analytics',
  description: 'Pull YouTube channel analytics via Analytics API v2: overview, top-videos, traffic-sources, demographics, revenue. Requires YOUTUBE_OAUTH_TOKEN.',
  category: 'social',
  timeout: 30_000,
  parameters: {
    report: { type: 'string', required: true, description: 'Report type.', enum: ['overview', 'top-videos', 'traffic-sources', 'demographics', 'revenue'] },
    startDate: { type: 'string', description: 'Start date YYYY-MM-DD (default: 28 days ago).' },
    endDate: { type: 'string', description: 'End date YYYY-MM-DD (default: today).' },
    maxResults: { type: 'number', description: 'Max rows (default: 10).', default: 10 },
    channelId: { type: 'string', description: 'Channel ID (default: MINE using OAuth token).' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const report = params['report'] as string;
    const maxResults = (params['maxResults'] as number | undefined) ?? 10;

    const auth = await resolveToken('social.youtube-analytics');
    if ('error' in auth) return auth.error;
    const oauthToken = auth.token;

    const today = new Date();
    const defaultStart = new Date(today.getTime() - 28 * 86400 * 1000).toISOString().slice(0, 10);
    const startDate = (params['startDate'] as string | undefined) ?? defaultStart;
    const endDate = (params['endDate'] as string | undefined) ?? today.toISOString().slice(0, 10);
    const channelId = (params['channelId'] as string | undefined) ?? 'MINE';

    logger.info({ session: ctx.sessionId, report, startDate, endDate }, 'social.youtube-analytics invoked');

    try {
      const queryMap: Record<string, { dimensions?: string; metrics: string; sort?: string }> = {
        'overview':        { metrics: 'views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost' },
        'top-videos':      { dimensions: 'video', metrics: 'views,estimatedMinutesWatched,averageViewDuration', sort: '-views' },
        'traffic-sources': { dimensions: 'insightTrafficSourceType', metrics: 'views,estimatedMinutesWatched', sort: '-views' },
        'demographics':    { dimensions: 'ageGroup,gender', metrics: 'viewerPercentage' },
        'revenue':         { metrics: 'estimatedRevenue,estimatedAdRevenue,grossRevenue,cpm' },
      };

      const cfg = queryMap[report];
      if (!cfg) return { success: false, output: `Unknown report type: ${report}` };

      const qs = new URLSearchParams({
        ids: `channel==${channelId}`,
        startDate,
        endDate,
        metrics: cfg.metrics,
        ...(cfg.dimensions ? { dimensions: cfg.dimensions } : {}),
        ...(cfg.sort ? { sort: cfg.sort } : {}),
        maxResults: String(maxResults),
      });

      const res = await toolFetch(`https://youtubeanalytics.googleapis.com/v2/reports?${qs}`, {
        headers: { Authorization: `Bearer ${oauthToken}`, Accept: 'application/json' },
        signal: ctx.signal,
      });

      if (!res.ok) {
        const body = await res.text();
        if (res.status === 403 && body.includes('youtubeAnalytics')) {
          return missingKey('YouTube Analytics API (enable in Google Cloud Console)', 'social.youtube-analytics');
        }
        throw new Error(`YouTube Analytics API error ${res.status}: ${body.slice(0, 300)}`);
      }

      const data = await res.json() as {
        columnHeaders?: Array<{ name: string }>;
        rows?: Array<Array<string | number>>;
      };

      const colHeaders = data.columnHeaders?.map((h) => h.name) ?? [];
      const rows = data.rows ?? [];
      const structured = rows.map((row) => Object.fromEntries(colHeaders.map((h, i) => [h, row[i]])));

      const summary = rows.length > 0
        ? `${rows.length} row(s). First: ${JSON.stringify(structured[0])}`
        : 'No data for the specified period.';

      return {
        success: true,
        output: `YouTube Analytics (${report}) ${startDate} to ${endDate}: ${summary}`,
        data: { report, startDate, endDate, headers: colHeaders, rows: structured },
      };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ report, err: msg }, 'social.youtube-analytics failed');
      return { success: false, output: `YouTube Analytics error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// social.youtube-update-metadata
// ---------------------------------------------------------------------------

/**
 * GAP-05. Metadata used to be write-once — set at upload and never changeable.
 * At 50 quota units this is the cheapest experimentation actuator available:
 * title A/B needs no Studio automation and no thumbnail deploy.
 *
 * The read-modify-write lives in `core/youtube/metadata.ts` precisely so no
 * caller can construct a partial `videos.update` and blank the description.
 */
export const youtubeUpdateMetadataTool: ToolDefinition = {
  name: 'social.youtube-update-metadata',
  description:
    'Revise a published video\'s title, description or tags via YouTube Data API videos.update. ' +
    'Read-modify-write: fields you omit are PRESERVED, never blanked. Costs 51 quota units ' +
    '(1 read + 50 write). Requires SUDO_YT_PUBLISH_ENABLED=1 — it edits a live channel.',
  category: 'social',
  timeout: 60_000,
  requiresConfirmation: true,
  parameters: {
    videoId: { type: 'string', required: true, description: 'The video ID to update.' },
    title: { type: 'string', description: 'New title (max 100 chars; rejected, not truncated).' },
    description: { type: 'string', description: 'New description (max 5000 chars).' },
    tags: { type: 'array', description: 'New tags (500 chars total).', items: { type: 'string', description: 'Tag.' } },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const videoId = params['videoId'] as string | undefined;
    if (!videoId?.trim()) return { success: false, output: 'videoId is required.' };

    const patch: Record<string, unknown> = {};
    if (typeof params['title'] === 'string') patch['title'] = params['title'];
    if (typeof params['description'] === 'string') patch['description'] = params['description'];
    if (Array.isArray(params['tags'])) patch['tags'] = params['tags'];
    if (Object.keys(patch).length === 0) {
      return { success: false, output: 'Nothing to update — supply at least one of title, description or tags.' };
    }

    logger.info({ session: ctx.sessionId, videoId, fields: Object.keys(patch) }, 'social.youtube-update-metadata invoked');

    const { updateVideoMetadata } = await import('../../../youtube/metadata.js');
    const out = await updateVideoMetadata(videoId, patch, undefined);

    if (out.status === 'updated') {
      return {
        success: true,
        output: `Updated ${videoId}. Title: "${out.before.title}" -> "${out.after.title}" (${out.quotaUnits} quota units).`,
        data: { videoId, before: out.before, after: out.after, quotaUnits: out.quotaUnits },
      };
    }
    if (out.status === 'unchanged') {
      return { success: true, output: `No change for ${videoId}: ${out.reason}`, data: { videoId, unchanged: true } };
    }
    return { success: false, output: out.reason, data: { blockedBy: out.blockedBy } };
  },
};

// ---------------------------------------------------------------------------
// social.youtube-ypp-readiness
// ---------------------------------------------------------------------------

/** Analytics query helper — returns the first row's named metric, or null. */
async function analyticsMetric(
  token: string,
  metric: string,
  startDate: string,
  endDate: string,
  extra: Record<string, string> = {},
): Promise<number | null> {
  const qs = new URLSearchParams({ ids: 'channel==MINE', startDate, endDate, metrics: metric, ...extra });
  try {
    const res = await toolFetch(`https://youtubeanalytics.googleapis.com/v2/reports?${qs}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json() as { rows?: Array<Array<string | number>> };
    const v = data.rows?.[0]?.[0];
    return typeof v === 'number' ? v : null;
  } catch {
    return null;
  }
}

const dateNDaysAgo = (n: number): string =>
  new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/**
 * GAP-06. Tracks distance to YouTube Partner Program eligibility.
 *
 * Read-only: 1 quota unit for `channels.list`; the Analytics API is not charged
 * against the Data API quota. Three YPP requirements have no API at all, so they
 * are surfaced as `human-verify` and this NEVER reports eligible without an
 * explicit operator attestation — see core/youtube/ypp-readiness.ts.
 */
export const youtubeYppReadinessTool: ToolDefinition = {
  name: 'social.youtube-ypp-readiness',
  description:
    'Track progress toward YouTube Partner Program monetisation: subscribers, watch hours, ' +
    'Shorts views, plus the three requirements no API exposes (2SV, AdSense, strikes). ' +
    'Returns per-criterion status, overall verdict, projected eligibility date and next action.',
  category: 'social',
  timeout: 60_000,
  parameters: {
    twoStepVerified: { type: 'boolean', description: 'Operator attestation: 2-step verification is enabled.' },
    adsenseLinked: { type: 'boolean', description: 'Operator attestation: an AdSense account is linked.' },
    noActiveStrikes: { type: 'boolean', description: 'Operator attestation: no active Community Guidelines strikes.' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const auth = await resolveToken('social.youtube-ypp-readiness');
    if ('error' in auth) return auth.error;
    const token = auth.token;

    const ledger = quotaLedger();
    let subscribers: number | null = null;
    try {
      ledger.spend('channels.list');
      const res = await toolFetch(
        'https://www.googleapis.com/youtube/v3/channels?part=statistics&mine=true',
        { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
      );
      if (res.ok) {
        const d = await res.json() as { items?: Array<{ statistics?: { subscriberCount?: string } }> };
        const raw = d.items?.[0]?.statistics?.subscriberCount;
        if (raw !== undefined) subscribers = parseInt(raw, 10);
      }
    } catch (err) {
      if (err instanceof QuotaExceededError) return { success: false, output: err.message, data: { blockedBy: 'quota' } };
      logger.warn({ err: String(err) }, 'channels.list failed — subscribers unmeasured');
    } finally {
      ledger.close();
    }

    const today = new Date().toISOString().slice(0, 10);
    const minutes12mo = await analyticsMetric(token, 'estimatedMinutesWatched', dateNDaysAgo(365), today);
    // UNVERIFIED against a live token: the creatorContentType filter is documented
    // but unexercised here. It nulls out cleanly if unsupported, which is correct —
    // an unmeasured metric must not read as zero progress.
    const shortsViews90d = await analyticsMetric(
      token, 'views', dateNDaysAgo(90), today, { filters: 'creatorContentType==shorts' },
    );
    const subsGained30d = await analyticsMetric(token, 'subscribersGained', dateNDaysAgo(30), today);
    const minutes30d = await analyticsMetric(token, 'estimatedMinutesWatched', dateNDaysAgo(30), today);

    const { assessYppReadiness, shouldAlert } = await import('../../../youtube/ypp-readiness.js');
    const readiness = assessYppReadiness({
      subscribers,
      watchHours12mo: minutes12mo === null ? null : Math.floor(minutes12mo / 60),
      shortsViews90d,
      uploads90d: null,
      subscribersPerDay: subsGained30d === null ? null : subsGained30d / 30,
      watchHoursPerDay: minutes30d === null ? null : minutes30d / 60 / 30,
      ...(typeof params['twoStepVerified'] === 'boolean' ? { twoStepVerified: params['twoStepVerified'] } : {}),
      ...(typeof params['adsenseLinked'] === 'boolean' ? { adsenseLinked: params['adsenseLinked'] } : {}),
      ...(typeof params['noActiveStrikes'] === 'boolean' ? { noActiveStrikes: params['noActiveStrikes'] } : {}),
    });

    logger.info({ session: ctx.sessionId, verdict: readiness.verdict, progress: readiness.progress },
      'social.youtube-ypp-readiness assessed');

    const pct = (readiness.progress * 100).toFixed(0);
    return {
      success: true,
      output: `YPP ${readiness.verdict.toUpperCase()} (${pct}% of thresholds). ${readiness.action}`,
      data: { ...readiness, alert: shouldAlert(readiness) },
    };
  },
};
