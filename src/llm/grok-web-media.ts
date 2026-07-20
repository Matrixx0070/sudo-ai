/**
 * @file grok-web-media.ts
 * @description GW5 — subscription-free image/video generation on the user's Grok
 * web session, exposed as a capability distinct from the metered xAI API path.
 *
 * Ties GW3 (session manager) + GW2 (replay bridge) + GW4 (headless refresh)
 * together behind the `SUDO_GROK_WEBSESSION` flag (default OFF). IMAGE is the
 * robust primary (WS lane, no statsig); VIDEO is best-effort (needs a live
 * statsig — see A-GW1). Respects the 18h quota window: reads quota_info and, on
 * exhaustion, INFORMS the caller — it NEVER silently falls back to the metered
 * API (that would spend money; only an explicit opt-in may do so, elsewhere).
 *
 * Secrets never logged. Everything returned to a caller is a URL / local path /
 * counts — never cookie or statsig material.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../core/shared/paths.js';
import { createLogger } from '../core/shared/logger.js';
import {
  getGrokWebSessionManager,
  GrokWebReloginRequiredError,
  type GrokWebSessionManager,
} from './grok-web-session-manager.js';
import { wireGrokWebRefresher } from './grok-web-capture.js';
import { callGrokWebBridge, type GrokWebCreds } from './grok-web-bridge.js';

const log = createLogger('llm:grok-web-media');

/** Where generated media lands by default. */
const MEDIA_DIR = path.join(DATA_DIR, 'grok-web-media');

/** True when the subscription-free web-session lane is enabled. Default OFF. */
export function isGrokWebSessionEnabled(): boolean {
  return process.env['SUDO_GROK_WEBSESSION'] === '1';
}

/** Raised when the feature flag is off — callers surface a clear hint. */
export class GrokWebDisabledError extends Error {
  readonly code = 'GROK_WEBSESSION_DISABLED';
  constructor() {
    super('Grok web-session media is disabled — set SUDO_GROK_WEBSESSION=1 to enable (default OFF).');
    this.name = 'GrokWebDisabledError';
  }
}

/** Raised when the 18h free quota window is exhausted for the requested tier. */
export class GrokWebQuotaExhaustedError extends Error {
  readonly code = 'GROK_WEBSESSION_QUOTA_EXHAUSTED';
  constructor(tier: string) {
    super(
      `Grok subscription ${tier} quota is exhausted for the current 18h window. ` +
        `Try again later. (Not falling back to the metered xAI API — that would spend money.)`,
    );
    this.name = 'GrokWebQuotaExhaustedError';
  }
}

export interface GrokImageResult {
  /** Public URL of the first image (imagine-public.x.ai). */
  url: string | null;
  /** Local paths of saved JPEGs. */
  files: string[];
  jobIds: Array<string | null>;
}

export interface GrokVideoResult {
  /** assets.grok.com mp4 URL. */
  videoUrl: string;
  thumbnailUrl?: string;
  /** The source image (public URL) for image-to-video; null for text-to-video. */
  imageUrl: string | null;
  /** Local path of the downloaded mp4 (undefined if the download step failed). */
  file?: string;
  videoId?: string;
}

export interface GrokMediaDeps {
  manager: GrokWebSessionManager;
  bridge: typeof callGrokWebBridge;
  /** Milliseconds clock for filenames. */
  now: () => number;
  /**
   * GWV2 — mint a FRESH x-statsig-id for the video app-chat request. Defaults to
   * the on-demand headless oracle (grok-statsig-oracle.ts), lazy-loaded so
   * image-only callers never pull in Playwright. Injected in tests.
   */
  mintStatsig?: (reqPath: string, method: string) => Promise<string>;
}

function defaultDeps(): GrokMediaDeps {
  const manager = getGrokWebSessionManager();
  // Wire the real headless refresher once (idempotent enough — setter).
  wireGrokWebRefresher(manager);
  return { manager, bridge: callGrokWebBridge, now: () => Date.now() };
}

function credsOf(session: { cookie: string; userAgent: string; statsigId?: string }): GrokWebCreds {
  const c: GrokWebCreds = { cookie: session.cookie, userAgent: session.userAgent };
  if (session.statsigId) c.statsigId = session.statsigId;
  return c;
}

/** Ensure the feature is on + the session is healthy (refreshing if needed). */
async function ready(deps: GrokMediaDeps) {
  if (!isGrokWebSessionEnabled()) throw new GrokWebDisabledError();
  const session = await deps.manager.ensureHealthy(); // throws GrokWebReloginRequiredError on dead sso
  return session;
}

/** Read the current quota tiers (probe). Throws if not healthy. */
async function quotaFor(deps: GrokMediaDeps, creds: GrokWebCreds): Promise<Record<string, { available: boolean }>> {
  const r = await deps.bridge({ op: 'probe' }, creds);
  return r.quota ?? {};
}

/**
 * Generate image(s) from a text prompt on the Grok subscription (WS lane).
 * Saves JPEGs under DATA_DIR/grok-web-media and returns their paths + the
 * imagine-public URL of the first.
 */
export async function generateGrokImage(
  prompt: string,
  opts: { aspectRatio?: string; numGenerations?: number; pro?: boolean; deps?: GrokMediaDeps } = {},
): Promise<GrokImageResult> {
  const deps = opts.deps ?? defaultDeps();
  const session = await ready(deps);
  const creds = credsOf(session);

  const quota = await quotaFor(deps, creds);
  const tier = opts.pro ? 'imagePro' : 'image';
  if (quota[tier] && quota[tier]!.available === false) throw new GrokWebQuotaExhaustedError(tier);

  const imgReq = {
    op: 'image' as const,
    prompt,
    aspectRatio: opts.aspectRatio ?? '1:1',
    numGenerations: opts.numGenerations ?? 1,
    pro: opts.pro ?? false,
  };
  const r = await deps.bridge(imgReq, creds);
  if (!r.ok || !r.images?.length) {
    throw new Error(`Grok image generation failed: ${r.errorClass ?? 'no images'}${r.detail ? ` (${r.detail})` : ''}`);
  }

  await mkdir(MEDIA_DIR, { recursive: true });
  const files: string[] = [];
  const jobIds: Array<string | null> = [];
  for (const [i, img] of r.images.entries()) {
    const name = `grok-${img.jobId ?? `${deps.now()}-${i}`}.jpg`;
    const p = path.join(MEDIA_DIR, name);
    await writeFile(p, Buffer.from(img.b64, 'base64'), { mode: 0o644 });
    files.push(p);
    jobIds.push(img.jobId);
  }
  const url = r.images[0]?.publicUrl ?? null;
  log.info({ count: files.length, hasUrl: Boolean(url) }, 'grok-web image generated');
  return { url, files, jobIds };
}

/**
 * Mint a fresh x-statsig-id via the on-demand headless oracle (GWV1). Lazy import
 * keeps Playwright out of the image-only path. Bound to the session's durable
 * grok profile.
 */
function makeOracleMint(profileDir?: string): (reqPath: string, method: string) => Promise<string> {
  return async (reqPath: string, method: string): Promise<string> => {
    const { getGrokStatsigOracle } = await import('./grok-statsig-oracle.js');
    const oracle = getGrokStatsigOracle(profileDir ? { profileDir } : {});
    return oracle.mint(reqPath, method);
  };
}

/** True when quota_info reports the video tier is out for the current window. */
function videoQuotaExhausted(quota: Record<string, unknown>): boolean {
  const q = (quota['video720p'] ?? quota['video']) as Record<string, unknown> | undefined;
  if (!q) return false;
  if (q['available'] === false) return true;
  const remaining = q['remainingQueries'];
  return typeof remaining === 'number' && remaining <= 0;
}

/**
 * Generate a video FREE on the Grok subscription via the statsig-oracle lane
 * (GWV2). Text-to-video by default (PROVEN); image-to-video when `imageUrl` is
 * given. Mints a FRESH x-statsig-id per request (never replays), curl_cffi-POSTs
 * the app-chat stream, downloads the resulting assets.grok.com mp4, and returns
 * URLs + the local path. On a 403 anti-bot rejection it re-mints ONCE and
 * retries; it NEVER falls back to the metered api.x.ai (that would spend money).
 * Returns only structured data (URLs / ids / path) — never free-form model text.
 */
export async function generateGrokVideo(
  prompt: string,
  opts: {
    imageUrl?: string;
    aspectRatio?: string;
    videoLength?: number;
    resolutionName?: string;
    deps?: GrokMediaDeps;
  } = {},
): Promise<GrokVideoResult> {
  const deps = opts.deps ?? defaultDeps();
  const session = await ready(deps);
  const creds = credsOf(session);

  const quota = await quotaFor(deps, creds);
  if (videoQuotaExhausted(quota as Record<string, unknown>)) throw new GrokWebQuotaExhaustedError('video');

  const mint = deps.mintStatsig ?? makeOracleMint(session.profileDir);
  const aspect = opts.aspectRatio ?? '9:16';

  const attempt = async (): Promise<import('./grok-web-bridge.js').GrokWebResponse> => {
    // Mint fresh + use in <1s; never store/replay the token.
    const statsigId = await mint('/rest/app-chat/conversations/new', 'POST');
    const vidReq = {
      op: 'video' as const,
      aspectRatio: aspect,
      videoLength: opts.videoLength ?? 6,
      resolutionName: opts.resolutionName ?? '720p',
      ...(opts.imageUrl ? { imageUrl: opts.imageUrl } : { prompt }),
    };
    // The freshly-minted token wins over any session-stored statsig.
    return deps.bridge(vidReq, { ...creds, statsigId });
  };

  let r = await attempt();
  if (!r.ok && (r.errorClass === 'statsig' || r.status === 403)) {
    // Anti-bot 403 / stale statsig → re-mint once and retry.
    log.info('grok-web video: 403/statsig — re-minting once');
    r = await attempt();
  }
  if (!r.ok || !r.videoUrl) {
    if (r.errorClass === 'statsig' || r.status === 403) {
      throw new Error(
        'Grok video: request rejected by anti-bot rules even after a fresh mint. ' +
          'Not falling back to the metered xAI API (that would spend money) — try again shortly.',
      );
    }
    throw new Error(`Grok video generation failed: ${r.errorClass ?? 'no video'}${r.detail ? ` (${r.detail})` : ''}`);
  }

  const out: GrokVideoResult = { videoUrl: r.videoUrl, imageUrl: opts.imageUrl ?? null };
  if (r.thumbnailUrl) out.thumbnailUrl = r.thumbnailUrl;
  if (r.videoId) out.videoId = r.videoId;

  // Download the mp4 with the session cookies (same host), best-effort.
  await mkdir(MEDIA_DIR, { recursive: true });
  const file = path.join(MEDIA_DIR, `grok-video-${r.videoId ?? deps.now()}.mp4`);
  const dl = await deps.bridge({ op: 'download', url: r.videoUrl, outputPath: file }, creds);
  if (dl.ok && dl.path) {
    out.file = dl.path;
    log.info({ bytes: dl.bytes ?? 0, ftyp: dl.ftyp === true }, 'grok-web video downloaded');
  } else {
    log.warn({ errorClass: dl.errorClass }, 'grok-web video downloaded URL but local save failed');
  }
  log.info('grok-web video generated (oracle lane)');
  return out;
}

export { GrokWebReloginRequiredError };
