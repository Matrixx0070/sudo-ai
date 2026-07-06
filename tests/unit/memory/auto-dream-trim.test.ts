/**
 * Guards trimMemoryToFit — the rolling-buffer trim that lets _promoteToMemoryMd
 * keep saving learnings when MEMORY.md hits its 50KB cap (instead of silently
 * dropping new facts). Drops the OLDEST dated entries, keeps the header + newest.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trimMemoryToFit, needsPreAppendTrim, AutoDream } from '../../../src/core/memory/auto-dream.js';

function build(n: number): string {
  let s = '# Long-Term Memory\n\n';
  for (let i = 0; i < n; i++) {
    s += `- [2026-06-${String((i % 28) + 1).padStart(2, '0')}] fact number ${i} ${'x'.repeat(40)}\n`;
  }
  return s;
}

describe('trimMemoryToFit', () => {
  it('leaves content already under the target untouched', () => {
    const c = build(3);
    const { kept, trimmed } = trimMemoryToFit(c, 50 * 1024);
    expect(trimmed).toEqual([]);
    expect(kept).toBe(c); // already ends in a single newline
  });

  it('drops the OLDEST entries to fit, keeping the header + newest', () => {
    const c = build(100);
    const target = 2000;
    const { kept, trimmed } = trimMemoryToFit(c, target);

    expect(Buffer.byteLength(kept, 'utf-8')).toBeLessThanOrEqual(target);
    expect(kept.startsWith('# Long-Term Memory')).toBe(true);
    expect(trimmed.length).toBeGreaterThan(0);
    // oldest (fact 0) trimmed away; newest (fact 99) retained
    expect(trimmed.some((l) => l.includes('fact number 0 '))).toBe(true);
    expect(kept).toContain('fact number 99 ');
    expect(kept).not.toContain('fact number 0 ');
  });

  it('returns content unchanged when there are no dated entries to drop', () => {
    const c = '# Long-Term Memory\n\njust prose, no entries\n';
    const { kept, trimmed } = trimMemoryToFit(c, 10);
    expect(trimmed).toEqual([]);
    expect(kept).toBe(c);
  });

  it('keeps at least one entry even if it alone exceeds the target', () => {
    const big = 'y'.repeat(1000);
    const c = `# H\n\n- [2026-06-01] ${big}\n`;
    const { kept, trimmed } = trimMemoryToFit(c, 10);
    expect(trimmed).toEqual([]); // single entry is never dropped
    expect(kept).toContain(big);
  });
});

describe('AutoDream.healMemoryFileIfOverCap', () => {
  // heal only touches the filesystem; the brain fn + db are never used by it.
  const makeDream = () => new AutoDream(async () => '', {} as never, undefined, undefined);

  it('trims an over-cap MEMORY.md under the cap and archives the trimmed lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'heal-'));
    try {
      let body = '# Long-Term Memory\n\n';
      for (let i = 0; body.length < 55 * 1024; i++) {
        body += `- [2026-06-${String((i % 28) + 1).padStart(2, '0')}] fact ${i} ${'z'.repeat(60)}\n`;
      }
      writeFileSync(join(dir, 'MEMORY.md'), body, 'utf-8');

      const trimmed = makeDream().healMemoryFileIfOverCap(dir);
      expect(trimmed).toBeGreaterThan(0);

      const after = readFileSync(join(dir, 'MEMORY.md'), 'utf-8');
      expect(Buffer.byteLength(after, 'utf-8')).toBeLessThan(50 * 1024);
      expect(after.startsWith('# Long-Term Memory')).toBe(true);
      expect(existsSync(join(dir, 'MEMORY.archive.md'))).toBe(true);
      expect(readFileSync(join(dir, 'MEMORY.archive.md'), 'utf-8')).toContain('- [2026-06');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves an under-cap MEMORY.md untouched (returns 0, no archive)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'heal-'));
    try {
      writeFileSync(join(dir, 'MEMORY.md'), '# Long-Term Memory\n\n- [2026-06-01] small\n', 'utf-8');
      expect(makeDream().healMemoryFileIfOverCap(dir)).toBe(0);
      expect(existsSync(join(dir, 'MEMORY.archive.md'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('needsPreAppendTrim — promotion deadband guard', () => {
  const CAP = 50 * 1024;

  it('fires inside the former deadband (under cap but within headroom)', () => {
    // The live incident: MEMORY.md at 50,973 bytes vs 51,200 cap — under the
    // old >=cap trigger nothing trimmed, and every append broke the loop.
    expect(needsPreAppendTrim(50_973, CAP)).toBe(true);
  });

  it('fires at and above the cap', () => {
    expect(needsPreAppendTrim(CAP, CAP)).toBe(true);
    expect(needsPreAppendTrim(CAP + 1, CAP)).toBe(true);
  });

  it('stays quiet with comfortable room below the headroom band', () => {
    expect(needsPreAppendTrim(40_000, CAP)).toBe(false);
    expect(needsPreAppendTrim(CAP - 4097, CAP)).toBe(false);
  });
});

describe('AutoDream._prune — age-retirement via superseded_by sentinel', () => {
  it('retires old non-evergreen learning chunks and leaves the rest', async () => {
    const { default: BetterSqlite3 } = await import('better-sqlite3');
    const raw = new BetterSqlite3(':memory:');
    raw.exec(`CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL, path TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'conversation',
      hash TEXT NOT NULL UNIQUE,
      is_evergreen INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      superseded_by INTEGER, superseded_at TEXT
    )`);
    const old = new Date(Date.now() - 45 * 86_400_000).toISOString();
    const fresh = new Date().toISOString();
    const ins = raw.prepare(
      `INSERT INTO chunks (text, source, hash, is_evergreen, created_at, superseded_by)
       VALUES (:text, :source, :hash, :eg, :at, :sup)`,
    );
    ins.run({ text: 'old learning', source: 'learning', hash: 'h1', eg: 0, at: old, sup: null });   // → pruned
    ins.run({ text: 'old evergreen', source: 'learning', hash: 'h2', eg: 1, at: old, sup: null });  // kept (evergreen)
    ins.run({ text: 'fresh learning', source: 'learning', hash: 'h3', eg: 0, at: fresh, sup: null });// kept (young)
    ins.run({ text: 'old conversation', source: 'conversation', hash: 'h4', eg: 0, at: old, sup: null }); // kept (not learning)
    ins.run({ text: 'already superseded', source: 'learning', hash: 'h5', eg: 0, at: old, sup: 42 }); // untouched

    const dream = new AutoDream(async () => '', raw, undefined, undefined);
    const pruned = dream['_prune']();

    expect(pruned).toBe(1);
    const rows = raw.prepare('SELECT hash, superseded_by FROM chunks ORDER BY id').all() as Array<{ hash: string; superseded_by: number | null }>;
    expect(rows.find((r) => r.hash === 'h1')?.superseded_by).toBe(AutoDream.PRUNED_BY_AGE_SENTINEL);
    expect(rows.find((r) => r.hash === 'h2')?.superseded_by).toBeNull();
    expect(rows.find((r) => r.hash === 'h3')?.superseded_by).toBeNull();
    expect(rows.find((r) => r.hash === 'h4')?.superseded_by).toBeNull();
    expect(rows.find((r) => r.hash === 'h5')?.superseded_by).toBe(42);
    raw.close();
  });
});
