/**
 * @file grok-memory-bridge.ts
 * @description Node ↔ Python bridge for the Grok persistent-memory seat lane
 * (user memory blurb + imported X memory). Spawns
 * `scripts/grok-web/grok_memory.py` (curl_cffi — grok.com `/rest/*` sits behind
 * Cloudflare and 403s plain Node fetch). One JSON request on stdin, one JSON
 * response on stdout. Clone of the proven `grok-web-bridge.ts`
 * spawn/settle/timeout structure.
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

const log = createLogger('llm:grok-memory-bridge');

const SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'grok-web', 'grok_memory.py');
const PYTHON_BIN = process.env['SUDO_GROK_WEB_PYTHON'] ?? 'python3';

/** Hard ceiling regardless of per-op timeouts (bridge-level guard). */
const HARD_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Request / response types (verified live against the seat 2026-07-21)
// ---------------------------------------------------------------------------

export interface BlurbGetRequest {
  op: 'blurb_get';
  timeoutSec?: number;
}

export interface BlurbSetRequest {
  op: 'blurb_set';
  memoryContent: string;
  timeoutSec?: number;
}

export interface BlurbClearRequest {
  op: 'blurb_clear';
  timeoutSec?: number;
}

export interface ImportedGetRequest {
  op: 'imported_get';
  timeoutSec?: number;
}

export type GrokMemoryRequest =
  | BlurbGetRequest
  | BlurbSetRequest
  | BlurbClearRequest
  | ImportedGetRequest;

export interface GrokMemoryResponse {
  ok: boolean;
  status?: number;
  errorClass?: GrokWebErrorClass;
  detail?: string;
  // op=blurb_get / blurb_set
  memoryContent?: string;
  // op=blurb_set / blurb_clear — write verified by read-back (the PUT can 200
  // yet be silently dropped server-side; see grok_memory.py header).
  persisted?: boolean;
  readBack?: string;
  // op=imported_get
  content?: string;
  importStatus?: string;
}

/** Injectable spawn seam — real child_process by default, mocked in tests. */
export type SpawnFn = typeof spawn;

// ---------------------------------------------------------------------------
// Bridge call
// ---------------------------------------------------------------------------

/**
 * Run one memory operation. Resolves with the python response (including
 * structured `ok:false` errors); never rejects — transport failures come back
 * as `errorClass:"bridge_error"`.
 */
export function callGrokMemoryBridge(
  req: GrokMemoryRequest,
  creds: GrokWebCreds,
  spawnFn: SpawnFn = spawn,
): Promise<GrokMemoryResponse> {
  const perOpMs =
    typeof req.timeoutSec === 'number' ? req.timeoutSec * 1000 + 15_000 : HARD_TIMEOUT_MS;
  const timeoutMs = Math.min(perOpMs, HARD_TIMEOUT_MS);

  return new Promise<GrokMemoryResponse>((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';

    const child = spawnFn(PYTHON_BIN, [SCRIPT_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });

    const settle = (r: GrokMemoryResponse): void => {
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
      log.warn({ op: req.op, timeoutMs }, 'grok-memory bridge timed out');
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
        const parsed = JSON.parse(line) as GrokMemoryResponse;
        // Never log secrets; log only the coarse outcome.
        log.debug(
          { op: req.op, ok: parsed.ok, status: parsed.status, errorClass: parsed.errorClass },
          'grok-memory bridge result',
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
