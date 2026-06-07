/**
 * @file tests/consciousness/world-model-surprise.test.ts
 * @description Theme 4.2 — closing the WorldModel -> surprise loop: a prediction
 * is recorded, then resolved against the actual outcome, producing a surprise
 * magnitude. This validates the mechanics the orchestrator now drives at
 * onInteractionStart (predict) / onInteractionEnd (resolve), gated by
 * SUDO_CONSCIOUSNESS_WORLD_MODEL=1.
 *
 * Critically asserts the surprise DIRECTION (the inverted-magnitude risk a prior
 * review flagged): a confident-but-wrong prediction => high surprise; a confident
 * prediction that holds => low surprise.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsciousnessDB } from '../../src/core/consciousness/consciousness-db.js';
import { WorldModel } from '../../src/core/consciousness/world-model/index.js';
import { SurpriseEngine } from '../../src/core/consciousness/surprise-engine/index.js';

describe('Theme 4.2: WorldModel -> surprise loop', () => {
  let tempDir: string;
  let cdb: ConsciousnessDB;
  let wm: WorldModel;
  let se: SurpriseEngine;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wms-test-'));
    cdb = new ConsciousnessDB(join(tempDir, 'c.db'));
    wm = new WorldModel(cdb);
    se = new SurpriseEngine(cdb, wm);
  });
  afterEach(() => {
    try { cdb.getDb().close(); } catch { /* ignore */ }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('WMS-1: a confident prediction that turns out WRONG => high surprise', () => {
    const entry = wm.predict('tool_use', 'this interaction will require tool use', 0.75);
    wm.save(entry);
    // Reality: it did NOT use tools (matched=false).
    const event = se.evaluate(entry.id, entry.prediction, entry.confidence, entry.domain, 'answered directly', false);
    expect(event.magnitude).toBeGreaterThan(0.6); // ~0.75
  });

  it('WMS-2: a confident prediction that HOLDS => low surprise', () => {
    const entry = wm.predict('tool_use', 'this interaction will require tool use', 0.75);
    wm.save(entry);
    // Reality: it used tools (matched=true).
    const event = se.evaluate(entry.id, entry.prediction, entry.confidence, entry.domain, 'used tools', true);
    expect(event.magnitude).toBeLessThan(0.4); // ~0.25
  });

  it('WMS-3: resolving records the outcome on the world model (loop closes)', () => {
    const entry = wm.predict('tool_use', 'this interaction will require tool use', 0.35);
    wm.save(entry);
    // evaluate() internally calls worldModel.recordOutcome — should not throw.
    expect(() => se.evaluate(entry.id, entry.prediction, entry.confidence, entry.domain, 'used tools', true)).not.toThrow();
  });
});
