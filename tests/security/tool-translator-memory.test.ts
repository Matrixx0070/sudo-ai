/**
 * @file tool-translator-memory.test.ts
 * @description Regression: the Hermes memory_* mappings must resolve to REAL
 * registered tools, never a phantom. Before the 2026-08-05 fix, memory_read/
 * memory_write/memory_delete pointed at memory.read/write/delete — none of which
 * are registered — so a translated call looked successful then failed deep. Only
 * memory.get + memory.search exist (read-only); there is no canonical write tool
 * yet, so memory_write/memory_delete must be UNMAPPED (translated:false), not
 * mapped to a nonexistent tool.
 */

import { describe, it, expect } from 'vitest';
import { ToolTranslator } from '../../src/core/security/tool-translator.js';

// The only memory.* tools actually registered (both read-only).
const REAL_MEMORY_TOOLS = new Set(['memory.get', 'memory.search']);

describe('ToolTranslator — Hermes memory mappings', () => {
  const t = new ToolTranslator();

  it('memory_read resolves to the real memory.get read tool', () => {
    const r = t.translate('memory_read', 'hermes');
    expect(r.translated).toBe(true);
    expect(r.sudoName).toBe('memory.get');
  });

  it('memory_search resolves to the real memory.search tool', () => {
    const r = t.translate('memory_search', 'hermes');
    expect(r.translated).toBe(true);
    expect(r.sudoName).toBe('memory.search');
  });

  it('memory_write is unmapped (honest translated:false, not a phantom tool)', () => {
    const r = t.translate('memory_write', 'hermes');
    expect(r.translated).toBe(false);
    expect(r.sudoName).toBe('memory_write'); // passthrough, unchanged
  });

  it('memory_delete is unmapped (no delete tool exists)', () => {
    const r = t.translate('memory_delete', 'hermes');
    expect(r.translated).toBe(false);
  });

  it('INVARIANT: every mapping to a memory.* tool targets a REAL registered tool', () => {
    // Would have caught the original bug: probe every memory_* canonical and
    // assert any translated memory.* sudoName is one that actually exists.
    for (const canonical of ['memory_read', 'memory_write', 'memory_search', 'memory_delete']) {
      const r = t.translate(canonical, 'hermes');
      if (r.translated && r.sudoName.startsWith('memory.')) {
        expect(REAL_MEMORY_TOOLS.has(r.sudoName)).toBe(true);
      }
    }
  });
});
