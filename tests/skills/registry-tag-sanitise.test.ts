/**
 * @file registry-tag-sanitise.test.ts
 * @description The registry index is third-party-published external data.
 * Live incident (RepairFlywheel-flagged, recurring since 2026-07-12, root
 * cause found 2026-07-30): two published skills carried an unquoted YAML
 * number in their tag list (`tags: [..., 1099, ...]` — the tax form), which
 * arrives as a JSON number; every consumer calling `t.toLowerCase()` crashed
 * with "skill.search failed: t.toLowerCase is not a function".
 *
 * fetchIndex now normalises display fields: primitive tags/capabilities are
 * stringified, non-primitives dropped, non-string description/changelog/author
 * discarded. Display junk degrades — it never crashes and never rejects the
 * whole index.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { SkillRegistryClient, normaliseEntryDisplayFields } from '../../src/core/skills/registry-client.js';
import type { RegistrySkillEntry } from '../../src/core/skills/registry-client.js';
import { searchTool } from '../../src/core/tools/builtin/skill/tools/search.js';
import type { ToolContext } from '../../src/core/tools/types.js';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const SKILL_MD = '# T\nx\n';

function writeIndexWithNumericTag(dir: string): string {
  mkdirSync(join(dir, 'skills', 'smb-tax-prep'), { recursive: true });
  writeFileSync(join(dir, 'skills', 'smb-tax-prep', 'SKILL.md'), SKILL_MD, 'utf8');
  const index = {
    registry: 'test',
    schema: 1,
    skills: [
      {
        name: 'smb-tax-prep',
        version: '1.0.0',
        description: 'Quarterly tax packet prep.',
        path: 'skills/smb-tax-prep/SKILL.md',
        sha256: sha(SKILL_MD),
        capabilities: [],
        // The live shape that crashed skill.search: an unquoted YAML number.
        tags: ['small-business', 'tax', 'quarterly', 1099, 'accountant', 'packet'],
      },
    ],
  };
  const indexPath = join(dir, 'index.json');
  writeFileSync(indexPath, JSON.stringify(index), 'utf8');
  return indexPath;
}

let dir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skill-registry-tags-'));
  for (const k of ['SUDO_SKILL_REGISTRY', 'SUDO_SKILL_REGISTRY_URL']) savedEnv[k] = process.env[k];
  delete process.env['SUDO_SKILL_REGISTRY'];
  delete process.env['SUDO_SKILL_REGISTRY_URL'];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('normaliseEntryDisplayFields', () => {
  it('TAG-1: stringifies primitive tags and drops non-primitives', () => {
    const entry = {
      name: 'x', version: '1', path: 'p', sha256: 'h',
      tags: ['tax', 1099, true, null, { a: 1 }, ['nested']],
    } as unknown as RegistrySkillEntry;
    normaliseEntryDisplayFields(entry);
    expect(entry.tags).toEqual(['tax', '1099', 'true']);
  });

  it('TAG-2: drops a non-array tags value and non-string description', () => {
    const entry = {
      name: 'x', version: '1', path: 'p', sha256: 'h',
      tags: 'not-an-array', description: 42,
    } as unknown as RegistrySkillEntry;
    normaliseEntryDisplayFields(entry);
    expect(entry.tags).toBeUndefined();
    expect(entry.description).toBeUndefined();
  });

  it('TAG-3: leaves fully-valid entries untouched', () => {
    const entry = {
      name: 'x', version: '1', path: 'p', sha256: 'h',
      description: 'd', tags: ['a', 'b'], capabilities: ['c'],
    } as unknown as RegistrySkillEntry;
    normaliseEntryDisplayFields(entry);
    expect(entry).toEqual({
      name: 'x', version: '1', path: 'p', sha256: 'h',
      description: 'd', tags: ['a', 'b'], capabilities: ['c'],
    });
  });
});

describe('fetchIndex + skill.search with the live crashing index shape', () => {
  it('TAG-4: fetchIndex accepts the index and stringifies the numeric tag', async () => {
    const indexPath = writeIndexWithNumericTag(dir);
    const { index } = await new SkillRegistryClient([indexPath]).fetchIndex();
    expect(index.skills[0]!.tags).toEqual(['small-business', 'tax', 'quarterly', '1099', 'accountant', 'packet']);
  });

  it('TAG-5: skill.search no longer crashes and matches the stringified tag', async () => {
    const indexPath = writeIndexWithNumericTag(dir);
    process.env['SUDO_SKILL_REGISTRY_URL'] = indexPath;
    const ctx = { sessionId: 'test' } as unknown as ToolContext;

    // Regression: this exact call previously returned
    // "skill.search failed: t.toLowerCase is not a function".
    const res = await searchTool.execute({ query: '1099' }, ctx);

    expect(res.success).toBe(true);
    expect(res.output).toContain('smb-tax-prep');
    expect(res.output).not.toContain('toLowerCase');
  });
});
