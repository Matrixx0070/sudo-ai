/**
 * @file oracle-hot-path.test.ts
 * @description GWV4 hot-path guard. The statsig oracle launches a headless
 * browser (heavy, slow, on-demand) and must NEVER sit on the agent hot path.
 * The ReACT loop, retrieval, working memory, and brain must not import it — only
 * the media/CLI seams may. This greps the source tree so a violating import
 * fails CI, not review. Mirrors tests/gdrive/hot-path.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The oracle is a Playwright-launching module; core cognition must never touch it.
const HOT_PATH_DIRS = ['src/core/agent', 'src/core/memory', 'src/core/brain'];
const ORACLE_RE = /['"][^'"]*grok-(?:statsig-oracle|warm-browser)(?:\.js)?['"]/;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|mts)$/.test(entry)) yield p;
  }
}

describe('grok statsig oracle hot-path isolation', () => {
  it('no core cognition module imports grok-statsig-oracle or grok-warm-browser', () => {
    const offenders: string[] = [];
    for (const dir of HOT_PATH_DIRS) {
      for (const file of walk(dir)) {
        const src = readFileSync(file, 'utf-8');
        if (ORACLE_RE.test(src)) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
