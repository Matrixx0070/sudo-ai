/**
 * @file routes.ts
 * @description HTTP request listener for /v1/files REST endpoints.
 *
 * Endpoints (5 total):
 *   POST   /v1/files            — multipart upload (10 MB max, 100 files/session cap)
 *   GET    /v1/files            — list (optional ?scope_id=sesn_...)
 *   GET    /v1/files/:id        — metadata
 *   GET    /v1/files/:id/content — stream file bytes
 *   DELETE /v1/files/:id        — soft-delete (set deleted_at)
 *
 * Auth: GATEWAY_TOKEN bearer (timing-safe).
 * MIME: magic-byte sniff vs declared MIME for PDF/PNG/JPEG/ZIP.
 * Path-traversal: filename validated with validateFilename().
 */

import { timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import busboy from 'busboy';
import { createLogger } from '../shared/logger.js';
import { FileStore, computeSha256 } from './store.js';
import {
  FileStoreError,
  MAX_FILE_BYTES,
  validateMimeMagic,
  validateFilename,
} from './types.js';

const log = createLogger('files:routes');

// ---------------------------------------------------------------------------
// Auth helpers (self-contained — do not import from gateway)
// ---------------------------------------------------------------------------

function getTokenBuf(): Buffer | null {
  const t = process.env['GATEWAY_TOKEN'];
  return t && t.length > 0 ? Buffer.from(t, 'utf8') : null;
}

function isAuthorised(req: IncomingMessage): boolean {
  const tokenBuf = getTokenBuf();
  if (!tokenBuf) return true;
  const h = req.headers['authorization'] ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(typeof h === 'string' ? h.trim() : '');
  const candidate = Buffer.from(m ? (m[1] ?? '') : '', 'utf8');
  return candidate.length === tokenBuf.length && timingSafeEqual(candidate, tokenBuf);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const p = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(p),
  });
  res.end(p);
}

function sendError(res: ServerResponse, status: number, msg: string): void {
  sendJson(res, status, { error: { message: msg, code: status } });
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/** POST /v1/files — multipart upload */
async function handleUpload(
  req: IncomingMessage,
  res: ServerResponse,
  store: FileStore,
): Promise<void> {
  const scopeId = (req.headers['x-scope-id'] as string | undefined)?.trim();
  if (!scopeId) {
    sendError(res, 400, 'Missing X-Scope-Id header (session ID required for upload)');
    return;
  }

  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.includes('multipart/form-data')) {
    sendError(res, 400, 'Content-Type must be multipart/form-data');
    return;
  }

  // Early cap check — reject before receiving upload bytes to avoid orphan files on disk
  try {
    store.checkCap(scopeId);
  } catch (err) {
    if (err instanceof FileStoreError && err.code === 'file_cap_exceeded') {
      sendError(res, 422, err.message);
    } else {
      log.error({ err: String(err) }, 'cap check error');
      sendError(res, 500, 'Internal server error');
    }
    return;
  }

  return new Promise<void>((resolve) => {
    let settled = false;
    function finish(fn: () => void) {
      if (settled) return;
      settled = true;
      fn();
      resolve();
    }

    let bb: ReturnType<typeof busboy>;
    try {
      bb = busboy({
        headers: req.headers as Record<string, string>,
        limits: { files: 1, fileSize: MAX_FILE_BYTES + 1, fields: 10 },
      });
    } catch (err) {
      finish(() => sendError(res, 400, `Invalid multipart request: ${String(err)}`));
      return;
    }

    let fileReceived = false;
    let declared_mime = 'application/octet-stream';

    bb.on('field', (name: string, val: string) => {
      if (name === 'mime') declared_mime = val.trim();
    });

    bb.on('file', (fieldname: string, stream: NodeJS.ReadableStream & { destroy?: () => void }, info: { filename: string; mimeType: string }) => {
      if (fileReceived) {
        stream.resume(); // drain and ignore extra files
        return;
      }
      fileReceived = true;

      const rawFilename = info.filename || fieldname || 'upload';
      const safeFilename = validateFilename(rawFilename);
      if (!safeFilename) {
        stream.resume();
        finish(() => sendError(res, 400, `Invalid filename: "${rawFilename}"`));
        return;
      }

      // Use content-type from multipart field if no explicit mime field was set yet
      if (info.mimeType && info.mimeType !== 'application/octet-stream') {
        declared_mime = info.mimeType;
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let limitExceeded = false;

      stream.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_FILE_BYTES) {
          limitExceeded = true;
          stream.destroy?.();
          return;
        }
        chunks.push(chunk);
      });

      stream.on('limit', () => {
        limitExceeded = true;
        stream.destroy?.();
      });

      stream.on('end', () => {
        if (limitExceeded) {
          finish(() => sendError(res, 413, `File exceeds ${MAX_FILE_BYTES / 1024 / 1024} MB limit`));
          return;
        }

        const data = Buffer.concat(chunks);
        const sha256 = computeSha256(data);

        // MIME magic-byte validation
        const mimeError = validateMimeMagic(declared_mime, data);
        if (mimeError) {
          finish(() => sendError(res, 422, mimeError));
          return;
        }

        let meta;
        let storagePath: string | undefined;
        try {
          storagePath = store.writeFileToDisk(`file_${sha256.slice(0, 16)}`, sha256, data);
          meta = store.create({
            filename:    safeFilename,
            mime:        declared_mime,
            size_bytes:  data.length,
            sha256,
            scope_id:    scopeId,
            storage_path: storagePath,
          });
        } catch (err) {
          // Clean up orphan file if writeFileToDisk succeeded but create() failed
          if (storagePath) {
            try { fs.unlinkSync(storagePath); } catch { /* best-effort */ }
          }
          if (err instanceof FileStoreError) {
            const status = err.code === 'file_cap_exceeded' ? 422 : 500;
            finish(() => sendError(res, status, err.message));
          } else {
            log.error({ err: String(err) }, 'upload store error');
            finish(() => sendError(res, 500, 'Internal server error'));
          }
          return;
        }

        finish(() => sendJson(res, 201, meta));
      });

      stream.on('error', (err) => {
        log.warn({ err: String(err) }, 'upload stream error');
        finish(() => sendError(res, 400, 'Upload stream error'));
      });
    });

    bb.on('error', (err: Error) => {
      log.warn({ err: String(err) }, 'busboy error');
      finish(() => sendError(res, 400, `Multipart parse error: ${err.message}`));
    });

    bb.on('finish', () => {
      if (!fileReceived) {
        finish(() => sendError(res, 400, 'No file field in multipart body'));
      }
    });

    req.pipe(bb);
  });
}

/** GET /v1/files — list files */
function handleList(req: IncomingMessage, res: ServerResponse, store: FileStore): void {
  const url = new URL(req.url ?? '/', 'http://x');
  const scopeId = url.searchParams.get('scope_id') ?? undefined;
  const limit = parseInt(url.searchParams.get('limit') ?? '100', 10);
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);

  if (isNaN(limit) || limit < 1 || limit > 500) {
    sendError(res, 400, 'Invalid limit (1–500)');
    return;
  }
  if (isNaN(offset) || offset < 0) {
    sendError(res, 400, 'Invalid offset');
    return;
  }

  const files = store.list({ scope_id: scopeId, limit, offset });
  sendJson(res, 200, { data: files, has_more: files.length === limit });
}

/** GET /v1/files/:id — metadata */
function handleGetMeta(
  req: IncomingMessage,
  res: ServerResponse,
  store: FileStore,
  id: string,
): void {
  const scopeId = (req.headers['x-scope-id'] as string | undefined)?.trim();
  if (!scopeId) {
    sendError(res, 400, 'Missing X-Scope-Id header');
    return;
  }
  const meta = store.getById(id);
  if (!meta) {
    sendError(res, 404, `File "${id}" not found`);
    return;
  }
  if (meta.scope_id !== scopeId) {
    sendError(res, 403, 'Forbidden');
    return;
  }
  sendJson(res, 200, meta);
}

/** GET /v1/files/:id/content — stream bytes */
function handleGetContent(
  req: IncomingMessage,
  res: ServerResponse,
  store: FileStore,
  id: string,
): void {
  const scopeId = (req.headers['x-scope-id'] as string | undefined)?.trim();
  if (!scopeId) {
    sendError(res, 400, 'Missing X-Scope-Id header');
    return;
  }
  const row = store.getRowById(id);
  if (!row) {
    sendError(res, 404, `File "${id}" not found`);
    return;
  }
  if (row.scope_id !== scopeId) {
    sendError(res, 403, 'Forbidden');
    return;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(row.storage_path);
  } catch {
    sendError(res, 404, 'File data not available on disk');
    return;
  }

  // RFC 5987 Content-Disposition encoding to prevent header injection.
  // Fallback (double-quotes stripped for non-RFC5987 clients) + RFC5987 filename*.
  const safeAsciiName = row.filename.replace(/"/g, '');
  const rfc5987Name = encodeURIComponent(row.filename);
  res.writeHead(200, {
    'Content-Type':   row.mime,
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${safeAsciiName}"; filename*=UTF-8''${rfc5987Name}`,
    'Cache-Control': 'no-store',
  });

  const stream = fs.createReadStream(row.storage_path);
  stream.on('error', (err) => {
    log.warn({ err: String(err), id }, 'stream error on content download');
    if (!res.headersSent) {
      sendError(res, 500, 'Read error');
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
}

/** DELETE /v1/files/:id — soft-delete */
function handleDelete(
  req: IncomingMessage,
  res: ServerResponse,
  store: FileStore,
  id: string,
): void {
  const scopeId = (req.headers['x-scope-id'] as string | undefined)?.trim();
  if (!scopeId) {
    sendError(res, 400, 'Missing X-Scope-Id header');
    return;
  }
  const row = store.getRowById(id);
  if (!row) {
    sendError(res, 404, `File "${id}" not found`);
    return;
  }
  if (row.scope_id !== scopeId) {
    sendError(res, 403, 'Forbidden');
    return;
  }
  const deleted = store.softDelete(id);
  if (!deleted) {
    sendError(res, 404, `File "${id}" not found`);
    return;
  }
  sendJson(res, 200, { id, deleted: true });
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

const FILES_BASE  = /^\/v1\/files\/?$/;
const FILE_ID_RE  = /^\/v1\/files\/([^/]+)\/?$/;
const CONTENT_RE  = /^\/v1\/files\/([^/]+)\/content\/?$/;

/**
 * Register all /v1/files routes on a raw node:http Server.
 * Non-matching paths fall through silently to other listeners.
 */
export function registerFileRoutes(server: HttpServer, store: FileStore): void {
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const urlPath = (req.url ?? '/').split('?')[0]!;
    const method  = (req.method ?? 'GET').toUpperCase();

    // Path gate — fall through for anything outside /v1/files
    if (!urlPath.startsWith('/v1/files')) return;

    // Auth gate
    if (!isAuthorised(req)) {
      sendError(res, 401, 'Unauthorized');
      return;
    }

    // POST /v1/files
    if (method === 'POST' && FILES_BASE.test(urlPath)) {
      handleUpload(req, res, store).catch((err) => {
        log.error({ err: String(err) }, 'unhandled upload error');
        if (!res.headersSent) sendError(res, 500, 'Internal server error');
      });
      return;
    }

    // GET /v1/files
    if (method === 'GET' && FILES_BASE.test(urlPath)) {
      handleList(req, res, store);
      return;
    }

    // GET /v1/files/:id/content
    const contentMatch = CONTENT_RE.exec(urlPath);
    if (method === 'GET' && contentMatch) {
      handleGetContent(req, res, store, contentMatch[1]!);
      return;
    }

    // GET /v1/files/:id
    // DELETE /v1/files/:id
    const idMatch = FILE_ID_RE.exec(urlPath);
    if (idMatch) {
      if (method === 'GET') {
        handleGetMeta(req, res, store, idMatch[1]!);
        return;
      }
      if (method === 'DELETE') {
        handleDelete(req, res, store, idMatch[1]!);
        return;
      }
    }

    // Fall through — not our route
  });

  log.info('File routes registered: POST/GET /v1/files, GET/DELETE /v1/files/:id, GET /v1/files/:id/content');
}
