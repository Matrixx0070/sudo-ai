/**
 * ToolRouter category-coverage regression guard.
 *
 * Bug class: ToolRouter.route() only advertises tools whose category is a key
 * in CATEGORY_MAP. A registered tool with an uncovered category is invisible
 * to the model (reachable only via tool.search). This was fixed by hand twice
 * ('skill', 'superpowers'); this test makes any FUTURE gap fail CI.
 *
 * Coverage source is the REAL tool surface: the actual builtin loader plus the
 * out-of-builtin superpowers registration — the same registrations cli.ts
 * performs at boot — not a hardcoded category list.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  findUnroutableCategories,
  categoryFromToolName,
  ROUTABLE_CATEGORIES,
} from '../../src/core/agent/tool-router.js';
import { ToolRegistry } from '../../src/core/tools/registry.js';
import type { ToolCategory } from '../../src/core/tools/types.js';
import { loadBuiltinTools } from '../../src/core/tools/loader.js';
import { registerSuperpowers } from '../../src/core/superpowers/index.js';

describe('findUnroutableCategories (pure helper)', () => {
  it('returns empty map when every category is covered', () => {
    const tools = [
      { name: 'coder.read-file', category: 'coder' },
      { name: 'browser.search', category: 'browser' },
      { name: 'skill.apply', category: 'skill' },
      { name: 'super.edit-image', category: 'superpowers' },
    ];
    expect(findUnroutableCategories(tools).size).toBe(0);
  });

  it('flags a bogus declared category with the tool names it hides', () => {
    const tools = [
      { name: 'coder.read-file', category: 'coder' },
      { name: 'gizmo.frobnicate', category: 'gizmo' },
      { name: 'gizmo.defrobnicate', category: 'gizmo' },
    ];
    const result = findUnroutableCategories(tools);
    expect(result.size).toBe(1);
    expect(result.get('gizmo')).toEqual(['gizmo.frobnicate', 'gizmo.defrobnicate']);
  });

  it('does NOT rescue a declared-but-uncovered category via name prefix (mirrors _groupByCategory)', () => {
    // Name prefix 'coder' IS covered, but the declared category wins in
    // grouping, so the tool is still unroutable.
    const tools = [{ name: 'coder.weird-tool', category: 'notacategory' }];
    const result = findUnroutableCategories(tools);
    expect(result.get('notacategory')).toEqual(['coder.weird-tool']);
  });

  it('rescues a tool with NO declared category via its name prefix', () => {
    const tools = [{ name: 'browser.navigate' }];
    expect(findUnroutableCategories(tools).size).toBe(0);
  });

  it('flags a tool with no declared category whose name prefix is uncovered', () => {
    const tools = [{ name: 'wibble.do-thing' }];
    expect(findUnroutableCategories(tools).get('wibble')).toEqual(['wibble.do-thing']);
  });

  it('categoryFromToolName extracts the dot prefix', () => {
    expect(categoryFromToolName('coder.read-file')).toBe('coder');
    expect(categoryFromToolName('nodots')).toBe('');
    expect(categoryFromToolName('')).toBe('');
  });
});

describe('CATEGORY_MAP covers every category in real use', () => {
  let registry: ToolRegistry;

  // Loading the full builtin surface (~240 tool modules + transform) routinely
  // exceeds vitest's default 10s hook timeout on a cold cache / in CI — give it
  // headroom so the coverage assertion actually runs instead of timing out.
  beforeAll(async () => {
    registry = new ToolRegistry();
    const toolsDir = new URL('../../src/core/tools/builtin', import.meta.url).pathname;
    await loadBuiltinTools(registry, toolsDir);
    registerSuperpowers(registry);
  }, 120_000);

  it('loads a substantial real tool surface (guards against silent loader failure)', () => {
    // If module loading silently failed, missing categories would vanish from
    // the coverage check instead of failing it. Pin a floor on the surface.
    const tools = registry.listEnabled();
    expect(tools.length).toBeGreaterThanOrEqual(150);
    const categories = new Set(tools.map((t) => t.category));
    expect(categories.size).toBeGreaterThanOrEqual(15);
    // The two categories that were historically invisible must be present…
    expect(categories.has('skill')).toBe(true);
    expect(categories.has('superpowers')).toBe(true);
    // …and covered.
    expect(ROUTABLE_CATEGORIES.has('skill')).toBe(true);
    expect(ROUTABLE_CATEGORIES.has('superpowers')).toBe(true);
  });

  it('every registered tool category has a CATEGORY_MAP entry (no invisible tools)', () => {
    const unroutable = findUnroutableCategories(registry.listEnabled());
    const gaps = [...unroutable.entries()]
      .map(([cat, names]) => `"${cat}" hides: ${names.join(', ')}`)
      .join('\n');
    expect(
      unroutable.size,
      `Tool categories missing from CATEGORY_MAP in src/core/agent/tool-router.ts — these tools are invisible to the model (only reachable via tool.search):\n${gaps}`,
    ).toBe(0);
  });

  // Mirrors the cli.ts post-plugin re-check: enabled plugins run host code in
  // activate() and can self-register tools via ToolRegistry.getGlobal(). A
  // plugin-introduced category that CATEGORY_MAP doesn't cover must be caught
  // by re-running findUnroutableCategories on the post-plugin tool set, and it
  // must be NEW relative to the boot pass (that diff is what dedupes warnings).
  it('post-plugin re-check flags a plugin-registered tool with a brand-new category', () => {
    const bootGaps = new Set(findUnroutableCategories(registry.listEnabled()).keys());
    // Real registry surface is clean at boot (asserted above).
    expect(bootGaps.has('pluginzap')).toBe(false);

    // Simulate a plugin's activate() self-registering a tool at runtime with a
    // category the compile-time ToolCategory union (and CATEGORY_MAP) doesn't
    // know about — exactly what out-of-tree plugin JS can do.
    registry.register({
      name: 'pluginzap.do-thing',
      description: 'plugin-added tool with an uncovered category',
      category: 'pluginzap' as ToolCategory,
      parameters: {},
      execute: async () => ({ success: true, output: 'ok' }),
    });
    try {
      const postGaps = findUnroutableCategories(registry.listEnabled());
      expect(postGaps.get('pluginzap')).toEqual(['pluginzap.do-thing']);
      // The gap is new vs. boot — the post-plugin phase (not dedupe) reports it.
      expect(bootGaps.has('pluginzap')).toBe(false);
      // And no previously-clean category regressed as a side effect.
      for (const cat of postGaps.keys()) {
        if (cat !== 'pluginzap') expect(bootGaps.has(cat)).toBe(true);
      }
    } finally {
      // Leave the shared registry as the other tests loaded it.
      registry.unregister('pluginzap.do-thing');
    }
  });

  // Mirrors the cli.ts 'final' phase check: ~14 tools register late in boot()
  // (multi-agent, plan-mode, memory-consolidate, classify-bash, search-tools,
  // schedule-message, ptc, ptc-python, run-workflow, enqueue-workflow), AFTER
  // both the 'boot' and 'post-plugin' passes. Today they all use covered
  // categories (system/meta/comms) — this proves the final-pass mechanism
  // catches a FUTURE late registration that introduces an uncovered category.
  it('final re-check flags a late-boot()-registered tool with a brand-new category', () => {
    const earlierGaps = new Set(findUnroutableCategories(registry.listEnabled()).keys());
    expect(earlierGaps.has('lateplugin')).toBe(false);

    // Simulate an env-conditional registry.register() late in boot() using a
    // category CATEGORY_MAP doesn't know about.
    registry.register({
      name: 'lateplugin.x',
      description: 'late-registered tool with an uncovered category',
      category: 'lateplugin' as ToolCategory,
      parameters: {},
      execute: async () => ({ success: true, output: 'ok' }),
    });
    try {
      const finalGaps = findUnroutableCategories(registry.listEnabled());
      expect(finalGaps.get('lateplugin')).toEqual(['lateplugin.x']);
      // The gap is new vs. earlier passes — the 'final' phase (dedupe set)
      // would report it exactly once, tagged '(final)'.
      expect(earlierGaps.has('lateplugin')).toBe(false);
      // No previously-clean category regressed as a side effect.
      for (const cat of finalGaps.keys()) {
        if (cat !== 'lateplugin') expect(earlierGaps.has(cat)).toBe(true);
      }
    } finally {
      registry.unregister('lateplugin.x');
    }
  });

  it('registry is clean again after the simulated plugin tool is removed', () => {
    expect(findUnroutableCategories(registry.listEnabled()).size).toBe(0);
  });
});
