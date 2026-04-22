/**
 * Mastodon adapter for SUDO-AI social tools.
 * Posts statuses to a Mastodon instance via API v1.
 *
 * Env vars required:
 *   MASTODON_INSTANCE       - e.g. "mastodon.social" or "https://mastodon.social"
 *   MASTODON_ACCESS_TOKEN   - Bearer token from Mastodon app settings
 */

import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('social:mastodon');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MastodonPostOptions {
  /** Post text content — must be <=500 chars; throws MastodonError(422) if exceeded. */
  status: string;
  /** Mastodon attachment IDs (returned by /api/v1/media). Optional. */
  mediaIds?: string[];
  /** Visibility scope. Defaults to 'public'. */
  visibility?: 'public' | 'unlisted' | 'private' | 'direct';
  /** ID of status to reply to. Optional. */
  inReplyToId?: string;
  /** AbortSignal to cancel in-flight requests. Optional. */
  signal?: AbortSignal;
}

export interface MastodonPostResult {
  id: string;
  url: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Error thrown by the Mastodon adapter.
 * Extends Error (not SudoError) to match the architect-approved interface spec.
 */
export class MastodonError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'MastodonError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalize MASTODON_INSTANCE to a bare host[:port] (no scheme, no trailing slash).
 * Accepts "mastodon.social", "https://mastodon.social", "https://mastodon.social/",
 * "mastodon.social:8443", "//evil.com" (rejected).
 * Throws MastodonError(0) on invalid input.
 */
function normalizeInstance(raw: string): string {
  // Reject non-http(s) schemes explicitly before any stripping (ftp://, file://, ws://, etc.)
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//i.test(raw) && !/^https?:\/\//i.test(raw)) {
    throw new MastodonError('MASTODON_INSTANCE: non-http(s) scheme not allowed', 0);
  }
  // Reject protocol-relative URLs like "//evil.com" before any stripping
  if (/^\/\//.test(raw)) {
    throw new MastodonError('Invalid MASTODON_INSTANCE config: protocol-relative URL not allowed', 0);
  }
  const stripped = raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!stripped) {
    throw new MastodonError('Invalid MASTODON_INSTANCE config: empty after normalization', 0);
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL('https://' + stripped);
  } catch {
    throw new MastodonError(
      `Invalid MASTODON_INSTANCE config: cannot parse as URL: ${stripped}`,
      0,
    );
  }
  if (!parsedUrl.hostname) {
    throw new MastodonError(
      `Invalid MASTODON_INSTANCE config: empty hostname: ${stripped}`,
      0,
    );
  }
  // Return host (preserves explicit non-443 ports like "mastodon.social:8443")
  return parsedUrl.host;
}

/**
 * Parse X-RateLimit-Reset header (Unix epoch seconds) into wait milliseconds.
 * Returns 0 if the header is missing or unparseable.
 * Caps at MAX_RETRY_WAIT_MS.
 */
const MAX_RETRY_WAIT_MS = 300_000;

function parseRateLimitWaitMs(headers: Headers): number {
  const resetHeader = headers.get('X-RateLimit-Reset');
  if (!resetHeader) return 0;
  const resetEpochSec = Number(resetHeader);
  if (!Number.isFinite(resetEpochSec)) return 0;
  const waitMs = resetEpochSec * 1000 - Date.now();
  if (waitMs <= 0) return 0;
  return Math.min(waitMs, MAX_RETRY_WAIT_MS);
}

/**
 * Mastodon API status response shape (partial — only fields we use).
 */
interface MastodonStatusResponse {
  id: string;
  url: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Post a status to Mastodon.
 *
 * Pre-flight validation: throws MastodonError(422) if status exceeds 500 chars.
 * Rate-limit handling: on HTTP 429, waits up to MAX_RETRY_WAIT_MS then retries ONCE.
 * A second 429 throws MastodonError(429) immediately.
 *
 * @throws {MastodonError} on any error condition (missing env, validation, HTTP errors).
 */
export async function postToMastodon(opts: MastodonPostOptions): Promise<MastodonPostResult> {
  // --- Validate inputs -------------------------------------------------------
  if (opts.status.length > 500) {
    throw new MastodonError(
      `Status text exceeds 500 characters (got ${opts.status.length})`,
      422,
    );
  }

  // --- Env vars ---------------------------------------------------------------
  const instanceRaw = process.env['MASTODON_INSTANCE'];
  const accessToken = process.env['MASTODON_ACCESS_TOKEN'];

  if (!instanceRaw?.trim()) {
    throw new MastodonError('MASTODON_INSTANCE environment variable is not set', 0);
  }
  if (!accessToken?.trim()) {
    throw new MastodonError('MASTODON_ACCESS_TOKEN environment variable is not set', 0);
  }

  const instance = normalizeInstance(instanceRaw.trim());
  const endpoint = `https://${instance}/api/v1/statuses`;

  // --- Build request body -----------------------------------------------------
  const body: Record<string, unknown> = {
    status: opts.status,
    visibility: opts.visibility ?? 'public',
  };
  if (opts.mediaIds && opts.mediaIds.length > 0) {
    body['media_ids'] = opts.mediaIds;
  }
  if (opts.inReplyToId) {
    body['in_reply_to_id'] = opts.inReplyToId;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  logger.info({ instance, visibility: body['visibility'] }, 'Posting status to Mastodon');

  // --- First attempt ----------------------------------------------------------
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (response.status === 429) {
    const waitMs = parseRateLimitWaitMs(response.headers);
    logger.warn({ waitMs, instance }, 'Mastodon 429 rate limit — retrying after wait');

    // Guard: if the reset wait exceeds the caller signal budget (~25s), skip retry
    // and let the dispatcher re-queue rather than aborting mid-sleep.
    if (waitMs > 25_000) {
      logger.warn({ waitMs, instance }, 'Mastodon rate limit reset exceeds retry budget — aborting retry');
      throw new MastodonError('rate limit reset exceeds retry budget', 429, waitMs);
    }

    if (waitMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    }

    // --- Single retry ----------------------------------------------------------
    const retryResponse = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: opts.signal,
    });

    if (retryResponse.status === 429) {
      const retryWaitMs = parseRateLimitWaitMs(retryResponse.headers);
      logger.error({ instance }, 'Mastodon 429 on retry — giving up');
      throw new MastodonError(
        `Mastodon rate limit exceeded after retry`,
        429,
        retryWaitMs > 0 ? retryWaitMs : undefined,
      );
    }

    return handleMastodonResponse(retryResponse, instance);
  }

  return handleMastodonResponse(response, instance);
}

// ---------------------------------------------------------------------------
// Response handler
// ---------------------------------------------------------------------------

async function handleMastodonResponse(
  response: Response,
  instance: string,
): Promise<MastodonPostResult> {
  if (!response.ok) {
    let errorText = `HTTP ${response.status}`;
    try {
      const errBody = await response.text();
      if (errBody) errorText = `HTTP ${response.status}: ${errBody.slice(0, 200)}`;
    } catch {
      // ignore body parse failures
    }
    logger.error({ statusCode: response.status, instance }, 'Mastodon API error');
    throw new MastodonError(errorText, response.status);
  }

  const rawBody = await response.text();
  let data: MastodonStatusResponse;
  try {
    data = JSON.parse(rawBody) as MastodonStatusResponse;
  } catch {
    throw new MastodonError(
      `Mastodon API returned non-JSON response: ${rawBody.slice(0, 500)}`,
      response.status,
    );
  }

  if (!data.id || !data.url || !data.created_at) {
    throw new MastodonError(
      'Mastodon API returned unexpected response shape',
      502,
    );
  }

  logger.info({ id: data.id, instance }, 'Mastodon status posted successfully');

  return {
    id: data.id,
    url: data.url,
    createdAt: data.created_at,
  };
}
