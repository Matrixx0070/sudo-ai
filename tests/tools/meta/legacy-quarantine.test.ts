/**
 * @file tests/tools/meta/legacy-quarantine.test.ts
 * @description The 4 legacy meta tools that DUPLICATE a wired subsystem
 * (meta.swarm/code-evolver/auto-optimizer/forge) are quarantined — not
 * registered by default, re-enabled by SUDO_ENABLE_LEGACY_META_TOOLS=1.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ToolRegistry } from '../../../src/core/tools/registry.js';
import { registerMetaTools, LEGACY_DUPLICATE_META_TOOLS } from '../../../src/core/tools/builtin/meta/index.js';

const FLAG = 'SUDO_ENABLE_LEGACY_META_TOOLS';

describe('legacy meta-tool quarantine', () => {
  const saved = process.env[FLAG];
  beforeEach(() => { delete process.env[FLAG]; });
  afterEach(() => { if (saved === undefined) delete process.env[FLAG]; else process.env[FLAG] = saved; });

  it('the quarantine set is exactly the 4 moat-duplicate tools', () => {
    expect([...LEGACY_DUPLICATE_META_TOOLS].sort()).toEqual(
      ['meta.auto-optimizer', 'meta.code-evolver', 'meta.forge', 'meta.swarm'],
    );
  });

  it('does NOT register the 4 duplicate tools by default; keeps the rest', () => {
    const r = new ToolRegistry();
    registerMetaTools(r);
    for (const name of LEGACY_DUPLICATE_META_TOOLS) {
      expect(r.get(name)).toBeUndefined();
    }
    // A normal meta tool is still registered.
    expect(r.get('meta.predictor')).toBeDefined();
  });

  it('registers the 4 when SUDO_ENABLE_LEGACY_META_TOOLS=1', () => {
    process.env[FLAG] = '1';
    const r = new ToolRegistry();
    registerMetaTools(r);
    for (const name of LEGACY_DUPLICATE_META_TOOLS) {
      expect(r.get(name)).toBeDefined();
    }
  });
});
