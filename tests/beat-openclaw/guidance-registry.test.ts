/**
 * @file tests/beat-openclaw/guidance-registry.test.ts
 * @description BO10 / S10 — unit tests for the PURE guidance-file registry +
 * frozen-set resolver (invariant 4). Asserts:
 *  - the frozen resolver marks PROTECTED_PATHS + core-identity/constitution frozen;
 *  - editable workspace files are NOT frozen;
 *  - `resolveGuidanceSpec` allow-lists catalog names and REJECTS path traversal;
 *  - the resolver fails CLOSED (unknown/garbage path -> frozen).
 */

import { describe, it, expect } from 'vitest';
import {
  GUIDANCE_CATALOG,
  CONSTITUTION_PATHS,
  isFrozenGuidancePath,
  isFrozenGuidanceSpec,
  resolveGuidanceSpec,
  listGuidanceSpecs,
} from '../../src/core/workspace/guidance-registry.js';
import { PROTECTED_PATHS } from '../../src/core/self-build/protected-paths.js';

describe('guidance-registry — frozen resolver (invariant 4)', () => {
  it('marks core-identity.md and every constitution surface frozen', () => {
    for (const c of CONSTITUTION_PATHS) {
      expect(isFrozenGuidancePath(c)).toBe(true);
    }
    const coreId = GUIDANCE_CATALOG.find((s) => s.name === 'core-identity');
    expect(coreId).toBeDefined();
    expect(isFrozenGuidanceSpec(coreId!)).toBe(true);
  });

  it('marks every PROTECTED_PATHS entry frozen', () => {
    for (const p of PROTECTED_PATHS) {
      // A file directly under the protected prefix must resolve frozen.
      const probe = p.endsWith('/') ? p + 'x.ts' : p;
      expect(isFrozenGuidancePath(probe)).toBe(true);
    }
  });

  it('does NOT freeze editable workspace guidance files', () => {
    const editable = ['SOUL', 'IDENTITY', 'USER', 'AGENTS', 'TOOLS', 'MEMORY', 'HEARTBEAT'];
    for (const name of editable) {
      const spec = GUIDANCE_CATALOG.find((s) => s.name === name);
      expect(spec, name).toBeDefined();
      expect(isFrozenGuidanceSpec(spec!), name).toBe(false);
    }
  });

  it('fails closed — empty / non-string path is frozen', () => {
    expect(isFrozenGuidancePath('')).toBe(true);
    expect(isFrozenGuidancePath(undefined as unknown as string)).toBe(true);
    expect(isFrozenGuidancePath(null as unknown as string)).toBe(true);
  });

  it('listGuidanceSpecs decorates each entry with a frozen flag', () => {
    const list = listGuidanceSpecs();
    expect(list.length).toBe(GUIDANCE_CATALOG.length);
    const frozen = list.filter((f) => f.frozen).map((f) => f.name);
    expect(frozen).toContain('core-identity');
    expect(frozen).toContain('values');
    expect(frozen).toContain('hard-prohibitions');
    expect(frozen).not.toContain('SOUL');
  });
});

describe('guidance-registry — resolveGuidanceSpec (traversal guard)', () => {
  it('resolves known catalog names (case-insensitive)', () => {
    expect(resolveGuidanceSpec('SOUL')?.relPath).toBe('workspace/SOUL.md');
    expect(resolveGuidanceSpec('soul')?.name).toBe('SOUL');
    expect(resolveGuidanceSpec('core-identity')?.category).toBe('constitution');
  });

  it('rejects path traversal and separators', () => {
    expect(resolveGuidanceSpec('../../etc/passwd')).toBeNull();
    expect(resolveGuidanceSpec('..')).toBeNull();
    expect(resolveGuidanceSpec('workspace/SOUL.md')).toBeNull();
    expect(resolveGuidanceSpec('SOUL/../SOUL')).toBeNull();
    expect(resolveGuidanceSpec('a\\b')).toBeNull();
    expect(resolveGuidanceSpec('SOUL\x00')).toBeNull();
  });

  it('rejects unknown / malformed names', () => {
    expect(resolveGuidanceSpec('NOPE')).toBeNull();
    expect(resolveGuidanceSpec('')).toBeNull();
    expect(resolveGuidanceSpec(42 as unknown as string)).toBeNull();
    expect(resolveGuidanceSpec('x'.repeat(65))).toBeNull();
  });
});
