/**
 * @file wave11-import-persist.test.ts
 * @description Tests for SkillRegistry.registerFromImport (Wave 11 Item 4).
 *
 * Verifies:
 *   1. registerFromImport inserts one row with correct name and sha256.
 *   2. registerFromImport computes version = max_existing + 1.
 *   3. registerFromImport on empty registry creates version 1.
 *   4. After registerFromImport, getSkillMeta returns non-null.
 *   5. Calling registerFromImport twice with same name but different hash increments version.
 *   6. registerFromImport re-throws as SkillRegistryError with code 'INSERT_FAILED' on DB error.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { SkillRegistry, SkillRegistryError } from '../../src/core/skills/registry.js';
import type { SkillManifest } from '../../src/core/shared/wave10-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkTmpDir(): string {
  const dir = join(tmpdir(), `wave11-persist-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeManifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    id: randomUUID(),
    name: 'test-skill',
    version: '1.0.0',
    description: 'A test skill for Wave 11',
    author: 'test-author',
    source: 'github:testuser/testrepo/test-skill.md',
    scheme: 'github',
    caps: ['fs.read'],
    tools: [],
    trust: 'unreviewed',
    contentHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 32),
    importedAt: new Date().toISOString(),
    ...overrides,
  };
}

const RAW_CONTENT = `---
name: test-skill
description: A test skill for Wave 11
author: test-author
caps: [fs.read]
trust_tier: unreviewed
---

# Test Skill

This skill is used for Wave 11 persistence tests.
`;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let db: InstanceType<typeof Database>;
let registry: SkillRegistry;
let skillsDir: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  skillsDir = mkTmpDir();
  registry = new SkillRegistry(db, skillsDir);
});

afterEach(() => {
  try { db.close(); } catch { /* already closed in test #6 */ }
  rmSync(skillsDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SkillRegistry.registerFromImport', () => {
  it('test 1: inserts one row with correct name and sha256', () => {
    const manifest = makeManifest();
    registry.registerFromImport(manifest, RAW_CONTENT);

    const rows = db
      .prepare('SELECT name, sha256 FROM skills WHERE name = ?')
      .all(manifest.name) as Array<{ name: string; sha256: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe(manifest.name);
    expect(rows[0]!.sha256).toBe(manifest.contentHash);
  });

  it('test 2: computes version = max_existing + 1 when skill already has rows', () => {
    // First insert via scanAndRegister to create version 1
    const manifest1 = makeManifest({ contentHash: 'aaa' + 'b'.repeat(61) });
    registry.registerFromImport(manifest1, RAW_CONTENT);

    // Second insert with same name, different hash → should be version 2
    const manifest2 = makeManifest({ contentHash: 'ccc' + 'd'.repeat(61) });
    registry.registerFromImport(manifest2, RAW_CONTENT);

    const rows = db
      .prepare('SELECT version FROM skills WHERE name = ? ORDER BY version')
      .all(manifest1.name) as Array<{ version: number }>;

    expect(rows).toHaveLength(2);
    expect(rows[0]!.version).toBe(1);
    expect(rows[1]!.version).toBe(2);
  });

  it('test 3: on empty registry creates version 1', () => {
    const manifest = makeManifest();
    registry.registerFromImport(manifest, RAW_CONTENT);

    const meta = registry.getSkillMeta(manifest.name);
    expect(meta).not.toBeNull();
    expect(meta!.version).toBe(1);
  });

  it('test 4: after registerFromImport, getSkillMeta returns non-null', () => {
    const manifest = makeManifest({ name: 'persistence-check-skill' });
    expect(registry.getSkillMeta('persistence-check-skill')).toBeNull();

    registry.registerFromImport(manifest, RAW_CONTENT);

    const meta = registry.getSkillMeta('persistence-check-skill');
    expect(meta).not.toBeNull();
    expect(meta!.name).toBe('persistence-check-skill');
    expect(meta!.sha256).toBe(manifest.contentHash);
  });

  it('test 5: calling twice with same name but different contentHash increments version each time', () => {
    const manifest1 = makeManifest({ name: 'versioned-skill', contentHash: 'h1' + 'a'.repeat(62) });
    const manifest2 = makeManifest({ name: 'versioned-skill', contentHash: 'h2' + 'b'.repeat(62) });

    registry.registerFromImport(manifest1, RAW_CONTENT);
    registry.registerFromImport(manifest2, RAW_CONTENT + '\nupdated');

    const meta = registry.getSkillMeta('versioned-skill');
    expect(meta).not.toBeNull();
    // getSkillMeta returns the latest version
    expect(meta!.version).toBe(2);
    expect(meta!.sha256).toBe(manifest2.contentHash);
  });

  it('test 6: re-throws as SkillRegistryError with code INSERT_FAILED on DB error', () => {
    const manifest = makeManifest();
    // Close the database to force a write error
    db.close();

    expect(() => registry.registerFromImport(manifest, RAW_CONTENT)).toThrowError(
      expect.objectContaining({ code: 'INSERT_FAILED' }),
    );
  });
});
