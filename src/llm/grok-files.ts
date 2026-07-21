/**
 * @file grok-files.ts
 * @description FREE file upload + management on the $30 grok.com subscription
 * seat, via the app-chat file lane the web UI uses (ALL ops cookie-only,
 * statsig-FREE — PROVEN LIVE 2026-07-21):
 *
 *   upload   -> POST /rest/app-chat/upload-file (base64 JSON body)
 *   get      -> POST /rest/app-chat/file-metadata/{fileMetadataId}
 *   download -> GET  assets host /{fileUri} (raw bytes)
 *
 * Storage is PERSISTENT and user-scoped (fileUri = users/{userId}/{fileId}/
 * content); a fileMetadataId is reusable across chats as a `fileAttachments`
 * entry (the grok-rag lane consumes exactly these ids). HONEST LIMITS, probed
 * live: the seat exposes NO list-my-uploads and NO delete endpoint (DELETE
 * file-metadata -> 501, /rest/app-chat/delete-file -> 404) — so this module
 * ships upload/get/download only and does not fake the rest.
 *
 * Reuses GW3 (session manager) behind the shared `SUDO_GROK_WEBSESSION` flag
 * (default OFF). No new flag, no statsig mint needed. Secrets ride stdin into
 * the python bridge only and are never logged. The lane is seat-covered — it
 * never touches the metered api.x.ai (money safety).
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { PROJECT_ROOT } from '../core/shared/paths.js';
import { createLogger } from '../core/shared/logger.js';
import {
  getGrokWebSessionManager,
  GrokWebReloginRequiredError,
  type GrokWebSessionManager,
} from './grok-web-session-manager.js';
import type { GrokWebCreds } from './grok-web-bridge.js';
import { isGrokWebSessionEnabled, GrokWebDisabledError } from './grok-web-media.js';

const log = createLogger('llm:grok-files');

const SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'grok-web', 'grok_files.py');
const PYTHON_BIN = process.env['SUDO_GROK_WEB_PYTHON'] ?? 'python3';
const HARD_TIMEOUT_MS = 180_000;
/** Reject uploads larger than this to keep the seat call sane. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** fileMetadataId is a UUID; validate before it ever reaches a URL path. */
const FILE_ID_RE = /^[0-9a-fA-F-]{32,40}$/;

const EXT_MIME: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.html': 'text/html',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Metadata grok stores for an uploaded file (verified live shape). */
export interface GrokFileMetadata {
  fileMetadataId: string;
  fileName?: string;
  fileMimeType?: string;
  fileUri?: string;
  parsedFileUri?: string;
  createTime?: string;
  fileSource?: string;
}

/** Bridge request (secrets merged in separately, never logged). */
export interface GrokFilesBridgeRequest {
  op: 'upload' | 'get' | 'download';
  fileName?: string;
  fileMimeType?: string;
  contentB64?: string;
  fileMetadataId?: string;
  timeoutSec?: number;
}

export interface GrokFilesBridgeResponse {
  ok: boolean;
  status?: number;
  errorClass?: string;
  detail?: string;
  file?: GrokFileMetadata;
  contentB64?: string;
}

export class GrokFilesError extends Error {
  readonly errorClass: string;
  readonly status?: number;
  constructor(errorClass: string, message: string, status?: number) {
    super(message);
    this.name = 'GrokFilesError';
    this.errorClass = errorClass;
    if (status !== undefined) this.status = status;
  }
}

export interface GrokFilesDeps {
  manager: GrokWebSessionManager;
  /** Spawns grok_files.py; injectable so tests need no network. */
  bridge: (req: GrokFilesBridgeRequest, creds: GrokWebCreds) => Promise<GrokFilesBridgeResponse>;
}

// ---------------------------------------------------------------------------
// Default seams (clone of the grok-rag bridge spawn)
// ---------------------------------------------------------------------------

function defaultBridge(
  req: GrokFilesBridgeRequest,
  creds: GrokWebCreds,
): Promise<GrokFilesBridgeResponse> {
  const timeoutMs = Math.min(
    typeof req.timeoutSec === 'number' ? req.timeoutSec * 1000 + 15_000 : HARD_TIMEOUT_MS,
    HARD_TIMEOUT_MS,
  );
  return new Promise<GrokFilesBridgeResponse>((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const child = spawn(PYTHON_BIN, [SCRIPT_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    const settle = (r: GrokFilesBridgeResponse): void => {
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
        settle(JSON.parse(line) as GrokFilesBridgeResponse);
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

function defaultDeps(): GrokFilesDeps {
  return { manager: getGrokWebSessionManager(), bridge: defaultBridge };
}

async function ready(deps: GrokFilesDeps): Promise<GrokWebCreds> {
  if (!isGrokWebSessionEnabled()) throw new GrokWebDisabledError();
  const session = await deps.manager.ensureHealthy(); // throws GrokWebReloginRequiredError on dead sso
  return { cookie: session.cookie, userAgent: session.userAgent };
}

async function call(
  deps: GrokFilesDeps,
  req: GrokFilesBridgeRequest,
): Promise<GrokFilesBridgeResponse> {
  const creds = await ready(deps);
  const r = await deps.bridge(req, creds);
  if (!r.ok) {
    throw new GrokFilesError(
      r.errorClass ?? 'unknown',
      `grok-files ${req.op} failed: ${r.errorClass ?? 'unknown'}${r.detail ? ` (${r.detail})` : ''}`,
      r.status,
    );
  }
  return r;
}

function assertFileId(fileMetadataId: string, fn: string): string {
  const id = (fileMetadataId ?? '').trim();
  if (!id || !FILE_ID_RE.test(id)) {
    throw new TypeError(`${fn}: fileMetadataId must be a UUID-shaped string`);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Capability functions
// ---------------------------------------------------------------------------

/**
 * Upload a local file to grok's persistent per-user file storage, FREE on the
 * subscription seat. Returns the stored metadata; `fileMetadataId` is reusable
 * across chats (e.g. as a `fileAttachments` entry). Throws `TypeError` on bad
 * input and `GrokFilesError` on any lane failure — never falls back to a paid API.
 */
export async function uploadGrokFile(
  filePath: string,
  opts: { mimeType?: string; deps?: GrokFilesDeps } = {},
): Promise<GrokFileMetadata> {
  const p = (filePath ?? '').trim();
  if (!p) throw new TypeError('uploadGrokFile: filePath must be a non-empty string');
  const resolved = path.resolve(p);
  let st;
  try {
    st = await stat(resolved);
  } catch {
    throw new TypeError(`uploadGrokFile: cannot read file "${filePath}"`);
  }
  if (!st.isFile()) throw new TypeError(`uploadGrokFile: not a regular file "${filePath}"`);
  if (st.size === 0) throw new TypeError(`uploadGrokFile: file "${filePath}" is empty`);
  if (st.size > MAX_FILE_BYTES) {
    throw new TypeError(`uploadGrokFile: file "${filePath}" exceeds ${MAX_FILE_BYTES} bytes`);
  }
  const bytes = await readFile(resolved);
  const ext = path.extname(resolved).toLowerCase();
  const r = await call(opts.deps ?? defaultDeps(), {
    op: 'upload',
    fileName: path.basename(resolved),
    fileMimeType: opts.mimeType ?? EXT_MIME[ext] ?? 'application/octet-stream',
    contentB64: bytes.toString('base64'),
  });
  if (!r.file?.fileMetadataId) {
    throw new GrokFilesError('bad_response', 'grok-files upload: no fileMetadataId in response');
  }
  log.info({ bytes: st.size, mime: r.file.fileMimeType }, 'grok-files uploaded');
  return r.file;
}

/**
 * Fetch the stored metadata for an uploaded file (proves persistence).
 * Unknown ids surface as GrokFilesError with errorClass "not_found".
 */
export async function getGrokFileMetadata(
  fileMetadataId: string,
  opts: { deps?: GrokFilesDeps } = {},
): Promise<GrokFileMetadata> {
  const id = assertFileId(fileMetadataId, 'getGrokFileMetadata');
  const r = await call(opts.deps ?? defaultDeps(), { op: 'get', fileMetadataId: id });
  if (!r.file?.fileMetadataId) {
    throw new GrokFilesError('bad_response', 'grok-files get: no metadata in response');
  }
  return r.file;
}

/** Download an uploaded file's raw bytes back from grok's asset store. */
export async function downloadGrokFile(
  fileMetadataId: string,
  opts: { deps?: GrokFilesDeps } = {},
): Promise<{ file: GrokFileMetadata; content: Buffer }> {
  const id = assertFileId(fileMetadataId, 'downloadGrokFile');
  const r = await call(opts.deps ?? defaultDeps(), { op: 'download', fileMetadataId: id });
  if (!r.file?.fileMetadataId || typeof r.contentB64 !== 'string') {
    throw new GrokFilesError('bad_response', 'grok-files download: missing metadata or content');
  }
  const content = Buffer.from(r.contentB64, 'base64');
  log.info({ bytes: content.length }, 'grok-files downloaded');
  return { file: r.file, content };
}

export { GrokWebReloginRequiredError, GrokWebDisabledError, isGrokWebSessionEnabled };
