/**
 * @file markdown-loader-capability-flags.test.ts
 * @description Q4 — tests for the isReadOnly / isConcurrencySafe scheduler-hint
 * fields added to SKILL.md frontmatter parsing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadMarkdownSkills } from '../../src/core/skills/markdown-loader.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'skill-flags-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeSkillFile(name: string, frontmatter: Record<string, string>, body = 'body'): Promise<void> {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  await writeFile(path.join(dir, `${name}.md`), `---\n${fm}\n---\n${body}`);
}

async function writeDirSkill(name: string, frontmatter: Record<string, string>, body = 'body'): Promise<void> {
  const sub = path.join(dir, name);
  await mkdir(sub, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  await writeFile(path.join(sub, 'SKILL.md'), `---\n${fm}\n---\n${body}`);
}

describe('isReadOnly / isConcurrencySafe — flat-file frontmatter', () => {
  it('parses both flags as true when declared "true"', async () => {
    await writeSkillFile('alpha', {
      name: 'alpha',
      description: 'Test',
      isReadOnly: 'true',
      isConcurrencySafe: 'true',
    });
    const [skill] = await loadMarkdownSkills(dir);
    expect(skill?.isReadOnly).toBe(true);
    expect(skill?.isConcurrencySafe).toBe(true);
  });

  it('parses both flags as false when declared "false"', async () => {
    await writeSkillFile('beta', {
      name: 'beta',
      description: 'Test',
      isReadOnly: 'false',
      isConcurrencySafe: 'false',
    });
    const [skill] = await loadMarkdownSkills(dir);
    expect(skill?.isReadOnly).toBe(false);
    expect(skill?.isConcurrencySafe).toBe(false);
  });

  it('is case-insensitive on the boolean string', async () => {
    await writeSkillFile('gamma', {
      name: 'gamma',
      description: 'Test',
      isReadOnly: 'TRUE',
      isConcurrencySafe: 'False',
    });
    const [skill] = await loadMarkdownSkills(dir);
    expect(skill?.isReadOnly).toBe(true);
    expect(skill?.isConcurrencySafe).toBe(false);
  });

  it('leaves both undefined when the keys are missing (backward compatible)', async () => {
    await writeSkillFile('delta', { name: 'delta', description: 'Test' });
    const [skill] = await loadMarkdownSkills(dir);
    expect(skill?.isReadOnly).toBeUndefined();
    expect(skill?.isConcurrencySafe).toBeUndefined();
  });

  it('coerces non-boolean strings to undefined (no false-positive parse)', async () => {
    await writeSkillFile('epsilon', {
      name: 'epsilon',
      description: 'Test',
      isReadOnly: 'yes',
      isConcurrencySafe: 'maybe',
    });
    const [skill] = await loadMarkdownSkills(dir);
    expect(skill?.isReadOnly).toBeUndefined();
    expect(skill?.isConcurrencySafe).toBeUndefined();
  });

  it('handles only one of the two flags being set', async () => {
    await writeSkillFile('zeta', {
      name: 'zeta',
      description: 'Test',
      isReadOnly: 'true',
    });
    const [skill] = await loadMarkdownSkills(dir);
    expect(skill?.isReadOnly).toBe(true);
    expect(skill?.isConcurrencySafe).toBeUndefined();
  });
});

describe('isReadOnly / isConcurrencySafe — directory layout (agentskills.io)', () => {
  it('parses flags from <skill>/SKILL.md', async () => {
    await writeDirSkill('eta', {
      name: 'eta',
      description: 'Test',
      isReadOnly: 'true',
      isConcurrencySafe: 'true',
    });
    const skills = await loadMarkdownSkills(dir);
    const eta = skills.find((s) => s.name === 'eta');
    expect(eta?.isReadOnly).toBe(true);
    expect(eta?.isConcurrencySafe).toBe(true);
  });
});

describe('isReadOnly / isConcurrencySafe — does not regress other frontmatter fields', () => {
  it('still parses trust_tier, caps, version, source alongside the new flags', async () => {
    await writeSkillFile('theta', {
      name: 'theta',
      description: 'Test',
      version: '1.2.3',
      source: 'github:owner/repo',
      trust_tier: 'bundled',
      caps: '[fs.read, db.read]',
      isReadOnly: 'true',
      isConcurrencySafe: 'true',
    });
    const [skill] = await loadMarkdownSkills(dir);
    expect(skill?.version).toBe('1.2.3');
    expect(skill?.source).toBe('github:owner/repo');
    expect(skill?.trust_tier).toBe('bundled');
    expect(skill?.caps).toEqual(['fs.read', 'db.read']);
    expect(skill?.isReadOnly).toBe(true);
    expect(skill?.isConcurrencySafe).toBe(true);
  });
});
