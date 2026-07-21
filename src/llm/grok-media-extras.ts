/**
 * @file grok-media-extras.ts
 * @description FREE video caption + upscale on the $30 grok.com subscription
 * seat — siblings of the already-wired image/video generation lane, riding the
 * same cookie-authenticated `/rest/media/*` surface (both ops cookie-only,
 * statsig-FREE — PROVEN LIVE 2026-07-21):
 *
 *   upscale  -> POST /rest/media/video/upscale  {videoId, targetResolution}
 *               -> {hdMediaUrl}   (DIRECT url, synchronous; no poll)
 *   caption  -> POST /rest/media/video/caption  {videoId, preset?, style?, ...}
 *               -> {result:{postId, status, progressPct, message, errorMessage}}
 *                  (a JOB; REQUIRES the seat to OWN the video)
 *
 * NOT WIRED — `/rest/app-chat/image-generations`: probed to be a GET that LISTS
 * prior image generations (history), not a generator. It is redundant with the
 * already-wired imagine image lane, so it is intentionally absent here.
 *
 * Reuses GW3 (session manager) behind the shared `SUDO_GROK_WEBSESSION` flag
 * (default OFF). No new flag; no statsig mint needed for these ops (unlike the
 * video-GENERATE lane). Secrets ride stdin into the python bridge only and are
 * never logged. The lane is seat-covered — it never touches the metered
 * api.x.ai (money safety); on any failure it throws, never silently spends.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { PROJECT_ROOT } from '../core/shared/paths.js';
import { createLogger } from '../core/shared/logger.js';
import {
  getGrokWebSessionManager,
  GrokWebReloginRequiredError,
  type GrokWebSessionManager,
} from './grok-web-session-manager.js';
import type { GrokWebCreds } from './grok-web-bridge.js';
import { isGrokWebSessionEnabled, GrokWebDisabledError } from './grok-web-media.js';

const log = createLogger('llm:grok-media-extras');

const SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'grok-web', 'grok_media_extras.py');
const PYTHON_BIN = process.env['SUDO_GROK_WEB_PYTHON'] ?? 'python3';
const HARD_TIMEOUT_MS = 180_000;
/** videoId is a UUID; validate before it ever reaches a URL path / request body. */
const VIDEO_ID_RE = /^[0-9a-fA-F-]{32,40}$/;

/** Wire values accepted by the upscale endpoint (verified from the client). */
export type GrokUpscaleTarget = 'UPSCALE_TARGET_RESOLUTION_HD' | 'UPSCALE_TARGET_RESOLUTION_1080P';

/** The caption job result (verified shape from the client mapper). */
export interface GrokCaptionResult {
  postId?: string;
  status?: string;
  progressPct?: number;
  message?: string;
  errorMessage?: string;
}

/** Bridge request (secrets merged in separately, never logged). */
export interface GrokMediaExtrasBridgeRequest {
  op: 'upscale' | 'caption' | 'download';
  videoId?: string;
  targetResolution?: GrokUpscaleTarget;
  preset?: string;
  style?: string;
  canvasId?: string;
  containerId?: string;
  url?: string;
  outputPath?: string;
  /** Confinement base dir for op=download; the python side rejects escapes. */
  outputDir?: string;
  timeoutSec?: number;
}

export interface GrokMediaExtrasBridgeResponse {
  ok: boolean;
  status?: number;
  errorClass?: string;
  detail?: string;
  hdMediaUrl?: string;
  caption?: GrokCaptionResult;
  path?: string;
  bytes?: number;
  ftyp?: boolean;
}

export class GrokMediaExtrasError extends Error {
  readonly errorClass: string;
  readonly status?: number;
  constructor(errorClass: string, message: string, status?: number) {
    super(message);
    this.name = 'GrokMediaExtrasError';
    this.errorClass = errorClass;
    if (status !== undefined) this.status = status;
  }
}

export interface GrokMediaExtrasDeps {
  manager: GrokWebSessionManager;
  /** Spawns grok_media_extras.py; injectable so tests need no network. */
  bridge: (
    req: GrokMediaExtrasBridgeRequest,
    creds: GrokWebCreds,
  ) => Promise<GrokMediaExtrasBridgeResponse>;
}

// ---------------------------------------------------------------------------
// Default seams (clone of the grok-files bridge spawn)
// ---------------------------------------------------------------------------

function defaultBridge(
  req: GrokMediaExtrasBridgeRequest,
  creds: GrokWebCreds,
): Promise<GrokMediaExtrasBridgeResponse> {
  const timeoutMs = Math.min(
    typeof req.timeoutSec === 'number' ? req.timeoutSec * 1000 + 15_000 : HARD_TIMEOUT_MS,
    HARD_TIMEOUT_MS,
  );
  return new Promise<GrokMediaExtrasBridgeResponse>((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const child = spawn(PYTHON_BIN, [SCRIPT_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    const settle = (r: GrokMediaExtrasBridgeResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve(r);
    };
    const timer = setTimeout(() => {
      settle({ ok: false, errorClass: 'timeout', detail: `bridge timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err: Error) => {
      settle({ ok: false, errorClass: 'bridge_error', detail: `spawn failed: ${err.message}` });
    });
    child.on('close', (code: number | null) => {
      const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
      try {
        settle(JSON.parse(line) as GrokMediaExtrasBridgeResponse);
      } catch {
        settle({
          ok: false,
          errorClass: 'bridge_error',
          detail: `no JSON from bridge (exit ${code}); stderr: ${stderr.slice(0, 200)}`,
        });
      }
    });
    // Secrets go in ONLY here, on stdin. Never logged.
    try {
      child.stdin?.write(JSON.stringify({ ...req, ...creds }));
      child.stdin?.end();
    } catch (err) {
      settle({ ok: false, errorClass: 'bridge_error', detail: `stdin write failed: ${String(err)}` });
    }
  });
}

function defaultDeps(): GrokMediaExtrasDeps {
  return { manager: getGrokWebSessionManager(), bridge: defaultBridge };
}

/** Ensure the feature is on + the session is healthy (refreshing if needed). */
async function ready(deps: GrokMediaExtrasDeps): Promise<GrokWebCreds> {
  if (!isGrokWebSessionEnabled()) throw new GrokWebDisabledError();
  const session = await deps.manager.ensureHealthy(); // throws GrokWebReloginRequiredError on dead sso
  return { cookie: session.cookie, userAgent: session.userAgent };
}

async function call(
  deps: GrokMediaExtrasDeps,
  req: GrokMediaExtrasBridgeRequest,
): Promise<GrokMediaExtrasBridgeResponse> {
  const creds = await ready(deps);
  const r = await deps.bridge(req, creds);
  if (!r.ok) {
    throw new GrokMediaExtrasError(
      r.errorClass ?? 'unknown',
      `grok-media-extras ${req.op} failed: ${r.errorClass ?? 'unknown'}${r.detail ? ` (${r.detail})` : ''}`,
      r.status,
    );
  }
  return r;
}

function assertVideoId(videoId: string, fn: string): string {
  const id = (videoId ?? '').trim();
  if (!id || !VIDEO_ID_RE.test(id)) {
    throw new TypeError(`${fn}: videoId must be a UUID-shaped string`);
  }
  return id;
}

/** Resolve a caller-supplied output path, rejecting empty / traversal inputs. */
function resolveOutputPath(outputPath: string, fn: string): string {
  const p = (outputPath ?? '').trim();
  if (!p) throw new TypeError(`${fn}: outputPath must be a non-empty string`);
  const resolved = path.resolve(p);
  // A resolved absolute path has no '..' segments left; guard the raw input too.
  if (p.split(/[\\/]/).includes('..')) {
    throw new TypeError(`${fn}: outputPath must not contain '..' segments`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Capability functions
// ---------------------------------------------------------------------------

/**
 * Upscale a video to HD/1080p on the subscription seat (FREE, statsig-free).
 * Returns the direct `hdMediaUrl`. If `outputPath` is given, the upscaled mp4 is
 * downloaded to that path (confined to its directory — no traversal). Throws
 * `TypeError` on bad input and `GrokMediaExtrasError` on any lane failure —
 * never falls back to a paid API.
 */
export async function upscaleGrokVideo(
  videoId: string,
  opts: {
    targetResolution?: GrokUpscaleTarget;
    outputPath?: string;
    deps?: GrokMediaExtrasDeps;
  } = {},
): Promise<{ hdMediaUrl: string; file?: string; bytes?: number }> {
  const id = assertVideoId(videoId, 'upscaleGrokVideo');
  const deps = opts.deps ?? defaultDeps();
  const r = await call(deps, {
    op: 'upscale',
    videoId: id,
    targetResolution: opts.targetResolution ?? 'UPSCALE_TARGET_RESOLUTION_HD',
  });
  if (!r.hdMediaUrl) {
    throw new GrokMediaExtrasError('bad_response', 'grok-media-extras upscale: no hdMediaUrl');
  }
  log.info({ target: opts.targetResolution ?? 'HD' }, 'grok-media-extras upscaled');
  if (!opts.outputPath) return { hdMediaUrl: r.hdMediaUrl };

  const out = resolveOutputPath(opts.outputPath, 'upscaleGrokVideo');
  const dl = await call(deps, {
    op: 'download',
    url: r.hdMediaUrl,
    outputPath: out,
    outputDir: path.dirname(out),
  });
  return { hdMediaUrl: r.hdMediaUrl, file: dl.path ?? out, bytes: dl.bytes };
}

/**
 * Kick off caption generation for a video the seat OWNS (FREE, statsig-free).
 * Returns the job result (`status`/`progressPct`/`postId`). NOTE: the seat only
 * captions videos it owns — a non-owned video surfaces as GrokMediaExtrasError
 * with errorClass "forbidden".
 */
export async function captionGrokVideo(
  videoId: string,
  opts: {
    preset?: string;
    style?: string;
    canvasId?: string;
    containerId?: string;
    deps?: GrokMediaExtrasDeps;
  } = {},
): Promise<GrokCaptionResult> {
  const id = assertVideoId(videoId, 'captionGrokVideo');
  const r = await call(opts.deps ?? defaultDeps(), {
    op: 'caption',
    videoId: id,
    ...(opts.preset ? { preset: opts.preset } : {}),
    ...(opts.style ? { style: opts.style } : {}),
    ...(opts.canvasId ? { canvasId: opts.canvasId } : {}),
    ...(opts.containerId ? { containerId: opts.containerId } : {}),
  });
  if (!r.caption) {
    throw new GrokMediaExtrasError('bad_response', 'grok-media-extras caption: no result');
  }
  log.info({ status: r.caption.status }, 'grok-media-extras caption started');
  return r.caption;
}

export { GrokWebReloginRequiredError, GrokWebDisabledError, isGrokWebSessionEnabled };
