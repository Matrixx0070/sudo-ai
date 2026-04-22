/**
 * Tests for capability enforcement at loader level (loader.ts Wave 10 extension).
 * Also tests markdown-loader.ts canonical frontmatter parsing.
 */

import { describe, it, expect } from 'vitest';
import { enforceCapabilityPolicy, parseAndEnforceCaps } from '../../src/core/skills/loader.js';
import { loadMarkdownSkills } from '../../src/core/skills/markdown-loader.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// enforceCapabilityPolicy
// ---------------------------------------------------------------------------

describe('enforceCapabilityPolicy()', () => {
  it('returns all caps when all permitted for bundled', () => {
    const caps = ['fs.read', 'fs.write', 'shell.exec'];
    const result = enforceCapabilityPolicy(caps, 'bundled');
    expect(result).toEqual(caps);
  });

  it('trims fs.write and shell.exec for indexed tier', () => {
    const caps = ['fs.read', 'fs.write', 'net.fetch', 'shell.exec'];
    const result = enforceCapabilityPolicy(caps, 'indexed');
    expect(result).toContain('fs.read');
    expect(result).toContain('net.fetch');
    expect(result).not.toContain('fs.write');
    expect(result).not.toContain('shell.exec');
  });

  it('returns only fs.read for unreviewed tier', () => {
    const caps = ['fs.read', 'net.fetch', 'db.write'];
    const result = enforceCapabilityPolicy(caps, 'unreviewed');
    expect(result).toEqual(['fs.read']);
  });

  it('returns empty array when no caps claimed', () => {
    expect(enforceCapabilityPolicy([], 'bundled')).toHaveLength(0);
  });

  it('returns empty array when all caps blocked for unreviewed', () => {
    const caps = ['fs.write', 'shell.exec', 'net.fetch'];
    const result = enforceCapabilityPolicy(caps, 'unreviewed');
    expect(result).toHaveLength(0);
  });

  it('workspace tier permits fs.write but not shell.exec', () => {
    const caps = ['fs.write', 'shell.exec'];
    const result = enforceCapabilityPolicy(caps, 'workspace');
    expect(result).toContain('fs.write');
    expect(result).not.toContain('shell.exec');
  });
});

// ---------------------------------------------------------------------------
// parseAndEnforceCaps
// ---------------------------------------------------------------------------

describe('parseAndEnforceCaps()', () => {
  it('parses caps_json and enforces for known tier', () => {
    const row = {
      name: 'test', version: '1', description: null,
      entry_path: '', input_schema: '', output_schema: '',
      trust_tier: 'indexed',
      caps_json: JSON.stringify(['fs.read', 'net.fetch', 'fs.write']),
    };
    const result = parseAndEnforceCaps(row);
    expect(result).toContain('fs.read');
    expect(result).toContain('net.fetch');
    expect(result).not.toContain('fs.write');
  });

  it('defaults to unreviewed for unknown tier string', () => {
    const row = {
      name: 'test', version: '1', description: null,
      entry_path: '', input_schema: '', output_schema: '',
      trust_tier: 'invalid_tier',
      caps_json: JSON.stringify(['fs.read', 'net.fetch']),
    };
    const result = parseAndEnforceCaps(row);
    expect(result).toEqual(['fs.read']);
  });

  it('returns empty array when no caps_json', () => {
    const row = {
      name: 'test', version: '1', description: null,
      entry_path: '', input_schema: '', output_schema: '',
      trust_tier: 'bundled',
      caps_json: undefined,
    };
    const result = parseAndEnforceCaps(row);
    expect(result).toHaveLength(0);
  });

  it('returns empty array for malformed caps_json', () => {
    const row = {
      name: 'test', version: '1', description: null,
      entry_path: '', input_schema: '', output_schema: '',
      trust_tier: 'bundled',
      caps_json: 'not-valid-json',
    };
    const result = parseAndEnforceCaps(row);
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// markdown-loader Wave 10 extension (backward compatibility)
// ---------------------------------------------------------------------------

describe('loadMarkdownSkills() Wave 10 canonical frontmatter', () => {
  let dir: string;

  function setup(): string {
    const d = join(tmpdir(), `cap-policy-${randomUUID()}`);
    mkdirSync(d, { recursive: true });
    return d;
  }

  function cleanup(d: string): void {
    try { rmSync(d, { recursive: true }); } catch { /* ignore */ }
  }

  it('loads existing skills without new fields (backward compatible)', async () => {
    dir = setup();
    writeFileSync(join(dir, 'old.md'), `---
name: old-skill
description: A legacy skill
---
Legacy body
`);
    const skills = await loadMarkdownSkills(dir);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe('old-skill');
    expect(skills[0]!.version).toBeUndefined();
    expect(skills[0]!.trust_tier).toBeUndefined();
    expect(skills[0]!.caps).toBeUndefined();
    cleanup(dir);
  });

  it('parses Wave 10 canonical frontmatter fields', async () => {
    dir = setup();
    writeFileSync(join(dir, 'new.md'), `---
name: new-skill
description: A Wave 10 skill
version: 1.2.0
source: github:owner/repo/new.md
trust_tier: indexed
caps: [fs.read, net.fetch]
provenance: owner@example.com
---
Body text
`);
    const skills = await loadMarkdownSkills(dir);
    expect(skills).toHaveLength(1);
    const skill = skills[0]!;
    expect(skill.version).toBe('1.2.0');
    expect(skill.source).toBe('github:owner/repo/new.md');
    expect(skill.trust_tier).toBe('indexed');
    expect(skill.caps).toEqual(expect.arrayContaining(['fs.read', 'net.fetch']));
    expect(skill.provenance).toBe('owner@example.com');
    cleanup(dir);
  });

  it('rejects invalid trust_tier values (keeps undefined)', async () => {
    dir = setup();
    writeFileSync(join(dir, 'bad-tier.md'), `---
name: bad-tier-skill
trust_tier: superadmin
---
Body
`);
    const skills = await loadMarkdownSkills(dir);
    expect(skills[0]!.trust_tier).toBeUndefined();
    cleanup(dir);
  });

  it('parses caps as comma-separated string', async () => {
    dir = setup();
    writeFileSync(join(dir, 'caps-str.md'), `---
name: caps-str-skill
caps: fs.read, net.fetch, db.read
---
Body
`);
    const skills = await loadMarkdownSkills(dir);
    const caps = skills[0]!.caps;
    expect(caps).toBeDefined();
    expect(caps).toContain('fs.read');
    expect(caps).toContain('net.fetch');
    cleanup(dir);
  });
});
