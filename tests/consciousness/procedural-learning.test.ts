/**
 * @file tests/consciousness/procedural-learning.test.ts
 * @description Theme 4 (consciousness feedback loops, slice 1) — closing the
 * procedural-memory loop: recurring tool sequences compile into reusable
 * procedures. This validates the behavior the orchestrator now invokes at
 * turn-end (onInteractionEnd → checkForNewProcedures, gated by
 * SUDO_CONSCIOUSNESS_PROCEDURAL_LEARN=1).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsciousnessDB } from '../../src/core/consciousness/consciousness-db.js';
import { ProceduralMemory } from '../../src/core/consciousness/procedural-memory/index.js';
import type { ToolCallRecord } from '../../src/core/consciousness/procedural-memory/types.js';

const SEQ: ToolCallRecord[] = [
  { toolName: 'web.search', arguments: {}, result: 'ok' },
  { toolName: 'text.summarize', arguments: {}, result: 'ok' },
];

describe('Theme 4: procedural-memory learning loop', () => {
  let tempDir: string;
  let cdb: ConsciousnessDB;
  let pm: ProceduralMemory;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'proc-test-'));
    cdb = new ConsciousnessDB(join(tempDir, 'c.db'));
    pm = new ProceduralMemory(cdb);
  });
  afterEach(() => {
    try { cdb.getDb().close(); } catch { /* ignore */ }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('PROC-1: a sequence repeated across 3 sessions compiles into a procedure', () => {
    // Same tool sequence observed in three distinct sessions.
    pm.observeToolSequence('s1', SEQ);
    pm.observeToolSequence('s2', SEQ);
    pm.observeToolSequence('s3', SEQ);

    const compiled = pm.checkForNewProcedures(3);
    expect(compiled.length).toBeGreaterThanOrEqual(1);

    // The compiled procedure is now stored.
    expect(pm.getProcedures().length).toBeGreaterThanOrEqual(1);
  });

  it('PROC-2: a second compilation pass does not duplicate (dedup)', () => {
    pm.observeToolSequence('s1', SEQ);
    pm.observeToolSequence('s2', SEQ);
    pm.observeToolSequence('s3', SEQ);

    expect(pm.checkForNewProcedures(3).length).toBeGreaterThanOrEqual(1);
    // Already compiled → nothing new the second time.
    expect(pm.checkForNewProcedures(3).length).toBe(0);
  });

  it('PROC-3: below the occurrence threshold → nothing compiles', () => {
    pm.observeToolSequence('s1', SEQ); // only once
    expect(pm.checkForNewProcedures(3).length).toBe(0);
  });
});
