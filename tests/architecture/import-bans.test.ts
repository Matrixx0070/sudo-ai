/**
 * GW-12: generic import-ban ratchet. One table of {name, fromDirs, pattern}
 * replaces per-invariant bespoke tests (the gdrive hot-path test was the first
 * of these). A banned import anywhere under fromDirs fails CI, not review.
 *
 * The pure core (findOffenders) is unit-tested against fixtures so we know the
 * check itself actually catches a planted violation.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

interface ImportBan {
  name: string;
  fromDirs: string[];
  /** Regex a source line must NOT match (import specifier). */
  pattern: RegExp;
}

/**
 * Hot-path + layering bans. Each is currently GREEN — this table is a ratchet
 * that keeps them green. Extend it, never loosen it.
 */
const BANS: ImportBan[] = [
  {
    name: 'hot-path must not import core/gdrive',
    fromDirs: ['src/core/agent', 'src/llm', 'src/core/memory', 'src/core/brain'],
    pattern: /(from|import\s*\()\s*['"][^'"]*\/gdrive\//,
  },
  {
    name: 'hot-path must not import core/notebooklm',
    fromDirs: ['src/core/agent', 'src/llm', 'src/core/memory', 'src/core/brain'],
    pattern: /(from|import\s*\()\s*['"][^'"]*\/notebooklm\//,
  },
  {
    name: 'channels must not import the LLM transport directly',
    fromDirs: ['src/core/channels'],
    pattern: /(from|import\s*\()\s*['"][^'"]*\/llm\/transport/,
  },
];

function* walk(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|mts)$/.test(entry)) yield p;
  }
}

/** Pure core: files whose text matches the banned pattern. */
export function findOffenders(files: Array<{ path: string; text: string }>, pattern: RegExp): string[] {
  return files.filter((f) => pattern.test(f.text)).map((f) => f.path);
}

describe('GW-12 import bans (source tree)', () => {
  for (const ban of BANS) {
    it(ban.name, () => {
      const files: Array<{ path: string; text: string }> = [];
      for (const dir of ban.fromDirs) {
        for (const file of walk(dir)) files.push({ path: file, text: readFileSync(file, 'utf8') });
      }
      expect(files.length).toBeGreaterThan(0); // guard: dirs exist / globs resolve
      expect(findOffenders(files, ban.pattern)).toEqual([]);
    });
  }
});

describe('GW-12 import-ban checker catches a planted violation', () => {
  const pattern = /(from|import\s*\()\s*['"][^'"]*\/gdrive\//;
  it('flags a fixture that imports the banned path', () => {
    const fixtures = [
      { path: 'clean.ts', text: "import { x } from '../shared/util.js';" },
      { path: 'bad.ts', text: "import { mirror } from '../gdrive/mirror.js';" },
      { path: 'bad-dynamic.ts', text: "const m = await import('../gdrive/runtime.js');" },
    ];
    expect(findOffenders(fixtures, pattern).sort()).toEqual(['bad-dynamic.ts', 'bad.ts']);
  });
  it('passes a clean fixture set', () => {
    const fixtures = [{ path: 'a.ts', text: "import { y } from '../llm/client.js';" }];
    expect(findOffenders(fixtures, pattern)).toEqual([]);
  });
});
