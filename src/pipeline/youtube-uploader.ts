/**
 * @file youtube-uploader.ts
 * Uploads videos to YouTube via the Data API v3 (resumable uploads).
 * Handles OAuth2 token refresh, quota tracking, thumbnail upload, and retries.
 * Uses only Node.js built-ins + fetch() — no googleapis package required.
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from '../core/shared/logger.js';
import { PipelineError } from '../core/shared/errors.js';
import { PATHS } from '../core/shared/constants.js';
import { retry } from '../core/shared/utils.js';
import type { SeoMetadata, UploadResult } from './types.js';

const log = createLogger('pipeline:youtube-uploader');

const QUOTA_FILE = path.join(PATHS.DATA, 'pipeline', 'quota.json');
const DAILY_QUOTA_LIMIT = 10_000;
const UPLOAD_QUOTA_UNITS = 1_600;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD_API = 'https://www.googleapis.com/upload/youtube/v3/videos';
const THUMBNAIL_API = 'https://www.googleapis.com/youtube/v3/thumbnails/set';

interface QuotaRecord { date: string; used: number; }
interface TokenResponse { access_token: string; expires_in: number; token_type: string; }

function todayUTC(): string {
  return new Date().toISOString().split('T')[0] as string;
}

function readQuota(): QuotaRecord {
  try {
    const rec = JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf8')) as QuotaRecord;
    return rec.date !== todayUTC() ? { date: todayUTC(), used: 0 } : rec;
  } catch {
    return { date: todayUTC(), used: 0 };
  }
}

function writeQuota(rec: QuotaRecord): void {
  try {
    fs.mkdirSync(path.dirname(QUOTA_FILE), { recursive: true });
    fs.writeFileSync(QUOTA_FILE, JSON.stringify(rec, null, 2), 'utf8');
  } catch (err) {
    log.error({ err }, 'Failed to write quota file');
  }
}

let cachedToken: { value: string; expiresAt: number } | null = null;

/** Refresh and cache the YouTube OAuth2 access token. */
async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) return cachedToken.value;

  const clientId = process.env['YOUTUBE_CLIENT_ID'];
  const clientSecret = process.env['YOUTUBE_CLIENT_SECRET'];
  const refreshToken = process.env['YOUTUBE_REFRESH_TOKEN'];

  if (!clientId || !clientSecret || !refreshToken) {
    throw new PipelineError(
      'Missing YouTube OAuth2 env vars (YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET / YOUTUBE_REFRESH_TOKEN)',
      'pipeline_upload_api_error',
    );
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new PipelineError(
      `OAuth2 token refresh failed (HTTP ${res.status}): ${text.slice(0, 200)}`,
      'pipeline_upload_api_error',
      { status: res.status },
    );
  }

  const data = (await res.json()) as TokenResponse;
  cachedToken = { value: data.access_token, expiresAt: now + data.expires_in * 1_000 };
  log.debug('OAuth2 access token refreshed');
  return data.access_token;
}

/** Initiate a resumable upload session; returns the upload URI. */
async function initiateResumableUpload(
  token: string,
  seo: SeoMetadata,
  scheduleAt: string | undefined,
  contentLength: number,
): Promise<string> {
  const body = JSON.stringify({
    snippet: {
      title: seo.title,
      description: seo.description,
      tags: seo.tags,
      categoryId: seo.categoryId,
      defaultLanguage: 'hi',
    },
    status: {
      privacyStatus: scheduleAt ? 'private' : 'public',
      ...(scheduleAt ? { publishAt: scheduleAt } : {}),
      selfDeclaredMadeForKids: false,
    },
  });

  const res = await fetch(`${UPLOAD_API}?uploadType=resumable&part=snippet,status`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Upload-Content-Type': 'video/*',
      'X-Upload-Content-Length': String(contentLength),
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 403) {
      throw new PipelineError(
        `YouTube quota exceeded/forbidden (HTTP 403): ${text.slice(0, 200)}`,
        'pipeline_upload_quota_exceeded',
        { status: 403 },
      );
    }
    throw new PipelineError(
      `Resumable upload init failed (HTTP ${res.status}): ${text.slice(0, 200)}`,
      'pipeline_upload_api_error',
      { status: res.status },
    );
  }

  const location = res.headers.get('Location');
  if (!location) {
    throw new PipelineError('YouTube API returned no upload URI', 'pipeline_upload_api_error');
  }
  return location;
}

/** PUT the video buffer to the resumable upload URI; returns the YouTube video ID. */
async function uploadVideoFile(uploadUri: string, videoPath: string): Promise<string> {
  const fileBuffer = fs.readFileSync(videoPath);
  const res = await fetch(uploadUri, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/*', 'Content-Length': String(fileBuffer.byteLength) },
    body: fileBuffer,
  });

  if (!res.ok) {
    const text = await res.text();
    const code = res.status === 403 ? 'pipeline_upload_quota_exceeded' : 'pipeline_upload_api_error';
    throw new PipelineError(
      `Video upload failed (HTTP ${res.status}): ${text.slice(0, 200)}`,
      code,
      { status: res.status },
    );
  }

  const data = (await res.json()) as { id?: string };
  if (!data.id) {
    throw new PipelineError('YouTube API returned no video ID', 'pipeline_upload_api_error');
  }
  return data.id;
}

/** Set thumbnail for a video. Non-fatal — logs on failure but never throws. */
async function setThumbnail(token: string, videoId: string, thumbPath: string): Promise<void> {
  try {
    const imgBuffer = fs.readFileSync(thumbPath);
    const ext = path.extname(thumbPath).toLowerCase().replace('.', '');
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';

    const res = await fetch(`${THUMBNAIL_API}?videoId=${videoId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': mime,
        'Content-Length': String(imgBuffer.byteLength),
      },
      body: imgBuffer,
    });

    if (!res.ok) {
      log.warn({ videoId, status: res.status }, 'Thumbnail upload failed — non-fatal');
    } else {
      log.info({ videoId }, 'Thumbnail set');
    }
  } catch (err) {
    log.warn({ videoId, err }, 'Thumbnail upload error — skipped');
  }
}

/**
 * Check whether the daily YouTube quota allows at least one more upload.
 * Reads data/pipeline/quota.json; returns true when quota remains.
 */
export async function checkQuotaAvailable(): Promise<boolean> {
  const record = readQuota();
  const remaining = DAILY_QUOTA_LIMIT - record.used;
  const available = remaining >= UPLOAD_QUOTA_UNITS;
  log.info(
    { date: record.date, used: record.used, remaining },
    `Quota: ${available ? 'available' : 'EXHAUSTED'}`,
  );
  return available;
}

/**
 * Upload a video to YouTube with metadata, optional scheduling, and thumbnail.
 * Retries up to 3 times on transient errors; hard-fails immediately on HTTP 403.
 *
 * @param videoPath     - Absolute path to the video file.
 * @param thumbnailPath - Absolute path to the thumbnail image.
 * @param seo           - Title, description, tags, categoryId.
 * @param scheduleAt    - Optional ISO datetime for scheduled publishing.
 * @returns UploadResult containing videoId, URL, status, and quota used.
 */
export async function uploadToYouTube(
  videoPath: string,
  thumbnailPath: string,
  seo: SeoMetadata,
  scheduleAt?: string,
): Promise<UploadResult> {
  if (!videoPath || !fs.existsSync(videoPath)) {
    throw new PipelineError(`Video file not found: ${videoPath}`, 'pipeline_upload_api_error');
  }
  if (!seo.title || !seo.description) {
    throw new PipelineError(
      'SEO metadata missing required title or description',
      'pipeline_upload_api_error',
    );
  }

  if (!(await checkQuotaAvailable())) {
    throw new PipelineError('YouTube daily quota exhausted', 'pipeline_upload_quota_exceeded');
  }

  const contentLength = fs.statSync(videoPath).size;
  log.info({ videoPath, title: seo.title, scheduleAt }, 'Starting YouTube upload');

  let videoId: string;
  try {
    videoId = await retry(
      async () => {
        const token = await getAccessToken();
        const uri = await initiateResumableUpload(token, seo, scheduleAt, contentLength);
        return uploadVideoFile(uri, videoPath);
      },
      3,
      [5_000, 15_000, 30_000],
    );
  } catch (err) {
    if (err instanceof PipelineError && err.code === 'pipeline_upload_quota_exceeded') throw err;
    throw new PipelineError(
      `YouTube upload failed after retries: ${String(err)}`,
      'pipeline_upload_api_error',
      { cause: String(err) },
    );
  }

  if (thumbnailPath && fs.existsSync(thumbnailPath)) {
    await setThumbnail(await getAccessToken(), videoId, thumbnailPath);
  } else {
    log.warn({ thumbnailPath }, 'Thumbnail not found — skipped');
  }

  const record = readQuota();
  record.used += UPLOAD_QUOTA_UNITS;
  writeQuota(record);

  const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const status: UploadResult['status'] = scheduleAt ? 'scheduled' : 'uploaded';

  log.info({ videoId, youtubeUrl, status, quotaUsed: UPLOAD_QUOTA_UNITS }, 'Upload complete');
  return { youtubeVideoId: videoId, youtubeUrl, scheduledPublishAt: scheduleAt, status, quotaUsed: UPLOAD_QUOTA_UNITS };
}
