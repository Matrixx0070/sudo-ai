/**
 * @file tests/memory/embeddings-circuit.test.ts
 * @description Covers the embedding quota circuit-breaker (B8.1). Asserts:
 * N consecutive terminal-429s OPEN the circuit; while open, callers fail fast
 * WITHOUT touching the network; after the cooldown a single probe call is let
 * through and a success CLOSES the circuit; an intervening success resets the
 * consecutive-429 counter; and SUDO_EMBED_CIRCUIT=0 disables the breaker.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import { mkdirSync, rmSync } from 'fs';
import { MindDB } from '../../src/core/memory/db.js';
import { EmbeddingService, __resetEmbedCircuit } from '../../src/core/memory/embeddings.js';

let tmpDir: string;
let db: MindDB;
const ENV_KEYS = [
  'OPENAI_API_KEY',
  'SUDO_EMBED_BACKOFF',
  'SUDO_EMBED_CIRCUIT',
  'SUDO_EMBED_CIRCUIT_THRESHOLD',
  'SUDO_EMBED_CIRCUIT_COOLDOWN_MS',
] as const;
const saved: Record<string, string | undefined> = {};

function okResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }),
    text: async () => '',
  } as unknown as Response;
}

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
  tmpDir = path.join(os.tmpdir(), `embed-circuit-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  db = new MindDB(path.join(tmpDir, 'mind.db'));
  process.env['OPENAI_API_KEY'] = 'test-key';
  // Single attempt per call → each terminal 429 is one circuit hit (deterministic).
  process.env['SUDO_EMBED_BACKOFF'] = '0';
  process.env['SUDO_EMBED_CIRCUIT_THRESHOLD'] = '3';
  process.env['SUDO_EMBED_CIRCUIT_COOLDOWN_MS'] = '600000';
  delete process.env['SUDO_EMBED_CIRCUIT'];
  __resetEmbedCircuit();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  __resetEmbedCircuit();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

/** Embed unique strings so the cache never short-circuits the fetch. */
async function expectFails(svc: EmbeddingService, text: string): Promise<void> {
  await expect(svc.embed(text)).rejects.toThrow();
}

describe('EmbeddingService quota circuit-breaker', () => {
  it('opens after N consecutive terminal-429s; then fails fast without calling fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errResponse(429));
    vi.stubGlobal('fetch', fetchMock);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const svc = new EmbeddingService(db);
    // 3 terminal 429s (threshold) → circuit opens. Unique texts dodge the cache.
    await expectFails(svc, 'q-1');
    await expectFails(svc, 'q-2');
    await expectFails(svc, 'q-3');
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // 4th call: circuit OPEN → fast-fail, fetch NOT called again.
    await expect(svc.embed('q-4')).rejects.toThrow(/circuit OPEN/);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Logged exactly once (one warn per outage episode).
    const opens = warnSpy.mock.calls.filter((c) => String(c[0]).includes('circuit OPEN'));
    expect(opens.length).toBe(1);
  });

  it('lets a probe through after the cooldown, and a success closes the circuit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-26T00:00:00Z'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const fetchMock = vi.fn().mockResolvedValue(errResponse(429));
    vi.stubGlobal('fetch', fetchMock);

    const svc = new EmbeddingService(db);
    await expectFails(svc, 'c-1');
    await expectFails(svc, 'c-2');
    await expectFails(svc, 'c-3');
    expect(fetchMock).toHaveBeenCalledTimes(3); // open now

    // Still inside cooldown → fast-fail, no new fetch.
    await expect(svc.embed('c-4')).rejects.toThrow(/circuit OPEN/);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Advance past the cooldown → the next call is allowed through (probe).
    vi.setSystemTime(new Date('2026-06-26T00:11:00Z')); // +11 min > 10 min cooldown
    fetchMock.mockResolvedValue(okResponse());
    const vec = await svc.embed('c-probe');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(fetchMock).toHaveBeenCalledTimes(4); // probe hit the API

    // Circuit closed after success: subsequent calls proceed normally.
    await svc.embed('c-after');
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('an intervening success resets the consecutive-429 counter', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(errResponse(429)) // s-1
      .mockResolvedValueOnce(errResponse(429)) // s-2
      .mockResolvedValueOnce(okResponse())     // s-3 success → reset
      .mockResolvedValueOnce(errResponse(429)) // s-4
      .mockResolvedValueOnce(errResponse(429)) // s-5
      .mockResolvedValue(okResponse());        // s-6 would-be probe (still closed)
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const svc = new EmbeddingService(db);
    await expectFails(svc, 's-1');
    await expectFails(svc, 's-2');
    await svc.embed('s-3');             // success resets counter to 0
    await expectFails(svc, 's-4');
    await expectFails(svc, 's-5');
    // Only 2 consecutive 429s since the reset (< threshold 3) → circuit still closed.
    const vec = await svc.embed('s-6');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(fetchMock).toHaveBeenCalledTimes(6); // every call reached the network
  });

  it('SUDO_EMBED_CIRCUIT=0 disables the breaker (keeps hitting the API)', async () => {
    process.env['SUDO_EMBED_CIRCUIT'] = '0';
    const fetchMock = vi.fn().mockResolvedValue(errResponse(429));
    vi.stubGlobal('fetch', fetchMock);

    const svc = new EmbeddingService(db);
    await expectFails(svc, 'd-1');
    await expectFails(svc, 'd-2');
    await expectFails(svc, 'd-3');
    await expectFails(svc, 'd-4'); // would be fast-fail if circuit were enabled
    expect(fetchMock).toHaveBeenCalledTimes(4); // all four reached the network
  });
});
