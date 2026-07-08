/**
 * @file injector-truncation.test.ts
 * @description Tests for workspace injector tail-truncation (token-cost cap)
 * and end-to-end injection behaviour with oversized files.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  injectWorkspaceContext,
  truncateForInjection,
  injectCap,
  MAX_INJECT_CHARS,
  DAILY_INJECT_CHARS,
} from '../../src/core/workspace/injector.js';

const ENV_KEYS = ['SUDO_INJECT_TODAY_MAX', 'SUDO_INJECT_MEMORY_MAX'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

interface Msg {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
}

function makeSession(peerId?: string): { id: string; messages: Msg[]; peerId?: string } {
  return { id: 'test-session', messages: [], peerId };
}

function isoDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

describe('truncateForInjection', () => {
  it('returns short content unchanged', () => {
    const content = 'short memory note';
    expect(truncateForInjection(content)).toBe(content);
  });

  it('returns content exactly at the limit unchanged', () => {
    const content = 'x'.repeat(MAX_INJECT_CHARS);
    expect(truncateForInjection(content)).toBe(content);
  });

  it('tail-truncates oversized content and keeps the newest (bottom) entries', () => {
    const oldLine = 'OLD-ENTRY-SHOULD-BE-DROPPED';
    const newLine = 'NEW-ENTRY-MUST-SURVIVE';
    const filler = Array.from({ length: 2000 }, (_, i) => `- [entry ${i}] filler line`).join('\n');
    const content = `${oldLine}\n${filler}\n${newLine}`;
    expect(content.length).toBeGreaterThan(MAX_INJECT_CHARS);

    const result = truncateForInjection(content);
    expect(result).toContain(newLine);
    expect(result).not.toContain(oldLine);
    expect(result.startsWith('[...truncated:')).toBe(true);
    // Marker line + tail must stay within limit + marker overhead.
    expect(result.length).toBeLessThanOrEqual(MAX_INJECT_CHARS + 100);
  });

  it('respects a custom maxChars', () => {
    const content = 'a'.repeat(500);
    const result = truncateForInjection(content, 100);
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result).toContain('[...truncated:');
  });
});

describe('injectCap', () => {
  it('returns the fallback when unset/empty', () => {
    expect(injectCap('SUDO_INJECT_TODAY_MAX', 4_096)).toBe(4_096);
    process.env['SUDO_INJECT_TODAY_MAX'] = '';
    expect(injectCap('SUDO_INJECT_TODAY_MAX', 4_096)).toBe(4_096);
  });

  it('parses a positive integer override', () => {
    process.env['SUDO_INJECT_TODAY_MAX'] = '2048';
    expect(injectCap('SUDO_INJECT_TODAY_MAX', 4_096)).toBe(2_048);
  });

  it('rejects invalid values (NaN, zero, negative) → fallback', () => {
    for (const bad of ['abc', '0', '-5', 'NaN']) {
      process.env['SUDO_INJECT_TODAY_MAX'] = bad;
      expect(injectCap('SUDO_INJECT_TODAY_MAX', 4_096)).toBe(4_096);
    }
  });
});

describe('injectWorkspaceContext with oversized files', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(tmpdir(), 'injector-test-'));
    await mkdir(path.join(workspaceDir, 'memory'), { recursive: true });
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('injects an oversized MEMORY.md truncated to the cap', async () => {
    const bigMemory =
      'TOP-OF-FILE-OLD\n' +
      Array.from({ length: 3000 }, (_, i) => `- [2026-01-01] lesson ${i}`).join('\n') +
      '\nBOTTOM-OF-FILE-NEW';
    await writeFile(path.join(workspaceDir, 'MEMORY.md'), bigMemory, 'utf-8');

    const session = makeSession('owner');
    await injectWorkspaceContext(session, {
      config: { workspaceDir, mainPeerId: 'owner' },
    });

    const memMsg = session.messages.find(
      (m) => m.role === 'system' && m.content.startsWith('## Long-Term Memory\n'),
    );
    expect(memMsg).toBeDefined();
    expect(memMsg!.content).toContain('BOTTOM-OF-FILE-NEW');
    expect(memMsg!.content).not.toContain('TOP-OF-FILE-OLD');
    expect(memMsg!.content.length).toBeLessThanOrEqual(MAX_INJECT_CHARS + 200);
  });

  it('injects a small daily log unchanged', async () => {
    const today = `${isoDate(0)}.md`;
    const note = '- did a thing today';
    await writeFile(path.join(workspaceDir, 'memory', today), note, 'utf-8');

    const session = makeSession();
    await injectWorkspaceContext(session, { config: { workspaceDir } });

    const todayMsg = session.messages.find(
      (m) => m.role === 'system' && m.content.startsWith('## Today\n'),
    );
    expect(todayMsg).toBeDefined();
    expect(todayMsg!.content).toBe(`## Today\n${note}`);
  });

  it('daily log over the 4KB default cap is tail-trimmed; MEMORY.md keeps its 10KB cap', async () => {
    const today = `${isoDate(0)}.md`;
    const oldLine = 'OLD-DAILY-ENTRY-TRIMMED';
    const newLine = 'NEW-DAILY-ENTRY-KEPT';
    const filler = Array.from({ length: 400 }, (_, i) => `- [tick ${i}] heartbeat note`).join('\n');
    const daily = `${oldLine}\n${filler}\n${newLine}`;
    expect(daily.length).toBeGreaterThan(DAILY_INJECT_CHARS);
    expect(daily.length).toBeLessThan(MAX_INJECT_CHARS + 5_000);
    await writeFile(path.join(workspaceDir, 'memory', today), daily, 'utf-8');
    // MEMORY.md between the two caps: must survive intact under its 10KB cap.
    const mem = 'MEM-TOP\n' + 'm'.repeat(6_000) + '\nMEM-BOTTOM';
    await writeFile(path.join(workspaceDir, 'MEMORY.md'), mem, 'utf-8');

    const session = makeSession('owner');
    await injectWorkspaceContext(session, { config: { workspaceDir, mainPeerId: 'owner' } });

    const todayMsg = session.messages.find((m) => m.content.startsWith('## Today\n'))!;
    expect(todayMsg.content).toContain(newLine);
    expect(todayMsg.content).not.toContain(oldLine);
    expect(todayMsg.content.length).toBeLessThanOrEqual(DAILY_INJECT_CHARS + 200);

    const memMsg = session.messages.find((m) => m.content.startsWith('## Long-Term Memory\n'))!;
    expect(memMsg.content).toContain('MEM-TOP');
    expect(memMsg.content).toContain('MEM-BOTTOM');
    expect(memMsg.content).not.toContain('[...truncated:');
  });

  it('SUDO_INJECT_TODAY_MAX env overrides the daily cap', async () => {
    process.env['SUDO_INJECT_TODAY_MAX'] = '150';
    const today = `${isoDate(0)}.md`;
    await writeFile(path.join(workspaceDir, 'memory', today), 'a'.repeat(500) + '\nSURVIVOR', 'utf-8');

    const session = makeSession();
    await injectWorkspaceContext(session, { config: { workspaceDir } });

    const todayMsg = session.messages.find((m) => m.content.startsWith('## Today\n'))!;
    expect(todayMsg.content).toContain('[...truncated:');
    expect(todayMsg.content).toContain('SURVIVOR');
    expect(todayMsg.content).not.toContain('a'.repeat(300));
  });

  it('remains idempotent after truncated injection', async () => {
    const big = 'x\n'.repeat(20_000);
    await writeFile(path.join(workspaceDir, 'memory', `${isoDate(0)}.md`), big, 'utf-8');

    const session = makeSession();
    await injectWorkspaceContext(session, { config: { workspaceDir } });
    const countAfterFirst = session.messages.length;
    await injectWorkspaceContext(session, { config: { workspaceDir } });
    expect(session.messages.length).toBe(countAfterFirst);
  });
});
