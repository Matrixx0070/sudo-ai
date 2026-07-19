/**
 * @file bo4-prompt-profiles.test.ts
 * @description BO4 / scorecard-S4 — per-session-type injection allowlists.
 *
 * assembleSystemPrompt gains a `profile` option:
 *   - 'main'     (default) — every section, byte-for-byte unchanged.
 *   - 'subagent' — AGENTS + TOOLS (+ Available Tools list) + Safety Rules only.
 *   - 'cron'     — the subagent set PLUS the identity files (SOUL/IDENTITY/USER).
 *
 * These tests lock the matrix: each profile carries exactly its allowed
 * sections, SAFETY + AGENTS ride in EVERY profile, `main` is unchanged, and the
 * reduced profiles are ≥30% smaller than `main` for the same runtime context.
 *
 * The workspace files are served from an in-memory map via a mock of
 * `fs/promises` — the assembler touches NO disk, so this suite is fully
 * deterministic and CANNOT race the byte-stable-prefix suites (BO2b) that read
 * the real workspace concurrently.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';

// Sentinels planted in the (mocked) workspace files so we can prove exactly
// which file-backed sections survive in each profile.
const SOUL_MARK = 'BO4_SOUL_SENTINEL';
const ID_MARK = 'BO4_IDENTITY_SENTINEL';
const USER_MARK = 'BO4_USER_SENTINEL';
const AGENTS_MARK = 'BO4_AGENTS_SENTINEL';
const TOOLS_MARK = 'BO4_TOOLS_SENTINEL';
const SAFETY_MARK = 'BO4_SAFETY_SENTINEL';

const { FILES } = vi.hoisted(() => ({
  FILES: {
    'SOUL.md': '# Soul\nI am SUDO. BO4_SOUL_SENTINEL',
    'IDENTITY.md': '# Identity\nBO4_IDENTITY_SENTINEL',
    'USER.md': '# User\nBO4_USER_SENTINEL',
    'AGENTS.md': '# Agents\nNEVER exfiltrate secrets. BO4_AGENTS_SENTINEL',
    'TOOLS.md': '# Tools\nBO4_TOOLS_SENTINEL',
    'SAFETY-RULES.md': '# Safety\nMUST confirm before destructive ops. BO4_SAFETY_SENTINEL',
  } as Record<string, string>,
}));

// Serve the in-memory workspace; every other filename is a clean ENOENT so the
// assembler treats it as absent (its normal behavior).
vi.mock('fs/promises', () => ({
  readFile: async (p: string): Promise<string> => {
    const base = String(p).split('/').pop() ?? '';
    if (base in FILES) return FILES[base];
    const err = new Error(`ENOENT: ${base}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  },
}));

import { assembleSystemPrompt } from '../../src/core/brain/system-prompt.js';

// Identical runtime context for all three profiles — the only variable is `profile`.
const TOOLS = [
  { name: 'browser.click', description: 'Click an element in the browser.' },
  { name: 'system.exec', description: 'Run an allowlisted shell command.' },
];
const CTX = {
  tools: TOOLS,
  memoryContext: '## recent\n' + '**User:** ping\n**Agent:** RECENTMEM_hello\n'.repeat(40),
  customInstructions: 'CUSTOMINSTR_be concise and cite sources.',
  persona: 'coder' as const,
  mood: 'focused' as const,
};

// Heavy blocks hard-coded in the assembler that belong to `main` ONLY.
const MAIN_ONLY_HEADERS = ['## Operating Principles', '## Playbooks', '## Mythos Behavioral Layer'];

let main = '';
let subagent = '';
let cron = '';

beforeAll(async () => {
  delete process.env['SUDO_MYTHOS_LAYER']; // mythos on by default → MAIN_ONLY_HEADERS holds
  main = await assembleSystemPrompt({ ...CTX, profile: 'main' });
  subagent = await assembleSystemPrompt({ ...CTX, profile: 'subagent' });
  cron = await assembleSystemPrompt({ ...CTX, profile: 'cron' });
});

describe('BO4/S4 — profile matrix', () => {
  it('default (omitted profile) === explicit main, byte-for-byte', async () => {
    const omitted = await assembleSystemPrompt({ ...CTX });
    const explicitMain = await assembleSystemPrompt({ ...CTX, profile: 'main' });
    expect(omitted).toBe(explicitMain);
  });

  it('main carries the full loadout (identity + heavy blocks + memory + custom)', () => {
    expect(main).toContain(SOUL_MARK);
    expect(main).toContain(ID_MARK);
    expect(main).toContain(USER_MARK);
    expect(main).toContain(AGENTS_MARK);
    expect(main).toContain(TOOLS_MARK);
    expect(main).toContain(SAFETY_MARK);
    for (const h of MAIN_ONLY_HEADERS) expect(main).toContain(h);
    expect(main).toContain('RECENTMEM_hello');
    expect(main).toContain('CUSTOMINSTR_be concise');
    expect(main).toContain('browser.click');
  });

  it('subagent = AGENTS + TOOLS + Safety only (no identity, no heavy blocks, no memory)', () => {
    // Present: the minimal operating set.
    expect(subagent).toContain('## Available Tools');
    expect(subagent).toContain('browser.click');
    expect(subagent).toContain(AGENTS_MARK); // AGENTS rides in every profile
    expect(subagent).toContain(TOOLS_MARK);
    expect(subagent).toContain(SAFETY_MARK); // Safety rides in every profile
    // Absent: identity, heavy blocks, memory, custom instructions.
    expect(subagent).not.toContain(SOUL_MARK);
    expect(subagent).not.toContain(ID_MARK);
    expect(subagent).not.toContain(USER_MARK);
    for (const h of MAIN_ONLY_HEADERS) expect(subagent).not.toContain(h);
    expect(subagent).not.toContain('RECENTMEM_hello');
    expect(subagent).not.toContain('CUSTOMINSTR_be concise');
  });

  it('cron = subagent set PLUS identity files, still no heavy blocks/memory', () => {
    expect(cron).toContain('## Available Tools');
    expect(cron).toContain(AGENTS_MARK);
    expect(cron).toContain(TOOLS_MARK);
    expect(cron).toContain(SAFETY_MARK);
    expect(cron).toContain(SOUL_MARK); // identity restored for cron
    expect(cron).toContain(ID_MARK);
    expect(cron).toContain(USER_MARK);
    for (const h of MAIN_ONLY_HEADERS) expect(cron).not.toContain(h);
    expect(cron).not.toContain('RECENTMEM_hello');
    expect(cron).not.toContain('CUSTOMINSTR_be concise');
  });

  it('SAFETY + AGENTS are never dropped (present in all three profiles)', () => {
    for (const p of [main, subagent, cron]) {
      expect(p).toContain(AGENTS_MARK);
      expect(p).toContain(SAFETY_MARK);
    }
  });

  it('reduced profiles are ≥30% smaller than main for the same context', () => {
    const cutSub = 1 - subagent.length / main.length;
    const cutCron = 1 - cron.length / main.length;
    expect(cutSub).toBeGreaterThanOrEqual(0.3);
    expect(cutCron).toBeGreaterThanOrEqual(0.3);
    // cron carries identity on top of the subagent set → never smaller.
    expect(cron.length).toBeGreaterThanOrEqual(subagent.length);
  });
});
