/**
 * Route integration tests for /v1/files endpoints (Wave 5 P2)
 *
 * Uses a real http.Server on a random port.
 * In-memory SQLite + $TMPDIR for full request/response testing.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { FileStore, computeSha256 } from '../../src/core/files/store.js';
import { registerFileRoutes } from '../../src/core/files/routes.js';

// ---------------------------------------------------------------------------
// Test server setup
// ---------------------------------------------------------------------------

let baseUrl: string;
let server: http.Server;
let store: FileStore;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'files-routes-test-'));
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  store = new FileStore(db, tmpDir);

  server = http.createServer();
  registerFileRoutes(server, store);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal multipart/form-data body for a single file. */
function buildMultipart(
  boundary: string,
  filename: string,
  mimeType: string,
  data: Buffer,
): Buffer {
  const header = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    `Content-Type: ${mimeType}`,
    '',
    '',
  ].join('\r\n');

  const footer = `\r\n--${boundary}--\r\n`;

  return Buffer.concat([
    Buffer.from(header),
    data,
    Buffer.from(footer),
  ]);
}

async function upload(
  filename: string,
  mimeType: string,
  data: Buffer,
  scopeId = 'sesn_routetest',
): Promise<{ status: number; json: unknown }> {
  const boundary = `boundary${Date.now()}`;
  const body = buildMultipart(boundary, filename, mimeType, data);

  const res = await fetch(`${baseUrl}/v1/files`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'X-Scope-Id': scopeId,
    },
    body,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function req(
  method: string,
  urlPath: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; json: unknown; headers?: Headers }> {
  const opts: RequestInit = { method };
  const headers: Record<string, string> = { ...(extraHeaders ?? {}) };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  if (Object.keys(headers).length > 0) opts.headers = headers;
  const r = await fetch(`${baseUrl}${urlPath}`, opts);
  const json = await r.json().catch(() => null);
  return { status: r.status, json, headers: r.headers };
}

function makePdfBuffer(): Buffer {
  return Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34, 0x20, 0x0A]); // %PDF-1.4
}

function makeTextBuffer(): Buffer {
  return Buffer.from('hello world');
}

// ---------------------------------------------------------------------------
// POST /v1/files — upload
// ---------------------------------------------------------------------------

describe('POST /v1/files', () => {
  it('rejects missing X-Scope-Id header', async () => {
    const boundary = `b${Date.now()}`;
    const body = buildMultipart(boundary, 'f.txt', 'text/plain', makeTextBuffer());
    const res = await fetch(`${baseUrl}/v1/files`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(res.status).toBe(400);
  });

  it('rejects non-multipart content-type', async () => {
    const res = await fetch(`${baseUrl}/v1/files`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Scope-Id': 'sesn_test',
      },
      body: JSON.stringify({ file: 'data' }),
    });
    expect(res.status).toBe(400);
  });

  it('uploads text file and returns 201 with metadata', async () => {
    const { status, json } = await upload('notes.txt', 'text/plain', makeTextBuffer());
    expect(status).toBe(201);
    const meta = json as Record<string, unknown>;
    expect(meta['id']).toMatch(/^file_/);
    expect(meta['filename']).toBe('notes.txt');
    expect(meta['mime']).toBe('text/plain');
    expect(meta['size_bytes']).toBe(makeTextBuffer().length);
    expect(typeof meta['sha256']).toBe('string');
  });

  it('uploads PDF with correct MIME and returns 201', async () => {
    const pdfBuf = makePdfBuffer();
    const { status, json } = await upload('doc.pdf', 'application/pdf', pdfBuf);
    expect(status).toBe(201);
    const meta = json as Record<string, unknown>;
    expect(meta['mime']).toBe('application/pdf');
  });

  it('rejects MIME mismatch (declared PDF but bytes are text)', async () => {
    const { status } = await upload('fake.pdf', 'application/pdf', makeTextBuffer());
    expect(status).toBe(422);
  });

  it('safely handles path-traversal filename (busboy strips to basename)', async () => {
    // busboy already normalises Content-Disposition filename to basename only.
    // e.g. '../etc/passwd' → 'passwd'. validateFilename then validates the safe basename.
    const boundary = `b${Date.now()}`;
    const data = makeTextBuffer();
    const body = buildMultipart(boundary, '../etc/passwd', 'text/plain', data);
    const res = await fetch(`${baseUrl}/v1/files`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'X-Scope-Id': 'sesn_path',
      },
      body,
    });
    // busboy strips path separators; resulting 'passwd' is a valid filename → 201
    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, unknown>;
    // Confirm the stored filename is the stripped basename, not the full path
    expect(json['filename']).toBe('passwd');
  });
});

// ---------------------------------------------------------------------------
// GET /v1/files — list
// ---------------------------------------------------------------------------

describe('GET /v1/files', () => {
  it('returns empty data array initially for new scope', async () => {
    const { status, json } = await req('GET', '/v1/files?scope_id=sesn_empty');
    expect(status).toBe(200);
    const body = json as Record<string, unknown>;
    expect(body['data']).toEqual([]);
  });

  it('lists uploaded files for scope', async () => {
    const scope = 'sesn_list_test';
    await upload('list1.txt', 'text/plain', Buffer.from('data1'), scope);
    await upload('list2.txt', 'text/plain', Buffer.from('data2'), scope);

    const { status, json } = await req('GET', `/v1/files?scope_id=${scope}`);
    expect(status).toBe(200);
    const body = json as { data: unknown[] };
    expect(body.data).toHaveLength(2);
  });

  it('does not list files from another scope', async () => {
    const scope1 = 'sesn_scope_a';
    const scope2 = 'sesn_scope_b';
    await upload('scoped.txt', 'text/plain', Buffer.from('scoped data'), scope1);

    const { json } = await req('GET', `/v1/files?scope_id=${scope2}`);
    const body = json as { data: unknown[] };
    expect(body.data).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/files/:id — metadata
// ---------------------------------------------------------------------------

describe('GET /v1/files/:id', () => {
  it('returns 404 for unknown id', async () => {
    const { status } = await req('GET', '/v1/files/file_nonexistent', undefined, { 'X-Scope-Id': 'sesn_any' });
    expect(status).toBe(404);
  });

  it('returns metadata for existing file', async () => {
    const { json: uploaded } = await upload('meta.txt', 'text/plain', Buffer.from('meta content'), 'sesn_meta');
    const meta = uploaded as Record<string, unknown>;
    const id = meta['id'] as string;

    const { status, json } = await req('GET', `/v1/files/${id}`, undefined, { 'X-Scope-Id': 'sesn_meta' });
    expect(status).toBe(200);
    const body = json as Record<string, unknown>;
    expect(body['id']).toBe(id);
    expect(body['filename']).toBe('meta.txt');
  });

  it('returns 403 when X-Scope-Id does not match file scope', async () => {
    const { json: uploaded } = await upload('scope-check.txt', 'text/plain', Buffer.from('scope test'), 'sesn_owner');
    const meta = uploaded as Record<string, unknown>;
    const id = meta['id'] as string;

    const { status } = await req('GET', `/v1/files/${id}`, undefined, { 'X-Scope-Id': 'sesn_other' });
    expect(status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/files/:id/content — download
// ---------------------------------------------------------------------------

describe('GET /v1/files/:id/content', () => {
  it('returns 404 for unknown id', async () => {
    const res = await fetch(`${baseUrl}/v1/files/file_ghost/content`, {
      headers: { 'X-Scope-Id': 'sesn_any' },
    });
    expect(res.status).toBe(404);
  });

  it('streams file bytes with correct content-type', async () => {
    const data = Buffer.from('download me please');
    const { json: uploaded } = await upload('download.txt', 'text/plain', data, 'sesn_dl');
    const meta = uploaded as Record<string, unknown>;
    const id = meta['id'] as string;

    const res = await fetch(`${baseUrl}/v1/files/${id}/content`, {
      headers: { 'X-Scope-Id': 'sesn_dl' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');

    const body = Buffer.from(await res.arrayBuffer());
    expect(body.toString()).toBe('download me please');
  });

  it('returns 403 when X-Scope-Id does not match file scope', async () => {
    const data = Buffer.from('secret content');
    const { json: uploaded } = await upload('secret.txt', 'text/plain', data, 'sesn_content_owner');
    const meta = uploaded as Record<string, unknown>;
    const id = meta['id'] as string;

    const res = await fetch(`${baseUrl}/v1/files/${id}/content`, {
      headers: { 'X-Scope-Id': 'sesn_intruder' },
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/files/:id — soft-delete
// ---------------------------------------------------------------------------

describe('DELETE /v1/files/:id', () => {
  it('returns 404 for unknown id', async () => {
    const { status } = await req('DELETE', '/v1/files/file_gone', undefined, { 'X-Scope-Id': 'sesn_any' });
    expect(status).toBe(404);
  });

  it('soft-deletes a file and returns 200', async () => {
    const { json: uploaded } = await upload('todelete.txt', 'text/plain', Buffer.from('delete me'), 'sesn_delete');
    const meta = uploaded as Record<string, unknown>;
    const id = meta['id'] as string;

    const { status, json } = await req('DELETE', `/v1/files/${id}`, undefined, { 'X-Scope-Id': 'sesn_delete' });
    expect(status).toBe(200);
    const body = json as Record<string, unknown>;
    expect(body['deleted']).toBe(true);
    expect(body['id']).toBe(id);
  });

  it('hides file from subsequent GET after delete', async () => {
    const { json: uploaded } = await upload('hidden.txt', 'text/plain', Buffer.from('hide me'), 'sesn_hide');
    const meta = uploaded as Record<string, unknown>;
    const id = meta['id'] as string;

    await req('DELETE', `/v1/files/${id}`, undefined, { 'X-Scope-Id': 'sesn_hide' });

    const { status } = await req('GET', `/v1/files/${id}`, undefined, { 'X-Scope-Id': 'sesn_hide' });
    expect(status).toBe(404);
  });

  it('returns 403 when X-Scope-Id does not match file scope', async () => {
    const { json: uploaded } = await upload('nodeletion.txt', 'text/plain', Buffer.from('mine'), 'sesn_del_owner');
    const meta = uploaded as Record<string, unknown>;
    const id = meta['id'] as string;

    const { status } = await req('DELETE', `/v1/files/${id}`, undefined, { 'X-Scope-Id': 'sesn_del_intruder' });
    expect(status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('Auth — GATEWAY_TOKEN not set', () => {
  it('allows requests without auth header when no token configured', async () => {
    // In test env GATEWAY_TOKEN is not set so all requests are allowed
    const { status } = await req('GET', '/v1/files');
    expect(status).toBe(200);
  });
});
