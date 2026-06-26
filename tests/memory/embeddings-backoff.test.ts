/**
 * @file tests/memory/embeddings-backoff.test.ts
 * @description Covers the transient-failure backoff added to EmbeddingService
 * (B4.2 / NP.4). Asserts: a 429 followed by a 200 retries then returns the
 * embedding; a persistent 429 gives up after the bounded attempts and throws
 * the SAME error as the pre-backoff code; the success path makes exactly one
 * call; and SUDO_EMBED_BACKOFF=0 restores single-attempt behaviour.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import { mkdirSync, rmSync } from 'fs';
import { MindDB } from '../../src/core/memory/db.js';
import { EmbeddingService } from '../../src/core/memory/embeddings.js';

let tmpDir: string;
let db: MindDB;
const ENV_KEYS = ['OPENAI_API_KEY', 'SUDO_EMBED_BACKOFF', 'SUDO_EMBED_BACKOFF_BASE_MS'] as const;
const saved: Record<string, string | undefined> = {};

/** A 200 response carrying one 1536-ish embedding (length irrelevant here). */
function okResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }),
    text: async () => '',
  } as unknown as Response;
}

/** A non-ok response with the given status. */
function errResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => `rate limited (${status})`,
  } as unknown as Response;
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  tmpDir = path.join(os.tmpdir(), `embed-backoff-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  db = new MindDB(path.join(tmpDir, 'mind.db'));
  process.env['OPENAI_API_KEY'] = 'test-key';
  process.env['SUDO_EMBED_BACKOFF_BASE_MS'] = '1'; // keep retries near-instant
  delete process.env['SUDO_EMBED_BACKOFF'];
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

describe('EmbeddingService transient-failure backoff', () => {
  it('retries a 429 then returns the embedding on the subsequent 200', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(errResponse(429))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    const svc = new EmbeddingService(db);
    const vec = await svc.embed('hello world');

    expect(vec).toBeInstanceOf(Float32Array);
    expect(Array.from(vec!)).toEqual([0.1, 0.2, 0.3].map((n) => new Float32Array([n])[0]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a 5xx then succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(errResponse(503))
      .mockResolvedValueOnce(errResponse(500))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    const svc = new EmbeddingService(db);
    const vec = await svc.embed('retry me');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries a network throw then succeeds', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    const svc = new EmbeddingService(db);
    const vec = await svc.embed('network blip');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after the bounded attempts on persistent 429 and throws the same error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errResponse(429));
    vi.stubGlobal('fetch', fetchMock);

    const svc = new EmbeddingService(db);
    await expect(svc.embed('always limited')).rejects.toThrow(/API error 429/);
    // BACKOFF_MAX_ATTEMPTS = 4
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('makes exactly one call on the success path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    const svc = new EmbeddingService(db);
    const vec = await svc.embed('first try');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('SUDO_EMBED_BACKOFF=0 disables retries (single attempt, fails immediately)', async () => {
    process.env['SUDO_EMBED_BACKOFF'] = '0';
    const fetchMock = vi.fn().mockResolvedValue(errResponse(429));
    vi.stubGlobal('fetch', fetchMock);

    const svc = new EmbeddingService(db);
    await expect(svc.embed('no retries')).rejects.toThrow(/API error 429/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
