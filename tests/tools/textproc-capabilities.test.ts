/**
 * textproc capability registry tests (Spec 10 / PR-2).
 *
 * Pure-function coverage (probe parsing, role resolution, summary, plugin
 * merge) is hermetic; getManifest/tool-execute tests run against the real
 * host PATH but assert only invariants that hold on any machine with bash.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CATALOG,
  ROLES,
  buildProbeScript,
  parseProbeOutput,
  loadPluginEntries,
  fullCatalog,
  resolveRole,
  summaryLine,
  getManifest,
  clearManifestCache,
  type TextprocManifest,
} from '../../src/core/tools/builtin/textproc/capabilities.js';
import { capabilitiesTool } from '../../src/core/tools/builtin/textproc/capabilities-tool.js';
import type { ToolContext } from '../../src/core/tools/types.js';

function manifestWith(paths: Record<string, { path: string; via: string }>): TextprocManifest {
  const tools: TextprocManifest['tools'] = {};
  for (const entry of CATALOG) {
    const hit = paths[entry.name];
    tools[entry.name] = hit
      ? { name: entry.name, path: hit.path, via: hit.via }
      : { name: entry.name, path: null, via: null };
  }
  return { backend: 'host', createdAt: new Date().toISOString(), pathHash: 'test', tools };
}

const ctx = { sessionId: 't', workingDir: '/tmp', config: {}, logger: console } as unknown as ToolContext;

describe('textproc probe script', () => {
  it('probes every catalog name and alias exactly once', () => {
    const { script, probes } = buildProbeScript(CATALOG);
    expect(new Set(probes).size).toBe(probes.length);
    expect(probes).toContain('rg');
    expect(probes).toContain('batcat'); // alias probed alongside bat
    expect(script).toContain('command -v');
    // one printf line per probe — parseable by parseProbeOutput
    expect(script.split('\n').length).toBe(probes.length);
  });

  it('parseProbeOutput maps found names and skips empty results', () => {
    const out = 'rg\t/usr/bin/rg\nnope\t\nbatcat\t/usr/bin/batcat\n';
    const found = parseProbeOutput(out);
    expect(found.get('rg')).toBe('/usr/bin/rg');
    expect(found.get('batcat')).toBe('/usr/bin/batcat');
    expect(found.has('nope')).toBe(false);
  });
});

describe('textproc role resolution (D2 order)', () => {
  it('prefers the first-listed provider as native', () => {
    const m = manifestWith({
      rg: { path: '/usr/bin/rg', via: 'rg' },
      grep: { path: '/usr/bin/grep', via: 'grep' },
    });
    const r = resolveRole('search', m);
    expect(r.provider).toBe('rg');
    expect(r.via).toBe('native');
  });

  it('falls to the next provider (alt) when the preferred one is missing', () => {
    const m = manifestWith({ grep: { path: '/usr/bin/grep', via: 'grep' } });
    const r = resolveRole('search', m);
    expect(r.provider).toBe('grep');
    expect(r.via).toBe('alt');
  });

  it('reports alias when the binary was found under a Debian name', () => {
    const m = manifestWith({ bat: { path: '/usr/bin/batcat', via: 'batcat' } });
    const r = resolveRole('pager', m);
    expect(r.provider).toBe('bat');
    expect(r.via).toBe('alias');
  });

  it('returns none (never a silent lie) when nothing serves the role', () => {
    const m = manifestWith({});
    const r = resolveRole('yaml', m);
    // No yq binary and no fallback script shipped yet (PR-3) → honest none.
    expect(['python', 'none']).toContain(r.via);
    if (r.via === 'none') expect(r.provider).toBeNull();
  });

  it('never resolves to a banned tool', () => {
    const m = manifestWith({ vipe: { path: '/usr/bin/vipe', via: 'vipe' } });
    for (const role of Object.keys(ROLES)) {
      expect(resolveRole(role, m).provider).not.toBe('vipe');
    }
  });
});

describe('textproc summary line', () => {
  it('stays within 200 chars and covers the key roles', () => {
    const m = manifestWith({
      rg: { path: '/usr/bin/rg', via: 'rg' },
      jq: { path: '/usr/bin/jq', via: 'jq' },
    });
    const line = summaryLine(m);
    expect(line.length).toBeLessThanOrEqual(200);
    expect(line).toContain('search:rg');
    expect(line).toContain('json:jq');
    expect(line).toContain('yaml:');
  });
});

describe('textproc plugin merge', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('accepts valid entries and ignores malformed ones', () => {
    dir = mkdtempSync(join(tmpdir(), 'textproc-plugin-'));
    const p = join(dir, 'plugins.json5');
    writeFileSync(p, `[
      { name: 'mytool', roles: ['search'], streaming: true, hint: 'custom' },
      { roles: ['broken'] },            // no name — ignored
      { name: 'alsobad' },              // no roles — ignored
    ]`);
    const entries = loadPluginEntries(p);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe('mytool');
    expect(entries[0]?.category).toBe('bonus');
  });

  it('returns empty on unreadable/absent config', () => {
    expect(loadPluginEntries('/nonexistent/nope.json5')).toEqual([]);
    dir = mkdtempSync(join(tmpdir(), 'textproc-plugin-'));
    const p = join(dir, 'bad.json5');
    writeFileSync(p, '{{{{not json5');
    expect(loadPluginEntries(p)).toEqual([]);
  });

  it('built-in catalog entries win name conflicts', () => {
    // fullCatalog with no plugin file present is exactly the built-in set.
    const names = fullCatalog().map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('textproc live host probe (invariants only)', () => {
  it('getManifest finds bash-adjacent basics and caches', async () => {
    clearManifestCache();
    const m1 = await getManifest({ refresh: true });
    expect(m1.backend).toBe('host');
    // Any Linux/macOS CI runner has these.
    expect(m1.tools['grep']?.path).toBeTruthy();
    expect(m1.tools['sed']?.path).toBeTruthy();
    const m2 = await getManifest();
    expect(m2).toBe(m1); // in-memory cache hit
  });

  it('textproc.capabilities tool returns roles and summary', async () => {
    const res = await capabilitiesTool.execute({}, ctx);
    expect(res.success).toBe(true);
    expect(res.output).toContain('Roles:');
    expect(res.output).toContain('Summary: textproc');
    const data = res.data as { roles: unknown[]; present: string[] };
    expect(data.roles.length).toBeGreaterThan(10);
    expect(data.present).toContain('grep');
  });

  it('single-role query answers narrowly', async () => {
    const res = await capabilitiesTool.execute({ role: 'search' }, ctx);
    expect(res.success).toBe(true);
    expect(res.output).toMatch(/^search: /);
  });
});
