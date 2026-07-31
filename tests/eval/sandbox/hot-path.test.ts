/**
 * ADR-0007 platform invariant 6 (same pattern as tests/gdrive/hot-path.test.ts):
 * nothing in the agent loop, LLM transport, memory, or brain imports the eval
 * sandbox. The only sanctioned consumer outside src/core/eval is the
 * ToolRegistry choke point (src/core/tools) — same exception as rewind.
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

describe('eval-sandbox hot-path isolation', () => {
  it('no hot-path module imports from core/eval/sandbox', () => {
    const offenders: string[] = [];
    for (const dir of HOT_PATH_DIRS) {
      for (const file of walk(dir)) {
        const src = readFileSync(file, 'utf-8');
        if (/from\s+['"][^'"]*\/eval\/sandbox(\/|\.js|['"])/.test(src)
          || /import\s*\(\s*['"][^'"]*\/eval\/sandbox(\/|\.js|['"])/.test(src)) {
          offenders.push(file);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
