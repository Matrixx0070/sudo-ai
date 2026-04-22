/**
 * registry-skill-index.test.ts — Integration tests for ToolRegistry skill index wiring.
 *
 * Spec reference: docs/wave10c-spec.md §5 Builder B tests (RSI-1..RSI-4).
 * Exactly 4 tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ToolRegistry } from '../../src/core/tools/registry.js';

describe('ToolRegistry skill index (Wave 10C)', () => {
  // RSI-1 — skillIdForTool returns null before setSkillIndex called
  it('RSI-1: skillIdForTool returns null before setSkillIndex is called', () => {
    const registry = new ToolRegistry();

    expect(registry.skillIdForTool('some.tool')).toBeNull();
    expect(registry.skillIdForTool('')).toBeNull();
    expect(registry.skillIdForTool('nonexistent.tool')).toBeNull();
  });

  // RSI-2 — skillIdForTool returns mapped skill name after setSkillIndex called
  it('RSI-2: skillIdForTool returns mapped skill name after setSkillIndex called', () => {
    const registry = new ToolRegistry();
    const index = new Map<string, string>([
      ['coder.read-file', 'coding-skill'],
      ['coder.write-file', 'coding-skill'],
    ]);

    registry.setSkillIndex(index);

    expect(registry.skillIdForTool('coder.read-file')).toBe('coding-skill');
    expect(registry.skillIdForTool('coder.write-file')).toBe('coding-skill');
  });

  // RSI-3 — skillIdForTool returns null for unknown tool (not in index)
  it('RSI-3: skillIdForTool returns null for unknown tool not in index', () => {
    const registry = new ToolRegistry();
    const index = new Map<string, string>([
      ['known.tool', 'some-skill'],
    ]);

    registry.setSkillIndex(index);

    expect(registry.skillIdForTool('unknown.tool')).toBeNull();
    expect(registry.skillIdForTool('')).toBeNull();
  });

  // RSI-4 — SUDO_SKILL_INDEX_DISABLE=1 env → setSkillIndex silently ignored; skillIdForTool returns null
  it('RSI-4: SUDO_SKILL_INDEX_DISABLE=1 prevents index load; skillIdForTool returns null', () => {
    // Set kill-switch before calling setSkillIndex
    process.env['SUDO_SKILL_INDEX_DISABLE'] = '1';

    const registry = new ToolRegistry();
    const index = new Map<string, string>([
      ['coder.read-file', 'coding-skill'],
    ]);

    // Should be silently ignored due to kill-switch
    registry.setSkillIndex(index);

    // skillIdForTool must still return null (index was not loaded)
    expect(registry.skillIdForTool('coder.read-file')).toBeNull();
    expect(registry.skillIdForTool('unknown.tool')).toBeNull();

    // Cleanup kill-switch so it doesn't leak to other tests
    delete process.env['SUDO_SKILL_INDEX_DISABLE'];
  });
});
