/**
 * Runtime registry-observer coverage guard.
 *
 * The three cli.ts phase checks (boot / post-plugin / final) are point-in-time:
 * a tool registered AFTER boot completes (lazy callback, first-request path,
 * ToolRegistry.setGlobal() self-registration) was never re-validated. The
 * ToolRegistry.onRegister() observer closes that gap: every register() at ANY
 * time immediately runs a per-tool routability check (unroutableCategoryOf)
 * and warns — non-fatal, deduped, tagged '(runtime)'.
 *
 * These tests prove:
 *   1. the observer fires on register() with the registered tool,
 *   2. the observer path detects an uncovered category (and stays silent for a
 *      covered one), with the same dedupe behavior cli.ts wires up,
 *   3. a throwing observer can NEVER break register().
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/core/tools/registry.js';
import { unroutableCategoryOf } from '../../src/core/agent/tool-router.js';
import type { ToolCategory, ToolDefinition } from '../../src/core/tools/types.js';

function makeTool(name: string, category: string): ToolDefinition {
  return {
    name,
    description: `test tool ${name}`,
    category: category as ToolCategory,
    parameters: {},
    execute: async () => ({ success: true, output: 'ok' }),
  } as ToolDefinition;
}

describe('ToolRegistry.onRegister observer', () => {
  it('invokes the observer on register() with the registered tool', () => {
    const registry = new ToolRegistry();
    const seen: Array<{ name: string; category?: string | null }> = [];
    registry.onRegister((tool) => seen.push(tool));

    registry.register(makeTool('coder.observer-probe', 'coder'));

    expect(seen).toEqual([{ name: 'coder.observer-probe', category: 'coder' }]);
  });

  it('fires for tools registered at ANY later time (post-"boot" registration)', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('coder.pre-hook', 'coder')); // before subscription — not seen
    const seen: string[] = [];
    registry.onRegister((tool) => seen.push(tool.name));

    // Simulate a lazily-invoked callback registering long after boot.
    registry.register(makeTool('browser.late-arrival', 'browser'));

    expect(seen).toEqual(['browser.late-arrival']);
  });

  it('does NOT re-fire for a same-reference no-op re-register', () => {
    const registry = new ToolRegistry();
    const seen: string[] = [];
    registry.onRegister((tool) => seen.push(tool.name));

    const tool = makeTool('coder.same-ref', 'coder');
    registry.register(tool);
    registry.register(tool); // same object — registry no-ops, observer silent

    expect(seen).toEqual(['coder.same-ref']);
  });

  it('a throwing observer does NOT break register() — tool is stored, no exception, later observers still fire', () => {
    const registry = new ToolRegistry();
    const seenAfter: string[] = [];
    registry.onRegister(() => {
      throw new Error('observer blew up');
    });
    registry.onRegister((tool) => seenAfter.push(tool.name));

    expect(() => registry.register(makeTool('coder.blast-shield', 'coder'))).not.toThrow();
    expect(registry.get('coder.blast-shield')).toBeDefined();
    // Per-callback isolation: the second observer ran despite the first throwing.
    expect(seenAfter).toEqual(['coder.blast-shield']);
  });
});

describe('runtime coverage check via the observer path (mirrors cli.ts wiring)', () => {
  it('unroutableCategoryOf flags an uncovered category and passes a covered one', () => {
    expect(unroutableCategoryOf({ name: 'gizmo.frobnicate', category: 'gizmo' })).toBe('gizmo');
    expect(unroutableCategoryOf({ name: 'coder.read-file', category: 'coder' })).toBeNull();
    // Declared-but-uncovered category is NOT rescued by a covered name prefix
    // (mirrors findUnroutableCategories / _groupByCategory).
    expect(unroutableCategoryOf({ name: 'coder.weird', category: 'notacategory' })).toBe('notacategory');
    // No declared category: name prefix decides.
    expect(unroutableCategoryOf({ name: 'browser.navigate' })).toBeNull();
    expect(unroutableCategoryOf({ name: 'wibble.do-thing' })).toBe('wibble');
    // No category at all — nothing to key a CATEGORY_MAP entry on.
    expect(unroutableCategoryOf({ name: 'nodots' })).toBeNull();
  });

  it('registering an uncovered-category tool triggers the gap warning exactly once; covered stays silent', () => {
    const registry = new ToolRegistry();
    // Exact shape cli.ts wires: shared dedupe set + per-tool check, no rescan.
    const flaggedRoutingGaps = new Set<string>();
    const warnings: Array<{ category: string; tool: string }> = [];
    registry.onRegister((tool) => {
      const category = unroutableCategoryOf(tool);
      if (category === null || flaggedRoutingGaps.has(category)) return;
      flaggedRoutingGaps.add(category);
      warnings.push({ category, tool: tool.name });
    });

    registry.register(makeTool('coder.covered-tool', 'coder')); // covered — silent
    expect(warnings).toEqual([]);

    registry.register(makeTool('runtimezap.do-thing', 'runtimezap')); // uncovered — flags
    expect(warnings).toEqual([{ category: 'runtimezap', tool: 'runtimezap.do-thing' }]);

    registry.register(makeTool('runtimezap.other-thing', 'runtimezap')); // deduped
    expect(warnings).toHaveLength(1);
    expect(flaggedRoutingGaps.has('runtimezap')).toBe(true);
  });

  it('a gap already flagged by a startup phase pass does not double-warn at runtime (shared dedupe set)', () => {
    const registry = new ToolRegistry();
    const flaggedRoutingGaps = new Set<string>(['stalegap']); // startup pass already warned
    const warnings: string[] = [];
    registry.onRegister((tool) => {
      const category = unroutableCategoryOf(tool);
      if (category === null || flaggedRoutingGaps.has(category)) return;
      flaggedRoutingGaps.add(category);
      warnings.push(category);
    });

    registry.register(makeTool('stalegap.tool', 'stalegap'));
    expect(warnings).toEqual([]);
  });
});
