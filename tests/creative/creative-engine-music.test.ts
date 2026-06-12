/**
 * @file tests/creative/creative-engine-music.test.ts
 * @description H5 honesty fix — composeMusic produces a text spec, not audio;
 * its description must say so instead of asserting instrumentation as fact.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { CreativeEngine } from '../../src/core/creative/creative-engine.js';

describe('CreativeEngine.composeMusic (H5 fix)', () => {
  let engine: CreativeEngine;

  beforeEach(() => {
    engine = new CreativeEngine(':memory:');
  });

  afterEach(() => {
    (engine as unknown as { db: Database.Database }).db.close();
  });

  it('CM-1: description is labeled as a spec with suggested instrumentation', () => {
    const c = engine.composeMusic('epic', 60);
    expect(c.description.startsWith('Spec for a ')).toBe(true);
    expect(c.description).toContain('Suggested instrumentation:');
    expect(c.description).not.toMatch(/(^|\. )Instrumentation:/);
  });

  it('CM-2: spec fields stay structurally valid and persisted', () => {
    const c = engine.composeMusic('epic', 60);
    expect(c.tempo).toBeGreaterThan(0);
    expect(c.structure.length).toBeGreaterThan(0);

    const row = (engine as unknown as { db: Database.Database }).db
      .prepare('SELECT description AS d FROM music_compositions WHERE id = ?')
      .get(c.id) as { d: string };
    expect(row.d).toBe(c.description);
  });
});
