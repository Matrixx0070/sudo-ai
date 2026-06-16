/**
 * @file recon.test.ts
 * @description Tests for the arsenal-v2 file discovery + ranking.
 *
 * Tests run against a freshly-mkdtemp'd project root with seeded files so
 * the behaviour is fully deterministic. The ripgrep search path is skipped
 * by ensuring no keywords match the seeded content; the walk-fallback path
 * is what gets exercised.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { recon, extractKeywords } from '../../../../src/core/tools/builtin/coder/arsenal-v2/recon.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'arsenal-v2-recon-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seed(rel: string, content: string): Promise<void> {
  const abs = path.join(root, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

describe('extractKeywords', () => {
  it('drops stopwords and short tokens, keeps content words', () => {
    expect(extractKeywords('fix the auth token rotation bug')).toEqual(['auth', 'token', 'rotation']);
  });
  it('caps at 10 tokens', () => {
    const task = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november';
    expect(extractKeywords(task)).toHaveLength(10);
  });
  it('dedupes case-insensitively', () => {
    expect(extractKeywords('Auth auth AUTH token Token')).toEqual(['auth', 'token']);
  });
  it('returns empty for stopword-only input', () => {
    expect(extractKeywords('the and for are')).toEqual([]);
  });
});

describe('recon — explicit file refs', () => {
  it('includes files named in the task even if recon would otherwise skip them', async () => {
    await seed('src/foo.ts', 'export const x = 1;\n');
    await seed('src/bar.ts', 'export const y = 2;\n');
    const r = await recon('fix bug in src/foo.ts', { projectRoot: root, searchRoot: root });
    expect(r.files).toContain('src/foo.ts');
  });
  it('skips explicit refs that do not exist', async () => {
    await seed('src/real.ts', 'a');
    const r = await recon('fix bug in src/imaginary.ts', { projectRoot: root, searchRoot: root });
    expect(r.files).not.toContain('src/imaginary.ts');
  });
});

describe('recon — caps', () => {
  it('respects maxFiles', async () => {
    for (let i = 0; i < 50; i += 1) await seed(`src/f${i}.ts`, `// file ${i}\n`);
    const r = await recon('refactor', { projectRoot: root, searchRoot: root, maxFiles: 5 });
    expect(r.files.length).toBeLessThanOrEqual(5);
  });
  it('respects maxFileBytes — huge individual files are skipped', async () => {
    await seed('src/huge.ts', 'a'.repeat(80_000));
    await seed('src/small.ts', '// small\n');
    const r = await recon('refactor', {
      projectRoot: root,
      searchRoot: root,
      maxFileBytes: 50_000,
    });
    expect(r.files).not.toContain('src/huge.ts');
    expect(r.files).toContain('src/small.ts');
  });
  it('respects maxTotalBytes', async () => {
    for (let i = 0; i < 10; i += 1) await seed(`src/m${i}.ts`, 'x'.repeat(8_000));
    const r = await recon('refactor', {
      projectRoot: root,
      searchRoot: root,
      maxTotalBytes: 25_000,
    });
    expect(r.totalBytes).toBeLessThanOrEqual(25_000 + 1000); // +1K margin for fenced wrapping
    expect(r.truncationReason).toBe('max_total_bytes');
  });
});

describe('recon — skip rules', () => {
  it('skips node_modules and dist directories', async () => {
    await seed('src/real.ts', 'a');
    await seed('node_modules/some-dep/index.ts', 'b');
    await seed('dist/built.ts', 'c');
    const r = await recon('refactor', { projectRoot: root, searchRoot: root });
    expect(r.files.some((f) => f.includes('node_modules'))).toBe(false);
    expect(r.files.some((f) => f.startsWith('dist/'))).toBe(false);
  });
});

describe('recon — payload shape', () => {
  it('wraps each file in a fenced markdown block', async () => {
    await seed('src/foo.ts', 'export const x = 1;\n');
    const r = await recon('fix src/foo.ts', { projectRoot: root, searchRoot: root });
    expect(r.payload).toContain('### src/foo.ts\n```\nexport const x = 1;\n\n```\n');
  });
});
