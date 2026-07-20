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
  /** The source image (public URL). */
  imageUrl: string | null;
}

export interface GrokMediaDeps {
  manager: GrokWebSessionManager;
  bridge: typeof callGrokWebBridge;
  /** Milliseconds clock for filenames. */
  now: () => number;
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
 * Generate a video from a text prompt: first make an image (WS), then drive the
 * image→video app-chat lane (needs statsig). Best-effort per A-GW1 — a missing
 * statsig surfaces as a clear error, NOT a metered-API fallback.
 */
export async function generateGrokVideo(
  prompt: string,
  opts: { aspectRatio?: string; videoLength?: number; resolutionName?: string; deps?: GrokMediaDeps } = {},
): Promise<GrokVideoResult> {
  const deps = opts.deps ?? defaultDeps();
  const session = await ready(deps);
  const creds = credsOf(session);

  const quota = await quotaFor(deps, creds);
  if (quota['video'] && quota['video']!.available === false) throw new GrokWebQuotaExhaustedError('video');

  // Step 1: image (source frame).
  const aspect = opts.aspectRatio ?? '9:16';
  const img = await deps.bridge({ op: 'image', prompt, aspectRatio: aspect, numGenerations: 1 }, creds);
  const imageUrl = img.images?.[0]?.publicUrl ?? null;
  if (!img.ok || !imageUrl) {
    throw new Error(`Grok video: source image failed: ${img.errorClass ?? 'no image'}`);
  }

  // Step 2: image→video (statsig-gated).
  if (!creds.statsigId) {
    throw new Error(
      'Grok video needs a live x-statsig-id (best-effort lane). Run `sudo-ai grok websession setup` with the logged-in browser reachable to capture one.',
    );
  }
  const vidReq = {
    op: 'video' as const,
    imageUrl,
    aspectRatio: aspect,
    videoLength: opts.videoLength ?? 6,
    resolutionName: opts.resolutionName ?? '720p',
  };
  const r = await deps.bridge(vidReq, creds);
  if (!r.ok || !r.videoUrl) {
    if (r.errorClass === 'statsig') {
      throw new Error('Grok video: statsig rejected (stale) — re-run `sudo-ai grok websession setup` to re-capture.');
    }
    throw new Error(`Grok video generation failed: ${r.errorClass ?? 'no video'}${r.detail ? ` (${r.detail})` : ''}`);
  }
  const out: GrokVideoResult = { videoUrl: r.videoUrl, imageUrl };
  if (r.thumbnailUrl) out.thumbnailUrl = r.thumbnailUrl;
  log.info('grok-web video generated');
  return out;
}

export { GrokWebReloginRequiredError };
