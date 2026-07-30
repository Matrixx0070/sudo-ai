/**
 * @file tests/memory/local-ollama-embeddings.test.ts
 * @description Covers the local Ollama embedding lane (2026-07-30): embed()
 * routes ollama/* models to the local OpenAI-compatible endpoint with no
 * Authorization header and no API key requirement; embeddingsAvailable()
 * treats ollama/* as always routable; EmbeddingService defaults to the local
 * model with dims 768 and stays available without OPENAI_API_KEY; the
 * MindDBVectorStore whitelist accepts chunks_vec_768.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import { mkdirSync, rmSync } from 'fs';
import { embed, embeddingsAvailable } from '../../src/llm/client.js';
import { MindDB } from '../../src/core/memory/db.js';
import { EmbeddingService, __resetLocalLane } from '../../src/core/memory/embeddings.js';
import { MindDBVectorStore } from '../../src/core/memory/vector-backfill.js';

const ENV_KEYS = ['OPENAI_API_KEY', 'LLM_BASE_URL', 'SUDO_EMBED_MODEL'] as const;
const saved: Record<string, string | undefined> = {};

function okEmbeddingResponse(dims: number): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: [{ index: 0, embedding: Array.from({ length: dims }, () => 0.01) }],
      model: 'nomic-embed-text',
    }),
    text: async () => '',
  } as unknown as Response;
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  vi.unstubAllGlobals();
});

describe('embed() — ollama local lane', () => {
  it('routes ollama/* to the local endpoint with no Authorization header and no key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEmbeddingResponse(768));
    vi.stubGlobal('fetch', fetchMock);
    // No OPENAI_API_KEY, no gateway — the openai lane would throw here.
    const res = await embed(['hello'], { caller: 'test', purpose: 'test' }, { model: 'ollama/nomic-embed-text' });
    expect(res.embeddings).toHaveLength(1);
    expect(res.embeddings[0]).toHaveLength(768);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('11434');
    expect(String(url)).toContain('/v1/embeddings');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.model).toBe('nomic-embed-text'); // prefix stripped for the wire
  });

  it('openai lane still requires a key (unchanged)', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(
      embed(['hello'], { caller: 'test', purpose: 'test' }, { model: 'openai/text-embedding-3-small' }),
    ).rejects.toThrow(/no API key/);
  });
});

describe('embeddingsAvailable()', () => {
  it('true for ollama/* even with no key and no gateway', () => {
    expect(embeddingsAvailable('ollama/nomic-embed-text')).toBe(true);
  });
  it('false for openai model with no key and no gateway (unchanged)', () => {
    expect(embeddingsAvailable('text-embedding-3-small')).toBe(false);
    expect(embeddingsAvailable()).toBe(false);
  });
});

describe('EmbeddingService — local default', () => {
  let tmpDir: string;
  let db: MindDB;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `sudo-embed-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    db = new MindDB(path.join(tmpDir, 'mind.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('defaults to the local ollama model with dims 768 and is available keyless', () => {
    const svc = new EmbeddingService(db);
    expect(svc.dims).toBe(768);
    expect(svc.isAvailable).toBe(true); // no OPENAI_API_KEY in env
  });

  it('SUDO_EMBED_MODEL=text-embedding-3-small restores the OpenAI lane (dims 1536, key-gated)', () => {
    // DEFAULT_MODEL is read at module load, so pass the model explicitly —
    // the env override is exercised at boot; here we assert the mapping.
    const svc = new EmbeddingService(db, 'text-embedding-3-small');
    expect(svc.dims).toBe(1536);
    expect(svc.isAvailable).toBe(false); // no key in env
  });
});

describe('MindDBVectorStore — chunks_vec_768 whitelist', () => {
  it('accepts the 768 table and reads/writes it', () => {
    const tmpDir = path.join(os.tmpdir(), `sudo-vec768-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const db = new MindDB(path.join(tmpDir, 'mind.db'));
    try {
      if (!db.vecLoaded) return; // sqlite-vec unavailable in this env — nothing to assert
      const store = new MindDBVectorStore(db.db, 'chunks_vec_768');
      expect(store.existingChunkIds().size).toBe(0);
    } finally {
      db.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('local lane fast-fail (Ollama offline)', () => {
  let tmpDir: string;
  let db: MindDB;

  beforeEach(() => {
    __resetLocalLane();
    tmpDir = path.join(os.tmpdir(), `sudo-ff-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    db = new MindDB(path.join(tmpDir, 'mind.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    __resetLocalLane();
  });

  it('a connection failure fails fast (single attempt, no backoff) and marks the lane offline', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed: ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const svc = new EmbeddingService(db, 'ollama/nomic-embed-text');
    expect(svc.isAvailable).toBe(true);
    const t0 = Date.now();
    await expect(svc.embed('hello')).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(400); // no 500ms+ backoff sleeps
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retries against a dead daemon
    expect(svc.isAvailable).toBe(false); // offline window open — callers degrade instantly
    expect(warnSpy).toHaveBeenCalledTimes(1); // install hint, once per episode
    warnSpy.mockRestore();
  });

  it('a later success closes the offline episode', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed: ECONNREFUSED'))
      .mockResolvedValue(okEmbeddingResponse(768));
    vi.stubGlobal('fetch', fetchMock);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env['SUDO_EMBED_LOCAL_RETRY_MS'] = '0'; // recheck immediately
    try {
      const svc = new EmbeddingService(db, 'ollama/nomic-embed-text');
      await expect(svc.embed('hello')).rejects.toThrow();
      const v = await svc.embed('hello again');
      expect(v).not.toBeNull();
      expect(v!.length).toBe(768);
      expect(svc.isAvailable).toBe(true);
    } finally {
      delete process.env['SUDO_EMBED_LOCAL_RETRY_MS'];
      warnSpy.mockRestore();
    }
  });

  it('openai lane retry behaviour is untouched by the local fast-fail', async () => {
    process.env['OPENAI_API_KEY'] = 'test-key';
    process.env['SUDO_EMBED_BACKOFF_BASE_MS'] = '1';
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const svc = new EmbeddingService(db, 'text-embedding-3-small');
      await expect(svc.embed('hello')).rejects.toThrow();
      expect(fetchMock.mock.calls.length).toBeGreaterThan(1); // still retries
    } finally {
      delete process.env['OPENAI_API_KEY'];
      delete process.env['SUDO_EMBED_BACKOFF_BASE_MS'];
    }
  });
});
