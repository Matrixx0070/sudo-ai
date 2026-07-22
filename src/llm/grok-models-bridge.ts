/**
 * @file grok-models-bridge.ts
 * @description Node ↔ Python bridge for the Grok model-catalog / rate-limit
 * seat lane. Spawns `scripts/grok-web/grok_models.py` (curl_cffi — grok.com
 * `/rest/*` sits behind Cloudflare and 403s plain Node fetch). One JSON request
 * on stdin, one JSON response on stdout. Clone of the proven
 * `grok-web-bridge.ts` spawn/settle/timeout structure.
 *
 * SECRETS: the cookie header is a session secret. It is passed to the child on
 * stdin ONLY and is NEVER logged here (the python side never echoes it either).
 * Do not add debug logging of `req`.
 *
 * Same-host invariant: cf_clearance is IP-bound, so the python child must run
 * on the same machine as the browser that captured the session. This bridge
 * always spawns a LOCAL python3; it never makes a network hop of its own.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { PROJECT_ROOT } from '../core/shared/paths.js';
import { createLogger } from '../core/shared/logger.js';
import type { GrokWebCreds, GrokWebErrorClass } from './grok-web-bridge.js';

const log = createLogger('llm:grok-models-bridge');

const SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'grok-web', 'grok_models.py');
const PYTHON_BIN = process.env['SUDO_GROK_WEB_PYTHON'] ?? 'python3';

/** Hard ceiling regardless of per-op timeouts (bridge-level guard). */
const HARD_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Request / response types (verified live against the seat 2026-07-21)
// ---------------------------------------------------------------------------

export interface ModelsRequest {
  op: 'models';
  locale?: string;
  timeoutSec?: number;
}

export interface RateLimitsRequest {
  op: 'rate_limits';
  modelName: string;
  /** Known kinds in the grok.com app bundle: DEFAULT, DEEPSEARCH. */
  requestKind?: string;
  timeoutSec?: number;
}

export type GrokModelsRequest = ModelsRequest | RateLimitsRequest;

/** One catalog entry as grok.com/rest/models returns it. */
export interface GrokCatalogModel {
  modelId: string;
  name: string;
  description: string;
  modeDescription: string;
  modeName: string;
  badgeText: string;
  tags: string[];
  modelMode: string;
  promptingBackend: string;
}

/** Tier defaults reshaped by the python bridge from the default* fields. */
export interface GrokModelDefaults {
  free: string | null;
  pro: string | null;
  heavy: string | null;
  anon: string | null;
  freeMode: string | null;
  proMode: string | null;
  heavyMode: string | null;
  anonMode: string | null;
}

export interface GrokModelsResponse {
  ok: boolean;
  status?: number;
  errorClass?: GrokWebErrorClass;
  detail?: string;
  // op=models
  models?: GrokCatalogModel[];
  unavailableModels?: GrokCatalogModel[];
  defaults?: GrokModelDefaults;
  // op=rate_limits
  modelName?: string;
  requestKind?: string;
  windowSizeSeconds?: number;
  remainingQueries?: number;
  totalQueries?: number;
  lowEffortRateLimits?: unknown;
  highEffortRateLimits?: unknown;
}

/** Injectable spawn seam — real child_process by default, mocked in tests. */
export type SpawnFn = typeof spawn;

// ---------------------------------------------------------------------------
// Bridge call
// ---------------------------------------------------------------------------

/**
 * Run one models/rate-limits operation. Resolves with the python response
 * (including structured `ok:false` errors); never rejects — transport failures
 * come back as `errorClass:"bridge_error"`.
 */
export function callGrokModelsBridge(
  req: GrokModelsRequest,
  creds: GrokWebCreds,
  spawnFn: SpawnFn = spawn,
): Promise<GrokModelsResponse> {
  const perOpMs =
    typeof req.timeoutSec === 'number' ? req.timeoutSec * 1000 + 15_000 : HARD_TIMEOUT_MS;
  const timeoutMs = Math.min(perOpMs, HARD_TIMEOUT_MS);

  return new Promise<GrokModelsResponse>((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';

    const child = spawnFn(PYTHON_BIN, [SCRIPT_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });

    const settle = (r: GrokModelsResponse): void => {
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
      log.warn({ op: req.op, timeoutMs }, 'grok-models bridge timed out');
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
        const parsed = JSON.parse(line) as GrokModelsResponse;
        // Never log secrets; log only the coarse outcome.
        log.debug(
          { op: req.op, ok: parsed.ok, status: parsed.status, errorClass: parsed.errorClass },
          'grok-models bridge result',
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
