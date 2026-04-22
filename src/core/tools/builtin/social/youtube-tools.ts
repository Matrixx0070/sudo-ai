/**
 * Social YouTube tools: social.youtube-upload, social.youtube-analytics.
 */

import { readFileSync, statSync } from 'node:fs';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { missingKey } from './helpers.js';

const logger = createLogger('social-youtube');

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

    const oauthToken = process.env['YOUTUBE_OAUTH_TOKEN'];
    if (!oauthToken) return missingKey('YOUTUBE_OAUTH_TOKEN', 'social.youtube-upload');

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

      const initRes = await fetch(
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
      const uploadRes = await fetch(uploadUrl, {
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

    const oauthToken = process.env['YOUTUBE_OAUTH_TOKEN'];
    if (!oauthToken) return missingKey('YOUTUBE_OAUTH_TOKEN', 'social.youtube-analytics');

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

      const res = await fetch(`https://youtubeanalytics.googleapis.com/v2/reports?${qs}`, {
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
