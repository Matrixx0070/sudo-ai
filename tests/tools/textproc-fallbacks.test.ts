/**
 * textproc python fallback layer — golden stdin/stdout fixtures (Spec 10 / PR-3).
 *
 * Each fallback is exercised through a real python3 spawn exactly the way
 * the resolution layer invokes it: `python3 <script> [args] < stdin`.
 * PyYAML-dependent cases skip with an honest reason when it is absent
 * (CI runners without the textproc venv), instead of faking a pass.
 */

import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  CATALOG,
  resolveRole,
  type TextprocManifest,
} from '../../src/core/tools/builtin/textproc/capabilities.js';

const FALLBACKS = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../src/core/tools/builtin/textproc/fallbacks',
);

function run(
  script: string,
  args: string[],
  stdin: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = execFile(
      'python3',
      [join(FALLBACKS, script), ...args],
      { timeout: 15_000 },
      (err, stdout, stderr) => {
        const code = (err as NodeJS.ErrnoException & { code?: number })?.code;
        resolve({ stdout, stderr, code: typeof code === 'number' ? code : err ? 1 : 0 });
      },
    );
    child.stdin?.write(stdin);
    child.stdin?.end();
  });
}

async function pyyamlPresent(): Promise<boolean> {
  const r = await run('yq_fallback.py', [], 'a: 1\n');
  return r.code !== 3;
}

describe('yq_fallback', () => {
  it('yaml→json and json→yaml round-trip', async () => {
    if (!(await pyyamlPresent())) {
      console.warn('PyYAML absent — yq_fallback exits 3 honestly; skipping round-trip');
      return;
    }
    const fwd = await run('yq_fallback.py', [], 'a:\n  b: 2\n  c: [1, 2]\n');
    expect(fwd.code).toBe(0);
    expect(JSON.parse(fwd.stdout)).toEqual({ a: { b: 2, c: [1, 2] } });
    const back = await run('yq_fallback.py', ['--back'], '{"x": {"y": 1}}');
    expect(back.code).toBe(0);
    expect(back.stdout).toContain('x:');
    expect(back.stdout).toContain('y: 1');
  });
});

describe('gron_fallback', () => {
  it('flattens JSON to greppable assignments', async () => {
    const r = await run('gron_fallback.py', [], '{"a":{"b":[1,{"c":"x"}]}}');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('json.a.b[0] = 1;');
    expect(r.stdout).toContain('json.a.b[1].c = "x";');
  });

  it('round-trips through --ungron', async () => {
    const original = { a: { b: [1, { c: 'x' }], 'weird key': true } };
    const flat = await run('gron_fallback.py', [], JSON.stringify(original));
    expect(flat.code).toBe(0);
    const back = await run('gron_fallback.py', ['--ungron'], flat.stdout);
    expect(back.code).toBe(0);
    expect(JSON.parse(back.stdout)).toEqual(original);
  });
});

describe('csv_fallback', () => {
  const csv = 'name,age\nal,3\nbo,5\nal,7\n';

  it('cut projects columns', async () => {
    const r = await run('csv_fallback.py', ['cut', '--cols', 'age'], csv);
    expect(r.stdout.trim().split('\n')).toEqual(['age', '3', '5', '7']);
  });

  it('filter selects matching rows', async () => {
    const r = await run('csv_fallback.py', ['filter', '--col', 'name', '--eq', 'al'], csv);
    expect(r.stdout.trim().split('\n')).toEqual(['name,age', 'al,3', 'al,7']);
  });

  it('stats aggregates a numeric column', async () => {
    const r = await run('csv_fallback.py', ['stats', '--col', 'age'], csv);
    const stats = JSON.parse(r.stdout) as Record<string, number>;
    expect(stats['count']).toBe(3);
    expect(stats['mean']).toBe(5);
    expect(stats['median']).toBe(5);
  });

  it('groupby aggregates per key', async () => {
    const r = await run('csv_fallback.py', ['groupby', '--key', 'name', '--col', 'age', '--op', 'mean'], csv);
    expect(r.stdout).toContain('al,5.0');
    expect(r.stdout).toContain('bo,5.0');
  });

  it('freq builds a frequency table, most-common first', async () => {
    const r = await run('csv_fallback.py', ['freq', '--col', 'name'], csv);
    expect(r.stdout.trim().split('\n')).toEqual(['value,count', 'al,2', 'bo,1']);
  });

  it('to-json / from-json round-trip', async () => {
    const j = await run('csv_fallback.py', ['to-json'], csv);
    expect(j.stdout.trim().split('\n')).toHaveLength(3);
    const back = await run('csv_fallback.py', ['from-json'], j.stdout);
    expect(back.stdout.trim().split('\n')[0]).toBe('name,age');
    expect(back.stdout).toContain('al,3');
  });

  it('unknown column fails honestly', async () => {
    const r = await run('csv_fallback.py', ['stats', '--col', 'nope'], csv);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('no such column');
  });
});

describe('datamash_fallback', () => {
  it('plain aggregation', async () => {
    const r = await run('datamash_fallback.py', ['sum', '2', 'max', '2'], '1 10\n1 20\n2 30\n');
    expect(r.stdout.trim()).toBe('60\t30');
  });

  it('grouped aggregation', async () => {
    const r = await run('datamash_fallback.py', ['groupby', '1', 'mean', '2'], '1 10\n1 20\n2 30\n');
    expect(r.stdout.trim().split('\n')).toEqual(['1\t15', '2\t30']);
  });
});

describe('xml_fallback', () => {
  const xml = '<r><i id="1">x</i><i id="2">y</i></r>';

  it('extracts attributes and text', async () => {
    const attrs = await run('xml_fallback.py', ['--path', './i', '--attr', 'id'], xml);
    expect(attrs.stdout.trim().split('\n')).toEqual(['1', '2']);
    const text = await run('xml_fallback.py', ['--path', './i', '--text'], xml);
    expect(text.stdout.trim().split('\n')).toEqual(['x', 'y']);
  });

  it('no-match and parse errors exit nonzero', async () => {
    expect((await run('xml_fallback.py', ['--path', './zz'], xml)).code).not.toBe(0);
    expect((await run('xml_fallback.py', [], '<broken')).code).not.toBe(0);
  });
});

describe('html_fallback', () => {
  const html = '<div class="x"><b>bold</b> text</div><div>other</div><a href="/u" id="l">link</a>';

  it('selects by class, id, and extracts attributes', async () => {
    const byClass = await run('html_fallback.py', ['--select', 'div.x'], html);
    expect(byClass.stdout.trim()).toBe('bold text');
    const attr = await run('html_fallback.py', ['--select', '#l', '--attr', 'href'], html);
    expect(attr.stdout.trim()).toBe('/u');
  });

  it('no matches exits 1 (honest, not empty-success)', async () => {
    expect((await run('html_fallback.py', ['--select', '.absent'], html)).code).toBe(1);
  });
});

describe('sponge_fallback', () => {
  it('soaks stdin then writes the target atomically', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sponge-'));
    try {
      const f = join(dir, 'f.txt');
      writeFileSync(f, 'lower\n');
      const r = await run('sponge_fallback.py', [f], 'UPPER\n');
      expect(r.code).toBe(0);
      expect(readFileSync(f, 'utf-8')).toBe('UPPER\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ts_fallback', () => {
  it('prefixes each line with a timestamp', async () => {
    const r = await run('ts_fallback.py', ['%Y'], 'one\ntwo\n');
    const year = new Date().getFullYear().toString();
    expect(r.stdout).toBe(`${year} one\n${year} two\n`);
  });
});

describe('resolution integration (D2: python is reachable now)', () => {
  it('yaml role resolves via python when no binary exists', () => {
    const tools: TextprocManifest['tools'] = {};
    for (const entry of CATALOG) {
      tools[entry.name] = entry.name === 'python3'
        ? { name: 'python3', path: '/usr/bin/python3', via: 'python3' }
        : { name: entry.name, path: null, via: null };
    }
    const m: TextprocManifest = {
      backend: 'host', createdAt: new Date().toISOString(), pathHash: 't', tools,
    };
    const r = resolveRole('yaml', m);
    expect(r.via).toBe('python');
    expect(r.provider).toBe('python:yq_fallback');
  });
});
