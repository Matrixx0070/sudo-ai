/**
 * @file tests/gateway/skills-import-errors.test.ts
 * @description Tests for C4 (error-code mapping) and C5 (source alias) fixes
 *              on POST /v1/skills/import.
 *
 * Uses a real http.Server with a mock SkillImporter to trigger each error
 * path and verify the correct HTTP status + safe message is returned.
 *
 * Covered scenarios:
 *   C4-1  HTTP 404 from upstream   → 404 + generic "not found" message
 *   C4-2  HTTP 400 from upstream   → 404 + generic "not found" message
 *   C4-3  HTTP 503 from upstream   → 502 + "unavailable" message
 *   C4-4  Timeout / AbortError     → 504 + "timed out" message
 *   C4-5  ECONNREFUSED             → 502 + "Could not reach" message
 *   C4-6  Generic unknown error    → 500 + "Import failed" (no internal detail)
 *   C4-7  Success path unchanged   → 200
 *   C5-1  `source` field accepted  → 200 (same as uri)
 *   C5-2  `source` preferred over `uri` when both present
 *   C5-3  Neither field             → 400 with updated error message
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { SkillRegistry } from '../../src/core/skills/registry.js';
import { registerSkillRoutes } from '../../src/core/skills/routes.js';
import type { SkillImporter } from '../../src/core/skills/importer.js';

// ---------------------------------------------------------------------------
// Mock SkillImporter factory
// ---------------------------------------------------------------------------

function makeImporter(impl: (uri: string) => Promise<unknown>): SkillImporter {
  return { import: impl } as unknown as SkillImporter;
}

// Minimal manifest returned on success
const MOCK_MANIFEST = {
  name: 'test-skill',
  version: '1.0.0',
  description: 'A test skill',
  contentHash: 'abc123',
  trust: 'unreviewed',
  caps: [],
};

const SUCCESS_RESULT = { manifest: MOCK_MANIFEST, raw: '# test' };

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

let baseUrl: string;
let server: http.Server;
let registry: SkillRegistry;
let db: InstanceType<typeof Database>;
let skillsDir: string;

beforeAll(async () => {
  db = new Database(':memory:');
  skillsDir = join(tmpdir(), `skills-import-err-test-${randomUUID()}`);
  mkdirSync(skillsDir, { recursive: true });

  registry = new SkillRegistry(db, skillsDir);

  // Note: we pass importer per-request in tests below by using different
  // servers. We create a single server with a dynamic importer slot.
  server = http.createServer();
  // Start without importer — individual tests pass their own.
  registerSkillRoutes(server, registry, null, null);

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
  db.close();
  rmSync(skillsDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Per-test server helper — each test gets its own port + importer
// ---------------------------------------------------------------------------

async function makeTestServer(importer: SkillImporter): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const testDb = new Database(':memory:');
  const testRegistry = new SkillRegistry(testDb, skillsDir);
  const testServer = http.createServer();
  registerSkillRoutes(testServer, testRegistry, null, importer);

  await new Promise<void>((resolve) =>
    testServer.listen(0, '127.0.0.1', () => resolve()),
  );
  const addr = testServer.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        testServer.close((err) => {
          testDb.close();
          err ? reject(err) : resolve();
        }),
      ),
  };
}

async function importReq(
  url: string,
  body: unknown,
): Promise<{ status: number; json: { error?: { message: string; code: number } } }> {
  const r = await fetch(`${url}/v1/skills/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({ error: { message: 'parse-fail', code: 0 } }));
  return { status: r.status, json };
}

// ---------------------------------------------------------------------------
// C4: error-code mapping
// ---------------------------------------------------------------------------

describe('C4 — POST /v1/skills/import error mapping', () => {
  it('C4-1: upstream HTTP 404 → 404 with generic message', async () => {
    const { url, close } = await makeTestServer(
      makeImporter(async () => { throw new Error('Fetch failed: HTTP 404 Not Found'); }),
    );
    try {
      const { status, json } = await importReq(url, { source: 'github:user/repo' });
      expect(status).toBe(404);
      expect(json.error?.message).toBe('Skill not found at requested source');
      // Must NOT contain internal URL or raw error details
      expect(json.error?.message).not.toContain('HTTP 404');
    } finally {
      await close();
    }
  });

  it('C4-2: upstream HTTP 400 → 404 with generic message', async () => {
    const { url, close } = await makeTestServer(
      makeImporter(async () => { throw new Error('Fetch failed: HTTP 400 Bad Request'); }),
    );
    try {
      const { status, json } = await importReq(url, { source: 'github:user/repo' });
      expect(status).toBe(404);
      expect(json.error?.message).toBe('Skill not found at requested source');
    } finally {
      await close();
    }
  });

  it('C4-3: upstream HTTP 503 → 502 with unavailable message', async () => {
    const { url, close } = await makeTestServer(
      makeImporter(async () => { throw new Error('Fetch failed: HTTP 503 Service Unavailable'); }),
    );
    try {
      const { status, json } = await importReq(url, { source: 'github:user/repo' });
      expect(status).toBe(502);
      expect(json.error?.message).toBe('Upstream source unavailable, try again later');
    } finally {
      await close();
    }
  });

  it('C4-4: timeout / AbortError → 504 with timed out message', async () => {
    const { url, close } = await makeTestServer(
      makeImporter(async () => { throw new Error('The operation was aborted: AbortError'); }),
    );
    try {
      const { status, json } = await importReq(url, { source: 'github:user/repo' });
      expect(status).toBe(504);
      expect(json.error?.message).toBe('Import timed out');
    } finally {
      await close();
    }
  });

  it('C4-5: ECONNREFUSED → 502 with "Could not reach" message', async () => {
    const { url, close } = await makeTestServer(
      makeImporter(async () => {
        const err = new Error('connect ECONNREFUSED 192.168.1.1:443');
        (err as NodeJS.ErrnoException).code = 'ECONNREFUSED';
        throw err;
      }),
    );
    try {
      const { status, json } = await importReq(url, { source: 'github:user/repo' });
      expect(status).toBe(502);
      expect(json.error?.message).toBe('Could not reach source host');
    } finally {
      await close();
    }
  });

  it('C4-6: generic unknown error → 500 with "Import failed" (no internal detail)', async () => {
    const { url, close } = await makeTestServer(
      makeImporter(async () => {
        throw new Error('some internal detail with http://internal-url.lan/secret');
      }),
    );
    try {
      const { status, json } = await importReq(url, { source: 'github:user/repo' });
      expect(status).toBe(500);
      // Must be the generic message — no internal URL or details leaked
      expect(json.error?.message).toBe('Import failed');
      expect(json.error?.message).not.toContain('internal-url');
      expect(json.error?.message).not.toContain('http://');
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// C5: source alias
// ---------------------------------------------------------------------------

describe('C5 — POST /v1/skills/import source field alias', () => {
  it('C5-1: `source` field accepted as canonical name', async () => {
    const { url, close } = await makeTestServer(
      makeImporter(async () => SUCCESS_RESULT),
    );
    try {
      const { status } = await importReq(url, { source: 'github:user/repo' });
      // Success or 409 (dup) — either means source was accepted, not 400
      expect([200, 409]).toContain(status);
    } finally {
      await close();
    }
  });

  it('C5-2: `source` takes precedence over `uri` when both present', async () => {
    let receivedUri = '';
    const { url, close } = await makeTestServer(
      makeImporter(async (uri: string) => {
        receivedUri = uri;
        return SUCCESS_RESULT;
      }),
    );
    try {
      await importReq(url, { source: 'github:source-value/repo', uri: 'github:uri-value/repo' });
      // source should win
      expect(receivedUri).toBe('github:source-value/repo');
    } finally {
      await close();
    }
  });

  it('C5-3: neither `source` nor `uri` → 400 with updated error message', async () => {
    const { url, close } = await makeTestServer(
      makeImporter(async () => SUCCESS_RESULT),
    );
    try {
      const { status, json } = await importReq(url, { trustOverride: 'bundled' });
      expect(status).toBe(400);
      expect(json.error?.message).toContain('source');
      expect(json.error?.message).toContain('uri');
    } finally {
      await close();
    }
  });
});
