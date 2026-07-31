/**
 * @file hybrid-search-session-meta.test.ts
 * @description Session-metadata JSON blobs (path session:<id>:meta) are
 * plumbing read via direct path lookups, never meaningful semantic-search
 * answers. Unexcluded they were ~27% of the FTS corpus, burning BM25
 * candidate slots on JSON key/id noise. hybridSearch must never return them.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import { mkdirSync, rmSync } from 'fs';
import { randomUUID } from 'crypto';
import { MindDB } from '../../src/core/memory/db.js';
import { hybridSearch } from '../../src/core/memory/hybrid-search.js';
import type { EmbeddingService } from '../../src/core/memory/embeddings.js';

const noEmbeddings = { isAvailable: false, embed: async () => null } as unknown as EmbeddingService;
const noLocal = { isAvailable: false, embed: async () => null };

let tmpDir: string;
let mind: MindDB;

beforeEach(() => {
  tmpDir = path.join(os.tmpdir(), `hybrid-meta-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
  mind = new MindDB(path.join(tmpDir, 'mind.db'));
});

afterEach(() => {
  mind.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('hybridSearch — session:<id>:meta exclusion', () => {
  it('never returns session-meta rows, even on an exact keyword hit', async () => {
    mind.storeChunk(
      '{"id":"abc","channel":"telegram","peerId":"cron:isolated:xyz","state":"active"}',
      'session:abc:meta',
      'conversation',
    );
    mind.storeChunk('telegram channel adapter supports markdown replies', 'm/1', 'learning');

    const results = await hybridSearch(
      mind, noEmbeddings, { query: 'telegram channel active', minScore: 0 }, noLocal,
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.chunk.path !== 'session:abc:meta')).toBe(true);
  });

  it('still returns ordinary chunks whose path merely contains "session"', async () => {
    mind.storeChunk('session compaction folds context above the budget', 'learning/session-compaction', 'learning');
    const results = await hybridSearch(
      mind, noEmbeddings, { query: 'session compaction context', minScore: 0 }, noLocal,
    );
    expect(results.some((r) => r.chunk.path === 'learning/session-compaction')).toBe(true);
  });
});
