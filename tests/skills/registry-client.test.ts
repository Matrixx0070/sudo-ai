/**
 * Tests for the remote skill-registry client.
 *
 * Core contract: only content that hashes to the index's SHA-256 pin is ever
 * returned; malformed indexes, traversal paths, oversized payloads, and the
 * kill-switch all fail closed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  SkillRegistryClient,
  isSkillRegistryEnabled,
  registryUrls,
  validateEntry,
  MAX_SKILL_BYTES,
} from '../../src/core/skills/registry-client.js';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const GOOD_SKILL = `---
name: test-skill
version: 1.0.0
description: A test skill.
capabilities: []
---
# Test Skill
Do the test thing.
`;

function writeRegistry(dir: string, opts: { sha?: string; path?: string; schema?: number; skills?: unknown[] } = {}): string {
  mkdirSync(join(dir, 'skills', 'test-skill'), { recursive: true });
  writeFileSync(join(dir, 'skills', 'test-skill', 'SKILL.md'), GOOD_SKILL, 'utf8');
  const index = {
    registry: 'test',
    schema: opts.schema ?? 1,
    skills: opts.skills ?? [
      {
        name: 'test-skill',
        version: '1.0.0',
        description: 'A test skill.',
        path: opts.path ?? 'skills/test-skill/SKILL.md',
        sha256: opts.sha ?? sha(GOOD_SKILL),
        capabilities: [],
        tags: ['testing'],
      },
    ],
  };
  const indexPath = join(dir, 'index.json');
  writeFileSync(indexPath, JSON.stringify(index), 'utf8');
  return indexPath;
}

describe('SkillRegistryClient (local-path registry)', () => {
  let dir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skill-registry-'));
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

  it('fetches and validates an index from a local path', async () => {
    const indexPath = writeRegistry(dir);
    const client = new SkillRegistryClient([indexPath]);
    const { index, sourceUrl } = await client.fetchIndex();
    expect(index.skills).toHaveLength(1);
    expect(sourceUrl).toBe(indexPath);
  });

  it('resolves by name case-insensitively and by exact version', async () => {
    const indexPath = writeRegistry(dir);
    const client = new SkillRegistryClient([indexPath]);
    expect((await client.resolve('TEST-SKILL'))?.entry.name).toBe('test-skill');
    expect((await client.resolve('test-skill', '1.0.0'))?.entry.version).toBe('1.0.0');
    expect(await client.resolve('test-skill', '9.9.9')).toBeUndefined();
    expect(await client.resolve('nope')).toBeUndefined();
  });

  it('returns checksum-verified content', async () => {
    const indexPath = writeRegistry(dir);
    const client = new SkillRegistryClient([indexPath]);
    const fetched = await client.fetchSkill('test-skill');
    expect(fetched.markdown).toBe(GOOD_SKILL);
    expect(fetched.entry.sha256).toBe(sha(GOOD_SKILL));
  });

  it('refuses content whose hash does not match the pin', async () => {
    const indexPath = writeRegistry(dir, { sha: sha('something else entirely') });
    const client = new SkillRegistryClient([indexPath]);
    await expect(client.fetchSkill('test-skill')).rejects.toThrow(/Checksum mismatch/);
  });

  it('rejects traversal paths at index validation', async () => {
    const indexPath = writeRegistry(dir, { path: '../outside/SKILL.md' });
    const client = new SkillRegistryClient([indexPath]);
    await expect(client.fetchIndex()).rejects.toThrow(/invalid path/);
  });

  it('rejects absolute and scheme paths at index validation', () => {
    expect(validateEntry({ name: 'a', version: '1', sha256: sha('x'), path: '/etc/passwd' })).not.toHaveLength(0);
    expect(validateEntry({ name: 'a', version: '1', sha256: sha('x'), path: 'https://evil.example/SKILL.md' })).not.toHaveLength(0);
    expect(validateEntry({ name: 'a', version: '1', sha256: sha('x'), path: 'skills/a/SKILL.md' })).toHaveLength(0);
  });

  it('rejects malformed indexes (wrong schema / skills shape)', async () => {
    const badSchema = writeRegistry(dir, { schema: 2 });
    await expect(new SkillRegistryClient([badSchema]).fetchIndex()).rejects.toThrow(/No skill registry reachable/);
    const dir2 = mkdtempSync(join(tmpdir(), 'skill-registry2-'));
    try {
      const p = join(dir2, 'index.json');
      writeFileSync(p, JSON.stringify({ schema: 1, skills: 'nope' }), 'utf8');
      await expect(new SkillRegistryClient([p]).fetchIndex()).rejects.toThrow();
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('rejects oversized skill content', async () => {
    const big = 'x'.repeat(MAX_SKILL_BYTES + 1);
    mkdirSync(join(dir, 'skills', 'big'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'big', 'SKILL.md'), big, 'utf8');
    const indexPath = join(dir, 'index.json');
    writeFileSync(indexPath, JSON.stringify({
      schema: 1,
      skills: [{ name: 'big', version: '1.0.0', path: 'skills/big/SKILL.md', sha256: sha(big) }],
    }), 'utf8');
    const client = new SkillRegistryClient([indexPath]);
    await expect(client.fetchSkill('big')).rejects.toThrow(/byte cap/);
  });

  it('kill-switch SUDO_SKILL_REGISTRY=0 disables the client', async () => {
    process.env['SUDO_SKILL_REGISTRY'] = '0';
    expect(isSkillRegistryEnabled()).toBe(false);
    const indexPath = writeRegistry(dir);
    await expect(new SkillRegistryClient([indexPath]).fetchIndex()).rejects.toThrow(/disabled/);
  });

  it('SUDO_SKILL_REGISTRY_URL override goes first in the URL order', () => {
    process.env['SUDO_SKILL_REGISTRY_URL'] = '/custom/index.json';
    const urls = registryUrls();
    expect(urls[0]).toBe('/custom/index.json');
    expect(urls.length).toBeGreaterThan(1);
  });
});
