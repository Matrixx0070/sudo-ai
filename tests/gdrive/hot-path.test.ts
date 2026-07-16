/**
 * Prime-directive guard (Drive roadmap invariant 1): zero synchronous Drive
 * calls on the hot path. The agent loop, LLM transport, and retrieval layer
 * must never import anything from src/core/gdrive — Drive I/O is background
 * jobs only. This test greps the actual source tree so a violating import
 * fails CI, not review.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HOT_PATH_DIRS = ['src/core/agent', 'src/llm', 'src/core/memory', 'src/core/brain'];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|mts)$/.test(entry)) yield p;
  }
}

describe('gdrive hot-path isolation', () => {
  it('no hot-path module imports from core/gdrive', () => {
    const offenders: string[] = [];
    for (const dir of HOT_PATH_DIRS) {
      for (const file of walk(dir)) {
        const src = readFileSync(file, 'utf-8');
        if (/from\s+['"][^'"]*\/gdrive\//.test(src) || /import\s*\(\s*['"][^'"]*\/gdrive\//.test(src)) {
          offenders.push(file);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
