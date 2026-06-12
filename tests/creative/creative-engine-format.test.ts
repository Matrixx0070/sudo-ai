/**
 * @file tests/creative/creative-engine-format.test.ts
 * @description Hermetic tests for CreativeEngine format invention after the
 * D2 deception fix: estimatedViralScore is a constant 50 baseline (was
 * Math.random persisted as a ranking metric), getFormats orders by
 * created_at, and formatFormat no longer surfaces a fake viral score.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { CreativeEngine } from '../../src/core/creative/creative-engine.js';
import { formatFormat } from '../../src/core/tools/builtin/meta/creative-formatters.js';

describe('CreativeEngine format invention (D2 fix)', () => {
  let engine: CreativeEngine;

  beforeEach(() => {
    engine = new CreativeEngine(':memory:');
  });

  afterEach(() => {
    (engine as unknown as { db: Database.Database }).db.close();
  });

  it('inventFormat assigns the constant 50 baseline score', () => {
    const fmt = engine.inventFormat('fitness');
    expect(fmt.estimatedViralScore).toBe(50);

    const row = (engine as unknown as { db: Database.Database }).db
      .prepare('SELECT estimated_viral_score AS s FROM content_formats WHERE id = ?')
      .get(fmt.id) as { s: number };
    expect(row.s).toBe(50);
  });

  it('getFormats orders by created_at DESC, not by viral score', () => {
    const older = engine.inventFormat('fitness');
    const newer = engine.inventFormat('cooking');

    const db = (engine as unknown as { db: Database.Database }).db;
    db.prepare(
      "UPDATE content_formats SET created_at = '2020-01-01T00:00:00.000Z', estimated_viral_score = 99 WHERE id = ?"
    ).run(older.id);
    db.prepare(
      "UPDATE content_formats SET created_at = '2025-01-01T00:00:00.000Z' WHERE id = ?"
    ).run(newer.id);

    const formats = engine.getFormats();
    expect(formats.map(f => f.id)).toEqual([newer.id, older.id]);
  });

  it('formatFormat output does not mention a viral score', () => {
    const fmt = engine.inventFormat('fitness');
    expect(formatFormat(fmt).toLowerCase()).not.toContain('viral');
  });
});
