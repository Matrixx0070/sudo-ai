/**
 * @file auto-dream-evergreen.test.ts
 * @description Phase-2 EVERGREEN sentinel: durable facts get is_evergreen=1
 * (temporal-decay exemption) with the sentinel stripped before storage.
 * Motivation: 0 of 649 corpus facts were evergreen, so decay half-lived
 * everything — measured as the bulk of the RAG recall gap (2026-07-31).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { MindDB } from '../../src/core/memory/db.js';
import { AutoDream, EVERGREEN_SENTINEL } from '../../src/core/memory/auto-dream.js';

let tmpDir: string;
let mind: MindDB;

beforeEach(() => {
  tmpDir = path.join(os.tmpdir(), `dream-evergreen-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
  mind = new MindDB(path.join(tmpDir, 'mind.db'));
});

afterEach(() => {
  mind.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function synthesize(brainJson: string): Promise<number> {
  const dream = new AutoDream(async () => brainJson, mind.db, undefined, undefined);
  return (dream as unknown as {
    _synthesize(m: Array<{ role: string; content: string }>): Promise<number>;
  })._synthesize([{ role: 'user', content: 'transcript line' }]);
}

describe('AutoDream Phase-2 EVERGREEN sentinel', () => {
  it('stores a sentinel-prefixed fact as evergreen with the prefix stripped', async () => {
    const stored = await synthesize(
      `["${EVERGREEN_SENTINEL}user prefers terse replies", "spend was $4 on the 23rd"]`,
    );
    expect(stored).toBe(2);
    const rows = mind.db
      .prepare("SELECT text, is_evergreen FROM chunks WHERE path = 'memory/auto-dream' ORDER BY id")
      .all() as Array<{ text: string; is_evergreen: number }>;
    expect(rows).toEqual([
      { text: 'user prefers terse replies', is_evergreen: 1 },
      { text: 'spend was $4 on the 23rd', is_evergreen: 0 },
    ]);
  });

  it('a fact that merely mentions the word evergreen is NOT marked durable', async () => {
    await synthesize('["the evergreen tree config option is unrelated"]');
    const row = mind.db
      .prepare("SELECT is_evergreen FROM chunks WHERE path = 'memory/auto-dream'")
      .get() as { is_evergreen: number };
    expect(row.is_evergreen).toBe(0);
  });

  it('a sentinel with nothing after it stores no empty fact', async () => {
    const stored = await synthesize(`["${EVERGREEN_SENTINEL}"]`);
    expect(stored).toBe(0);
  });
});
