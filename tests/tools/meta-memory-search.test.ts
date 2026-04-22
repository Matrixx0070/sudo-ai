/**
 * @file tests/tools/meta-memory-search.test.ts
 * @description Tests for meta.memory.search tool — specifically the
 * normalisation of engine return values that caused the "results.map is not a
 * function" production crash.
 *
 * Root cause: RAGEngine.retrieveContext() returns Promise<string>, but the
 * tool's original implementation called results.map() directly, assuming an
 * array.  Fix: normalise the raw engine response to MemorySearchResult[] before
 * any array operations.
 *
 * Cases covered:
 *  1. Engine returns a non-empty string  → single {key:'rag-context'} result
 *  2. Engine returns an empty string     → empty results, no throw
 *  3. Engine returns null                → empty results, no throw
 *  4. Engine returns undefined           → empty results, no throw
 *  5. Engine returns a flat array        → correct passthrough
 *  6. Engine returns {rows:[...]}        → correct unwrap
 *  7. No engine injected                 → failure with clear message
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock logger — suppress output
// ---------------------------------------------------------------------------

vi.mock('../../src/core/shared/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Mock the meta index so we can control getMemoryEngine()
// ---------------------------------------------------------------------------

let _mockMemoryEngine: unknown = null;

vi.mock('../../src/core/tools/builtin/meta/index.js', () => ({
  getMemoryEngine: () => _mockMemoryEngine,
}));

// ---------------------------------------------------------------------------
// Import the tool under test (after mocks are set up)
// ---------------------------------------------------------------------------

import { memorySearchTool } from '../../src/core/tools/builtin/meta/memory-search.js';
import type { ToolContext } from '../../src/core/tools/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(): ToolContext {
  return {
    sessionId: 'test-session',
    config: {},
  } as unknown as ToolContext;
}

function makeEngine(searchReturn: unknown) {
  return { search: vi.fn().mockResolvedValue(searchReturn) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('meta.memory.search — engine return normalisation', () => {
  beforeEach(() => {
    _mockMemoryEngine = null;
  });

  afterEach(() => {
    _mockMemoryEngine = null;
  });

  // --- Case 1: engine returns a non-empty string (production RAG path) ------

  it('wraps a non-empty string result into a single rag-context entry', async () => {
    const markdownCtx = '## Relevant Memory\n- [mind | score:0.85] Some stored fact about system diagnostics';
    _mockMemoryEngine = makeEngine(markdownCtx);

    const result = await memorySearchTool.execute(
      { query: 'system diagnostics test tool categories', limit: 5 },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('Found 1 result(s)');
    expect(result.output).toContain('rag-context');
    expect(result.output).toContain('Relevant Memory');
    const data = result.data as { results: { key: string; content: string; score: number }[] };
    expect(data.results).toHaveLength(1);
    expect(data.results[0]!.key).toBe('rag-context');
    expect(data.results[0]!.score).toBe(1.0);
    expect(data.results[0]!.content).toBe(markdownCtx);
  });

  // --- Case 2: engine returns an empty string --------------------------------

  it('returns empty results without throwing when engine returns empty string', async () => {
    _mockMemoryEngine = makeEngine('');

    const result = await memorySearchTool.execute(
      { query: 'some query', limit: 5 },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('No memory results found');
    const data = result.data as { results: unknown[] };
    expect(data.results).toHaveLength(0);
  });

  // --- Case 3: engine returns null -------------------------------------------

  it('returns empty results without throwing when engine returns null', async () => {
    _mockMemoryEngine = makeEngine(null);

    const result = await memorySearchTool.execute(
      { query: 'some query', limit: 5 },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('No memory results found');
    const data = result.data as { results: unknown[] };
    expect(data.results).toHaveLength(0);
  });

  // --- Case 4: engine returns undefined --------------------------------------

  it('returns empty results without throwing when engine returns undefined', async () => {
    _mockMemoryEngine = makeEngine(undefined);

    const result = await memorySearchTool.execute(
      { query: 'some query', limit: 5 },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('No memory results found');
  });

  // --- Case 5: engine returns a flat array (future engine path) --------------

  it('correctly maps a flat MemorySearchResult array from the engine', async () => {
    const mockResults = [
      { key: 'mem-001', content: 'Fact about AI systems', score: 0.92 },
      { key: 'mem-002', content: 'Fact about diagnostics tooling', score: 0.75 },
    ];
    _mockMemoryEngine = makeEngine(mockResults);

    const result = await memorySearchTool.execute(
      { query: 'AI diagnostics', limit: 10 },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('Found 2 result(s)');
    expect(result.output).toContain('mem-001');
    expect(result.output).toContain('mem-002');
    expect(result.output).toContain('score: 0.920');
    const data = result.data as { results: unknown[] };
    expect(data.results).toHaveLength(2);
  });

  // --- Case 6: engine returns {rows: [...]} wrapper -------------------------

  it('correctly unwraps {rows:[...]} shaped engine response', async () => {
    const mockRows = [
      { key: 'node-a', content: 'Knowledge graph node content', score: 0.88 },
    ];
    _mockMemoryEngine = makeEngine({ rows: mockRows, total: 1 });

    const result = await memorySearchTool.execute(
      { query: 'knowledge graph', limit: 5 },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('Found 1 result(s)');
    expect(result.output).toContain('node-a');
    const data = result.data as { results: unknown[] };
    expect(data.results).toHaveLength(1);
  });

  // --- Case 7: no engine injected -------------------------------------------

  it('returns a clear failure message when memoryEngine is not injected', async () => {
    _mockMemoryEngine = null;

    const result = await memorySearchTool.execute(
      { query: 'any query', limit: 5 },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain('memory engine has not been initialised');
  });

  // --- Guard: empty query rejected before engine is called ------------------

  it('rejects empty query without calling the engine', async () => {
    const engine = makeEngine('should not be called');
    _mockMemoryEngine = engine;

    const result = await memorySearchTool.execute(
      { query: '   ', limit: 5 },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain('"query" parameter is required');
    expect(engine.search).not.toHaveBeenCalled();
  });
});
