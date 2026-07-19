/**
 * @file skill-read.test.ts
 * @description BO6/S3 — (c) read-on-demand. skill.read returns the FULL body of
 * an installed skill by name plus its current version-hash, so the model can
 * pull instructions the catalog only names. Missing skills fail cleanly; the
 * tool never writes (write-firewall preserved).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readTool } from '../../src/core/tools/builtin/skill/tools/read.js';
import { skillHash } from '../../src/core/skills/skill-catalog.js';

let dir: string;
const BODY = '# BO6 Probe Skill\n\nStep 1: do the thing.\nStep 2: verify it.';
const prevRoots = process.env['SUDO_SKILLS_DIRS'];

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bo6-skills-'));
  const skillDir = path.join(dir, 'bo6-probe');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: bo6-probe\ndescription: A probe skill for the read-on-demand test.\n---\n${BODY}`,
  );
  process.env['SUDO_SKILLS_DIRS'] = dir;
});

afterAll(() => {
  if (prevRoots === undefined) delete process.env['SUDO_SKILLS_DIRS'];
  else process.env['SUDO_SKILLS_DIRS'] = prevRoots;
  rmSync(dir, { recursive: true, force: true });
});

const ctx = { sessionId: 'test', workingDir: process.cwd(), config: null, logger: null } as never;

describe('BO6/S3 skill.read — read-on-demand', () => {
  it('returns the real body and the current version-hash for an installed skill', async () => {
    const res = await readTool.execute({ name: 'bo6-probe' }, ctx);
    expect(res.success).toBe(true);
    expect(res.output).toContain('Step 1: do the thing.');
    expect(res.output).toContain('Step 2: verify it.');
    // Body content trimmed by the loader — hash is over the trimmed body.
    const data = res.data as { name: string; hash: string; chars: number };
    expect(data.name).toBe('bo6-probe');
    expect(data.hash).toBe(skillHash(BODY));
    expect(res.output).toContain(data.hash);
  });

  it('matches case-insensitively on the skill name', async () => {
    const res = await readTool.execute({ name: 'BO6-PROBE' }, ctx);
    expect(res.success).toBe(true);
    expect(res.output).toContain('Step 1: do the thing.');
  });

  it('fails cleanly for an unknown skill and lists what IS available', async () => {
    const res = await readTool.execute({ name: 'does-not-exist' }, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toContain('not installed');
    expect(res.output).toContain('bo6-probe');
  });

  it('rejects path-traversal names', async () => {
    const res = await readTool.execute({ name: '../secret' }, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toContain('Invalid skill name');
  });
});
