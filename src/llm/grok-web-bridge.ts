/**
 * @file grok-web-bridge.ts
 * @description GW2 — Node ↔ Python bridge for the Grok web-session replay.
 *
 * Thin wrapper that spawns `scripts/grok-web/grok_web_replay.py` (the only
 * component that needs Python: curl_cffi for the Cloudflare-impersonated REST
 * lanes + `websocket-client` for the image WebSocket — see
 * docs/grok-web-imagine-protocol.md). One JSON request on stdin, one JSON
 * response on stdout.
 *
 * SECRETS: the cookie header and x-statsig-id are session secrets. They are
 * passed to the child on stdin ONLY and are NEVER logged here (the python side
 * never echoes them either). Do not add debug logging of `req`.
 *
 * Same-host invariant: the python replay must run on the same machine (same
 * public IP) as the browser that captured the session — cf_clearance is
 * IP-bound. This bridge therefore always spawns a LOCAL python3; it never makes
 * a network hop of its own.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { PROJECT_ROOT } from '../core/shared/paths.js';
import { createLogger } from '../core/shared/logger.js';

const log = createLogger('llm:grok-web-bridge');

const SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'grok-web', 'grok_web_replay.py');
const PYTHON_BIN = process.env['SUDO_GROK_WEB_PYTHON'] ?? 'python3';

/** Hard ceiling regardless of per-op timeouts (bridge-level guard). */
const HARD_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------
// Request / response types
// ---------------------------------------------------------------------------

/** Secrets + identity carried on every request (never logged). */
export interface GrokWebCreds {
  cookie: string;
  userAgent: string;
  /** Required for op=video only. */
  statsigId?: string;
}

export interface ProbeRequest {
  op: 'probe';
  timeoutSec?: number;
}
export interface ImageRequest {
  op: 'image';
  prompt: string;
  aspectRatio?: string;
  numGenerations?: number;
  pro?: boolean;
  timeoutSec?: number;
}
export interface VideoRequest {
  op: 'video';
  /** Text-to-video (PROVEN) when omitted; image-to-video when set. */
  imageUrl?: string;
  /** Prompt for text-to-video (required when imageUrl is absent). */
  prompt?: string;
  aspectRatio?: string;
  videoLength?: number;
  resolutionName?: string;
  timeoutSec?: number;
  /**
   * Freshly-minted x-statsig-id for THIS request (GWV2 oracle path). When set it
   * overrides any session-stored token — always mint-and-use in <1s.
   */
  statsigId?: string;
}

/** Download a generated asset (mp4) with the session cookies to a local path. */
export interface DownloadRequest {
  op: 'download';
  url: string;
  outputPath: string;
  timeoutSec?: number;
}

export type GrokWebRequest = ProbeRequest | ImageRequest | VideoRequest | DownloadRequest;

/**
 * Error classes the python side emits so the manager can react correctly
 * (see docs/grok-web-imagine-protocol.md §7). Getting these wrong causes
 * refresh loops.
 */
export type GrokWebErrorClass =
  | 'cloudflare' // 403 + "Just a moment" → refresh cf_clearance/__cf_bm
  | 'statsig' // app-chat 403 with valid cookies → re-capture x-statsig-id
  | 'grpc_not_found' // 404 {"code":5} → wrong path, do NOT refresh
  | 'relogin' // 401 / login page → sso dead
  | 'no_images'
  | 'timeout'
  | 'stream_ended'
  | 'http_error'
  | 'bad_request'
  | 'exception'
  | 'bridge_error';

export interface GrokWebImage {
  jobId: string | null;
  /** base64-encoded JPEG bytes. */
  b64: string;
  publicUrl: string | null;
}

export interface GrokWebResponse {
  ok: boolean;
  status?: number;
  errorClass?: GrokWebErrorClass;
  detail?: string;
  // probe
  quota?: Record<string, { available: boolean; windowSizeSeconds: number }>;
  // image
  images?: GrokWebImage[];
  // video
  videoUrl?: string;
  thumbnailUrl?: string;
  videoId?: string;
  // download
  path?: string;
  bytes?: number;
  ftyp?: boolean;
}

/** Injectable spawn seam — real child_process by default, mocked in tests. */
export type SpawnFn = typeof spawn;

// ---------------------------------------------------------------------------
// Bridge call
// ---------------------------------------------------------------------------

/**
 * Run one replay operation. Resolves with the python response (including
 * structured `ok:false` errors); rejects only on a spawn/transport failure that
 * yields no JSON at all.
 */
export function callGrokWebBridge(
  req: GrokWebRequest,
  creds: GrokWebCreds,
  spawnFn: SpawnFn = spawn,
): Promise<GrokWebResponse> {
  const perOpMs =
    typeof (req as { timeoutSec?: number }).timeoutSec === 'number'
      ? (req as { timeoutSec: number }).timeoutSec * 1000 + 15_000
      : HARD_TIMEOUT_MS;
  const timeoutMs = Math.min(perOpMs, HARD_TIMEOUT_MS);

  return new Promise<GrokWebResponse>((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';

    const child = spawnFn(PYTHON_BIN, [SCRIPT_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });

    const settle = (r: GrokWebResponse): void => {
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
      log.warn({ op: req.op, timeoutMs }, 'grok-web bridge timed out');
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
        const parsed = JSON.parse(line) as GrokWebResponse;
        // Never log secrets; log only the coarse outcome.
        log.debug(
          { op: req.op, ok: parsed.ok, status: parsed.status, errorClass: parsed.errorClass },
          'grok-web bridge result',
        );
        settle(parsed);
      } catch {
        settle({
          ok: false,
          errorClass: 'bridge_error',
          detail: `no JSON from bridge (exit ${code}); stderr: ${stderr.slice(0, 200)}`,
        });
      }
    });

    // Secrets go in ONLY here, on stdin. Never logged.
    const payload = JSON.stringify({ ...req, ...creds });
    try {
      child.stdin?.write(payload);
      child.stdin?.end();
    } catch (err) {
      settle({ ok: false, errorClass: 'bridge_error', detail: `stdin write failed: ${String(err)}` });
    }
  });
}
