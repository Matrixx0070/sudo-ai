/**
 * meta.search-tools (gap #22) — exercises the pure searchTools()
 * function against a stub ToolRegistry, plus the tool's execute()
 * with the registry singleton wired via setSearchToolsRegistry().
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ToolRegistry } from '../../../src/core/tools/registry.js';
import type { ToolDefinition, ToolContext } from '../../../src/core/tools/types.js';
import {
  searchTools,
  searchToolsTool,
  setSearchToolsRegistry,
} from '../../../src/core/tools/builtin/meta/search-tools.js';

function ctx(): ToolContext {
  return { sessionId: 'test', workingDir: '/tmp', config: {}, logger: {} };
}

function makeTool(name: string, opts: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name,
    description: opts.description ?? `does ${name}`,
    category: opts.category ?? 'meta',
    requiresConfirmation: false,
    timeout: 1_000,
    parameters: opts.parameters ?? {},
    async execute() {
      return { success: true, output: '', data: {} };
    },
    ...opts,
  };
}

let registry: ToolRegistry;

beforeEach(() => {
  registry = new ToolRegistry();
  registry.register(makeTool('coder.read-file', {
    category: 'coder',
    description: 'Read a file from disk and return its contents.',
    parameters: { path: { type: 'string', required: true, description: 'Absolute path' } },
  }));
  registry.register(makeTool('coder.write-file', {
    category: 'coder',
    description: 'Write a file to disk, creating directories as needed.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path' },
      content: { type: 'string', required: true, description: 'File content' },
    },
  }));
  registry.register(makeTool('system.exec', {
    category: 'system',
    description: 'Execute a bash command.',
    parameters: { command: { type: 'string', required: true, description: 'Command to run' } },
  }));
  registry.register(makeTool('meta.classify-bash', {
    category: 'meta',
    description: 'Statically classify a bash command without executing it.',
    parameters: { command: { type: 'string', required: true, description: 'Command' } },
  }));
  setSearchToolsRegistry(registry);
});

afterEach(() => setSearchToolsRegistry(null));

// ---------------------------------------------------------------------------
// searchTools pure function
// ---------------------------------------------------------------------------

describe('searchTools (pure)', () => {
  it('returns empty when no tool matches the query', () => {
    expect(searchTools(registry, 'no-such-thing')).toEqual([]);
  });

  it('exact-name match scores higher than substring match', () => {
    const hits = searchTools(registry, 'system.exec');
    expect(hits[0]?.name).toBe('system.exec');
  });

  it('name-startsWith beats category-contains', () => {
    // 'coder' matches name "coder.read-file" via startsWith (50) AND
    // category "coder" via exact (30), so the coder tools beat
    // anything that only contains "coder" in description.
    const hits = searchTools(registry, 'coder');
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits.slice(0, 2).map((h) => h.name).sort()).toEqual([
      'coder.read-file',
      'coder.write-file',
    ]);
  });

  it('description-contains matches when name/category do not', () => {
    const hits = searchTools(registry, 'classify');
    expect(hits[0]?.name).toBe('meta.classify-bash');
  });

  it('honours the category filter', () => {
    // Empty query is a "browse" mode: every tool gets score=1 and the
    // category filter trims to the requested category.
    const browse = searchTools(registry, '', { category: 'coder', limit: 50 });
    expect(browse.length).toBe(2);
    expect(browse.every((h) => h.category === 'coder')).toBe(true);
    // With a query, the filter still trims to the requested category.
    const filtered = searchTools(registry, 'file', { category: 'coder' });
    expect(filtered.every((h) => h.category === 'coder')).toBe(true);
  });

  it('limits results to the requested cap (clamped to 50)', () => {
    for (let i = 0; i < 60; i++) {
      registry.register(makeTool(`extra.tool${i}`, { description: 'filler tool' }));
    }
    const hits = searchTools(registry, 'filler', { limit: 100 });
    expect(hits.length).toBeLessThanOrEqual(50);
  });

  it('reports a compact paramSummary like (path: string, content?: string)', () => {
    const hits = searchTools(registry, 'coder.write-file');
    expect(hits[0]?.paramSummary).toBe('(path: string, content: string)');
  });

  it('truncates long descriptions to 240 chars', () => {
    registry.register(makeTool('verbose.tool', { description: 'x'.repeat(500) }));
    const hits = searchTools(registry, 'verbose');
    expect(hits[0]?.description.length).toBeLessThanOrEqual(240);
  });

  it('excludes disabled tools by default', () => {
    registry.disable('system.exec');
    const hits = searchTools(registry, 'system');
    expect(hits.find((h) => h.name === 'system.exec')).toBeUndefined();
  });

  it('includes disabled when includeDisabled:true', () => {
    registry.disable('system.exec');
    const hits = searchTools(registry, 'system', { includeDisabled: true });
    expect(hits.find((h) => h.name === 'system.exec')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// searchToolsTool.execute
// ---------------------------------------------------------------------------

describe('searchToolsTool.execute', () => {
  it('refuses when the registry has not been injected', async () => {
    setSearchToolsRegistry(null);
    const r = await searchToolsTool.execute({ query: 'file' }, ctx());
    expect(r.success).toBe(false);
    expect(r.output).toContain('not been injected');
  });

  it('refuses an empty query AND empty category (browse mode requires at least one)', async () => {
    const r = await searchToolsTool.execute({ query: '   ' }, ctx());
    expect(r.success).toBe(false);
    expect(r.output).toContain('query');
    expect(r.output).toContain('category');
  });

  it('allows empty query when category is provided (verifier HIGH #2 — browse mode)', async () => {
    const r = await searchToolsTool.execute({ query: '', category: 'coder' }, ctx());
    expect(r.success).toBe(true);
    const data = r.data as Array<{ name: string; category: string }>;
    expect(data.length).toBe(2);
    expect(data.every((d) => d.category === 'coder')).toBe(true);
  });

  it('returns matching tools with paramSummary and category', async () => {
    const r = await searchToolsTool.execute({ query: 'coder' }, ctx());
    expect(r.success).toBe(true);
    expect(r.output).toContain('coder.read-file');
    expect(r.output).toContain('(path: string)');
    const data = r.data as Array<{ name: string }>;
    expect(data.some((d) => d.name === 'coder.read-file')).toBe(true);
  });

  it('respects the limit parameter (default 10)', async () => {
    for (let i = 0; i < 25; i++) {
      registry.register(makeTool(`bulk.t${i}`, { description: 'bulk filler' }));
    }
    const r = await searchToolsTool.execute({ query: 'bulk', limit: 5 }, ctx());
    expect(r.success).toBe(true);
    const data = r.data as unknown[];
    expect(data.length).toBe(5);
  });

  it('reports "no tools matched" when nothing scores > 0', async () => {
    const r = await searchToolsTool.execute({ query: 'totally-not-a-thing' }, ctx());
    expect(r.success).toBe(true);
    expect(r.output).toContain('No tools matched');
  });
});
