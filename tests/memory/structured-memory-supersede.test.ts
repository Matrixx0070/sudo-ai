/**
 * @file tests/memory/structured-memory-supersede.test.ts
 * @description Contradiction resolution (opt-in, SUDO_MEMORY_SUPERSEDE=1): a
 * newer fact about the same subject (same type+name) supersedes older active
 * ones, so recall returns the current value instead of letting contradictory
 * facts coexist. Default-off preserves the prior accrete behaviour. Workspace
 * is redirected via SUDO_AI_HOME (set in vi.hoisted, before paths resolve).
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const { ROOT, priorHome, priorData } = vi.hoisted(() => {
  const base = (process.env['TMPDIR'] || '/tmp').replace(/\/+$/, '');
  const root = `${base}/sudo-mem-supersede-test`;
  const priorHome = process.env['SUDO_AI_HOME'];
  const priorData = process.env['DATA_DIR'];
  process.env['SUDO_AI_HOME'] = root;
  delete process.env['DATA_DIR']; // let DATA_DIR derive from PROJECT_ROOT (=ROOT)
  return { ROOT: root, priorHome, priorData };
});

import { saveMemory, listMemories, searchMemories } from '../../src/core/memory/structured-memory.js';
import { DATA_DIR } from '../../src/core/shared/paths.js';

const STORE = path.join(DATA_DIR, 'structured-memory');
const fact = (name: string, content: string) =>
  ({ type: 'user' as const, name, description: 'pref', content });

beforeEach(() => {
  rmSync(STORE, { recursive: true, force: true });
  mkdirSync(STORE, { recursive: true });
  delete process.env['SUDO_MEMORY_SUPERSEDE'];
});
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  if (priorHome === undefined) delete process.env['SUDO_AI_HOME']; else process.env['SUDO_AI_HOME'] = priorHome;
  if (priorData === undefined) delete process.env['DATA_DIR']; else process.env['DATA_DIR'] = priorData;
  delete process.env['SUDO_MEMORY_SUPERSEDE'];
});

describe('structured-memory contradiction resolution', () => {
  it('SUP-1: default OFF — contradictory facts coexist (back-compat)', async () => {
    await saveMemory(fact('user_frank_editor', 'prefers vim'));
    await saveMemory(fact('user_frank_editor', 'prefers emacs'));
    const all = await listMemories('user');
    expect(all).toHaveLength(2); // both kept, no winner
  });

  it('SUP-2: ON — a newer fact supersedes the older same-key one; recall returns only the new', async () => {
    process.env['SUDO_MEMORY_SUPERSEDE'] = '1';
    const v1 = await saveMemory(fact('user_frank_editor', 'prefers vim'));
    const v2 = await saveMemory(fact('user_frank_editor', 'prefers emacs'));

    const active = await listMemories('user');
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(v2.id);
    expect(active[0].content).toBe('prefers emacs');

    // The old one is kept for audit, tagged with the superseding id.
    const withSuperseded = await listMemories('user', { includeSuperseded: true });
    expect(withSuperseded).toHaveLength(2);
    const old = withSuperseded.find((m) => m.id === v1.id)!;
    expect(old.supersededBy).toBe(v2.id);
    expect(old.supersededAt).toBeTruthy();
  });

  it('SUP-3: ON — different subjects (names) do NOT supersede each other', async () => {
    process.env['SUDO_MEMORY_SUPERSEDE'] = '1';
    await saveMemory(fact('user_frank_editor', 'prefers vim'));
    await saveMemory(fact('user_frank_coffee', 'likes espresso'));
    expect(await listMemories('user')).toHaveLength(2); // distinct facts both active
  });

  it('SUP-4: ON — name match is case-insensitive', async () => {
    process.env['SUDO_MEMORY_SUPERSEDE'] = '1';
    await saveMemory(fact('User_Frank_Editor', 'prefers vim'));
    await saveMemory(fact('user_frank_editor', 'prefers emacs'));
    expect(await listMemories('user')).toHaveLength(1);
  });

  it('SUP-5: ON — search returns only the current fact, not the superseded one', async () => {
    process.env['SUDO_MEMORY_SUPERSEDE'] = '1';
    await saveMemory(fact('user_frank_editor', 'prefers vim the old editor'));
    await saveMemory(fact('user_frank_editor', 'prefers emacs the new editor'));
    const hits = await searchMemories({ query: 'editor', type: 'user' });
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toContain('emacs');
  });
});
