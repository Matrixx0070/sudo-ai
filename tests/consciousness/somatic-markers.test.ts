/**
 * @file tests/consciousness/somatic-markers.test.ts
 * @description SomaticMarkerStore — the emotional-memory learning loop the
 * orchestrator now closes at turn-end (onInteractionEnd, gated by
 * SUDO_CONSCIOUSNESS_SOMATIC_MARKERS=1). Validates the create / retrieve /
 * reinforce / filter behavior the wiring depends on. (The store itself had no
 * prior test coverage.)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsciousnessDB } from '../../src/core/consciousness/consciousness-db.js';
import { SomaticMarkerStore } from '../../src/core/consciousness/emotional-memory/markers.js';
import { extractTriggerConcepts } from '../../src/core/consciousness/orchestrator.js';

describe('SomaticMarkerStore (emotional-memory learning loop)', () => {
  let tempDir: string;
  let cdb: ConsciousnessDB;
  let store: SomaticMarkerStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'somatic-test-'));
    cdb = new ConsciousnessDB(join(tempDir, 'c.db'));
    store = new SomaticMarkerStore(cdb);
  });
  afterEach(() => {
    try { cdb.getDb().close(); } catch { /* ignore */ }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('SM-1: createMarker persists a trigger→emotion association', () => {
    const m = store.createMarker('deployment', 'fear', 0.8);
    expect(m.triggerPattern).toBe('deployment');
    expect(m.emotion).toBe('fear');
    expect(m.intensity).toBe(0.8);
    expect(m.timesTriggered).toBe(0);
    expect(store.getAllMarkers()).toHaveLength(1);
  });

  it('SM-2: getSomaticResponse matches concepts (LIKE) and reinforces times_triggered', () => {
    store.createMarker('deployment pipeline', 'fear', 0.7);
    const hits = store.getSomaticResponse(['deployment']);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.timesTriggered).toBe(1); // reinforced on activation
    // A different concept that still LIKE-matches the same marker → reinforced again.
    expect(store.getSomaticResponse(['pipeline'])[0]!.timesTriggered).toBe(2);
  });

  it('SM-3: getSomaticResponse returns [] for unrelated or empty concepts', () => {
    store.createMarker('deployment', 'fear', 0.7);
    expect(store.getSomaticResponse(['cooking'])).toEqual([]);
    expect(store.getSomaticResponse([])).toEqual([]);
  });

  it('SM-4: getMarkersByEmotion filters by emotion, sorted by intensity desc', () => {
    store.createMarker('a', 'joy', 0.5);
    store.createMarker('b', 'joy', 0.9);
    store.createMarker('c', 'fear', 0.8);
    expect(store.getMarkersByEmotion('joy').map((m) => m.triggerPattern)).toEqual(['b', 'a']);
  });

  it('SM-5: createMarker rejects an out-of-range intensity or empty trigger', () => {
    expect(() => store.createMarker('x', 'calm', 1.5)).toThrow();
    expect(() => store.createMarker('', 'calm', 0.5)).toThrow();
  });

  it('SM-6: orchestrator dedup invariant — no new marker when one already links the same emotion', () => {
    store.createMarker('release', 'fear', 0.7);
    const reinforced = store.getSomaticResponse(['release']);
    // Mirrors the orchestrator guard: skip create when a same-emotion marker matched.
    const shouldCreate = !reinforced.some((m) => m.emotion === 'fear');
    expect(shouldCreate).toBe(false);
    expect(store.getAllMarkers()).toHaveLength(1);
  });

  it('SM-7: prune drops never-reinforced stale markers, keeps reinforced + recent', () => {
    const stale = store.createMarker('aaastale', 'fear', 0.7);        // never reinforced
    const reinfOld = store.createMarker('bbbreinforced', 'joy', 0.7);
    store.getSomaticResponse(['bbbreinforced']);                       // times_triggered = 1
    store.createMarker('cccrecent', 'calm', 0.7);                     // never reinforced but recent
    // Backdate the two "old" markers 40 days (ISO cutoff, matching created_at format).
    const back = cdb.getDb().prepare("UPDATE somatic_markers SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-40 days') WHERE id = ?");
    back.run(stale.id); back.run(reinfOld.id);

    expect(store.prune({ retentionDays: 30, maxRows: 0 })).toBe(1); // only the never-reinforced stale one
    expect(store.getAllMarkers().map((m) => m.triggerPattern).sort()).toEqual(['bbbreinforced', 'cccrecent']);
  });

  it('SM-8: prune caps total rows, keeping the most-reinforced', () => {
    store.createMarker('m0', 'fear', 0.5);                              // 0
    store.createMarker('m2', 'joy', 0.5);
    store.getSomaticResponse(['m2']); store.getSomaticResponse(['m2']); // 2
    store.createMarker('m1', 'calm', 0.5);
    store.getSomaticResponse(['m1']);                                   // 1
    store.createMarker('m0b', 'pride', 0.5);                           // 0

    expect(store.prune({ retentionDays: 0, maxRows: 2 })).toBe(2);
    expect(store.getAllMarkers().map((m) => m.triggerPattern).sort()).toEqual(['m1', 'm2']);
  });

  it('SM-9: prune is a no-op within bounds and when disabled (0/0)', () => {
    store.createMarker('keepme', 'calm', 0.5);
    expect(store.prune({ retentionDays: 30, maxRows: 100 })).toBe(0);
    expect(store.prune({ retentionDays: 0, maxRows: 0 })).toBe(0);
    expect(store.getAllMarkers()).toHaveLength(1);
  });
});

describe('extractTriggerConcepts (somatic-marker trigger keywords)', () => {
  it('extracts salient keywords, skipping short words + stop-words', () => {
    expect(extractTriggerConcepts('I am really frustrated about the deployment failure'))
      .toEqual(['frustrated', 'deployment', 'failure']);
  });

  it('dedupes and caps at max', () => {
    expect(extractTriggerConcepts('budget budget budget overrun crisis panic', 2)).toEqual(['budget', 'overrun']);
  });

  it('returns [] for empty or all-stop-word/short input', () => {
    expect(extractTriggerConcepts('')).toEqual([]);
    expect(extractTriggerConcepts('the and you are')).toEqual([]);
  });
});
