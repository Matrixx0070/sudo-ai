/**
 * @file grok-embeddings-bridge.ts
 * @description Node ↔ Python bridge for the Grok managed-embedding RAG lane.
 *
 * Thin wrapper that spawns `scripts/grok-web/grok_embeddings.py` — the only
 * component that needs Python: curl_cffi impersonates Chrome so grok.com's
 * Cloudflare-fronted `/rest/grok-for-teams/collections/*` accepts the call.
 * One JSON request on stdin, one JSON response on stdout. Cloned from
 * `grok-web-bridge.ts` (same spawn / settle / SIGKILL / hard-timeout shape).
 *
 * These collection endpoints are cookie-only (statsig-FREE, proven live
 * 2026-07-21). NOTE: semantic RETRIEVAL is NOT reachable here — it only exists
 * via the statsig-gated app-chat lane — so this bridge covers the ingest +
 * management half (model catalog, collection CRUD, document add/list, indexing).
 *
 * SECRETS: `cookie` + `userAgent` are session secrets. They are passed to the
 * child on stdin ONLY and are NEVER logged here (the python side never echoes
 * them either). Do not add debug logging of `req`.
 *
 * Same-host invariant: cf_clearance is IP-bound, so this always spawns a LOCAL
 * python3; it never makes a network hop of its own.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { PROJECT_ROOT } from '../core/shared/paths.js';
import { createLogger } from '../core/shared/logger.js';

const log = createLogger('llm:grok-embeddings-bridge');

const SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'grok-web', 'grok_embeddings.py');
const PYTHON_BIN = process.env['SUDO_GROK_WEB_PYTHON'] ?? 'python3';

/** Hard ceiling regardless of per-op timeouts (bridge-level guard). */
const HARD_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Request / response types
// ---------------------------------------------------------------------------

/** Secrets carried on every request (never logged). */
export interface GrokEmbedCreds {
  cookie: string;
  userAgent: string;
}

export interface EmbedModelsRequest {
  op: 'models';
  timeoutSec?: number;
}
export interface EmbedCreateRequest {
  op: 'create';
  name: string;
  /** Embedding model; defaults to grok-embedding-small server-side. */
  model?: string;
  timeoutSec?: number;
}
export interface EmbedListRequest {
  op: 'list';
  timeoutSec?: number;
}
export interface EmbedDeleteRequest {
  op: 'delete';
  collectionId: string;
  timeoutSec?: number;
}
export interface EmbedMetadataRequest {
  op: 'metadata';
  collectionId: string;
  timeoutSec?: number;
}
export interface EmbedAddDocRequest {
  op: 'add_doc';
  collectionId: string;
  docName: string;
  /** base64-encoded document bytes. */
  contentBase64: string;
  contentType?: string;
  timeoutSec?: number;
}
export interface EmbedListDocsRequest {
  op: 'list_docs';
  collectionId: string;
  timeoutSec?: number;
}

export type GrokEmbedRequest =
  | EmbedModelsRequest
  | EmbedCreateRequest
  | EmbedListRequest
  | EmbedDeleteRequest
  | EmbedMetadataRequest
  | EmbedAddDocRequest
  | EmbedListDocsRequest;

/** Error classes the python side emits (mirror grok-web-bridge vocabulary). */
export type GrokEmbedErrorClass =
  | 'cloudflare' // 403 + "Just a moment" → refresh cf_clearance/__cf_bm
  | 'relogin' // 401 / login page → sso dead
  | 'grpc_not_found' // 404 → wrong path
  | 'http_error'
  | 'bad_request'
  | 'timeout'
  | 'exception'
  | 'bridge_error';

export interface GrokEmbedCollection {
  collectionId?: string;
  collectionName?: string;
  createdAt?: string;
  documentsCount?: number;
  modelName?: string;
}

export interface GrokEmbedDocument {
  fileId?: string;
  name?: string;
  sizeBytes?: string;
  processingStatus?: string;
  status?: string;
  chunksProcessedCount?: string;
  lastIndexedAt?: string | null;
}

export interface GrokEmbedResponse {
  ok: boolean;
  status?: number;
  errorClass?: GrokEmbedErrorClass;
  detail?: string;
  // models
  models?: string[];
  chunkConfigEditable?: boolean;
  // create / metadata
  collectionId?: string;
  collectionName?: string;
  modelName?: string;
  documentsCount?: number;
  // list
  collections?: GrokEmbedCollection[];
  // add_doc
  fileId?: string;
  docName?: string;
  sizeBytes?: string;
  processingStatus?: string;
  documentStatus?: string;
  // list_docs
  documents?: GrokEmbedDocument[];
}

/** Injectable spawn seam — real child_process by default, mocked in tests. */
export type SpawnFn = typeof spawn;

// ---------------------------------------------------------------------------
// Bridge call
// ---------------------------------------------------------------------------

/**
 * Run one embeddings/collections operation. Resolves with the python response
 * (including structured `ok:false` errors); rejects never — a spawn/transport
 * failure that yields no JSON surfaces as `ok:false errorClass:"bridge_error"`.
 */
export function callGrokEmbeddingsBridge(
  req: GrokEmbedRequest,
  creds: GrokEmbedCreds,
  spawnFn: SpawnFn = spawn,
): Promise<GrokEmbedResponse> {
  const perOpMs =
    typeof (req as { timeoutSec?: number }).timeoutSec === 'number'
      ? (req as { timeoutSec: number }).timeoutSec * 1000 + 15_000
      : HARD_TIMEOUT_MS;
  const timeoutMs = Math.min(perOpMs, HARD_TIMEOUT_MS);

  return new Promise<GrokEmbedResponse>((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';

    const child = spawnFn(PYTHON_BIN, [SCRIPT_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });

    const settle = (r: GrokEmbedResponse): void => {
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
      log.warn({ op: req.op, timeoutMs }, 'grok-embeddings bridge timed out');
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
        const parsed = JSON.parse(line) as GrokEmbedResponse;
        // Never log secrets; log only the coarse outcome.
        log.debug(
          { op: req.op, ok: parsed.ok, status: parsed.status, errorClass: parsed.errorClass },
          'grok-embeddings bridge result',
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
