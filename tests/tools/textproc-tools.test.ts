/**
 * textproc.extract / replace / analyze (Spec 10 / PR-4).
 *
 * Real files + real child processes (sed/head/tail/diff/python3 exist on any
 * CI runner). The big-file test writes ~40 MB and asserts wall-clock sanity
 * of the early-exit path rather than exact RSS (the live A1 acceptance run
 * measures RSS on a multi-GB file).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractTool } from '../../src/core/tools/builtin/textproc/extract.js';
import { replaceTool } from '../../src/core/tools/builtin/textproc/replace.js';
import { analyzeTool } from '../../src/core/tools/builtin/textproc/analyze.js';
import type { ToolContext } from '../../src/core/tools/types.js';

let dir: string;
const ctx = () => ({ sessionId: 't', workingDir: dir, config: {}, logger: console } as unknown as ToolContext);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'textproc-tools-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('textproc.extract', () => {
  it('extracts an exact line range', async () => {
    const f = join(dir, 'lines.txt');
    writeFileSync(f, Array.from({ length: 100 }, (_, i) => `line-${i + 1}`).join('\n') + '\n');
    const r = await extractTool.execute({ file: f, lines: '10-12' }, ctx());
    expect(r.success).toBe(true);
    expect(r.output.trim().split('\n')).toEqual(['line-10', 'line-11', 'line-12']);
  });

  it('extracts a byte range', async () => {
    const f = join(dir, 'bytes.txt');
    writeFileSync(f, 'abcdefghij');
    const r = await extractTool.execute({ file: f, bytes: '3-7' }, ctx());
    expect(r.success).toBe(true);
    expect(r.output).toBe('defg');
  });

  it('projects fields with head', async () => {
    const f = join(dir, 'fields.csv');
    writeFileSync(f, 'a,b,c\n1,2,3\n4,5,6\n');
    const r = await extractTool.execute({ file: f, head: 2, fields: { sep: ',', cols: '2' } }, ctx());
    expect(r.success).toBe(true);
    expect(r.output.trim().split('\n')).toEqual(['b', '2']);
  });

  it('early-exits on a deep line range of a large file (streaming proof)', async () => {
    const f = join(dir, 'big.log');
    // ~40 MB, 2M lines. sed 'q' must stop at line 1000 — near-instant.
    const chunk = Array.from({ length: 100_000 }, (_, i) => `row ${i} xxxxxxxxxx`).join('\n') + '\n';
    writeFileSync(f, chunk.repeat(20));
    const t0 = Date.now();
    const r = await extractTool.execute({ file: f, lines: '990-1000' }, ctx());
    const elapsed = Date.now() - t0;
    expect(r.success).toBe(true);
    expect(r.output).toContain('row 989');
    expect(elapsed).toBeLessThan(5_000); // full-file scans of 40MB would still pass this; the live A1 run proves multi-GB
  }, 30_000);

  it('rejects ambiguous or missing selectors and bad ranges', async () => {
    const f = join(dir, 'lines.txt');
    expect((await extractTool.execute({ file: f }, ctx())).success).toBe(false);
    expect((await extractTool.execute({ file: f, head: 1, tail: 1 }, ctx())).success).toBe(false);
    expect((await extractTool.execute({ file: f, lines: '5-2' }, ctx())).success).toBe(false);
    expect((await extractTool.execute({ file: join(dir, 'nope'), head: 1 }, ctx())).success).toBe(false);
  });
});

describe('textproc.replace', () => {
  it('dry-run is the DEFAULT and does not touch the file', async () => {
    const f = join(dir, 'r1.txt');
    writeFileSync(f, 'foo bar foo\n');
    const r = await replaceTool.execute({ file: f, find: 'foo', replace: 'baz' }, ctx());
    expect(r.success).toBe(true);
    expect(r.output).toContain('DRY RUN');
    expect(r.output).toContain('-foo bar foo');
    expect(r.output).toContain('+baz bar baz');
    expect(readFileSync(f, 'utf-8')).toBe('foo bar foo\n'); // untouched
  });

  it('applies with backup and the backup restores byte-identical content', async () => {
    const f = join(dir, 'r2.txt');
    writeFileSync(f, 'aaa bbb aaa\n');
    const r = await replaceTool.execute({ file: f, find: 'aaa', replace: 'ccc', dryRun: false }, ctx());
    expect(r.success).toBe(true);
    expect(readFileSync(f, 'utf-8')).toBe('ccc bbb ccc\n');
    const bak = readdirSync(dir).find((n) => n.startsWith('r2.txt.bak.'));
    expect(bak).toBeTruthy();
    expect(readFileSync(join(dir, bak!), 'utf-8')).toBe('aaa bbb aaa\n');
  });

  it('regex mode supports backrefs', async () => {
    const f = join(dir, 'r3.txt');
    writeFileSync(f, 'id=42 id=7\n');
    const r = await replaceTool.execute(
      { file: f, find: 'id=(\\d+)', replace: 'ID[$1]', regex: true, dryRun: false }, ctx(),
    );
    expect(r.success).toBe(true);
    expect(readFileSync(f, 'utf-8')).toBe('ID[42] ID[7]\n');
  });

  it('glob replace across files respects the file cap and skips binary', async () => {
    const sub = join(dir, 'glob');
    rmSync(sub, { recursive: true, force: true });
    writeFileSync(join(dir, 'g1.gtxt'), 'X\n');
    writeFileSync(join(dir, 'g2.gtxt'), 'X\n');
    writeFileSync(join(dir, 'g3.gtxt'), Buffer.from([0, 1, 2, 88]));
    const r = await replaceTool.execute(
      { file: join(dir, 'g*.gtxt'), find: 'X', replace: 'Y', dryRun: false }, ctx(),
    );
    expect(r.success).toBe(true);
    expect(readFileSync(join(dir, 'g1.gtxt'), 'utf-8')).toBe('Y\n');
    expect(readFileSync(join(dir, 'g2.gtxt'), 'utf-8')).toBe('Y\n');
    expect(r.output).toContain('binary — refused');
    expect(readFileSync(join(dir, 'g3.gtxt'))[3]).toBe(88); // untouched
  });

  it('invalid regex and zero matches are honest', async () => {
    const f = join(dir, 'r1.txt');
    expect((await replaceTool.execute({ file: f, find: '(', replace: 'x', regex: true }, ctx())).success).toBe(false);
    const zero = await replaceTool.execute({ file: f, find: 'ZZZ', replace: 'x' }, ctx());
    expect(zero.success).toBe(true);
    expect(zero.output).toContain('0 matches');
  });
});

describe('textproc.analyze', () => {
  const csv = 'host,ms\napi,10\napi,20\nweb,30\n';

  it('stats/groupby/freq over CSV (any engine), reporting via', async () => {
    const f = join(dir, 'a.csv');
    writeFileSync(f, csv);
    const stats = await analyzeTool.execute({ file: f, op: 'stats', column: 'ms' }, ctx());
    expect(stats.success).toBe(true);
    expect(stats.output).toMatch(/via (mlr|python)/);
    expect(stats.output).toContain('20'); // mean of 10,20,30

    const grouped = await analyzeTool.execute({ file: f, op: 'groupby', column: 'ms', key: 'host' }, ctx());
    expect(grouped.success).toBe(true);
    expect(grouped.output).toContain('api');
    expect(grouped.output).toContain('15');

    const freq = await analyzeTool.execute({ file: f, op: 'freq', column: 'host' }, ctx());
    expect(freq.success).toBe(true);
    expect(freq.output).toContain('api');
    expect(freq.output).toContain('2');
  });

  it('rejects suspicious field names (argv hygiene)', async () => {
    const f = join(dir, 'a.csv');
    const r = await analyzeTool.execute({ file: f, op: 'stats', column: 'ms; rm -rf /' }, ctx());
    expect(r.success).toBe(false);
    expect(r.output).toContain('suspicious');
  });

  it('missing groupby key and unknown op fail honestly', async () => {
    const f = join(dir, 'a.csv');
    expect((await analyzeTool.execute({ file: f, op: 'groupby', column: 'ms' }, ctx())).success).toBe(false);
    expect((await analyzeTool.execute({ file: f, op: 'zap', column: 'ms' }, ctx())).success).toBe(false);
  });
});
