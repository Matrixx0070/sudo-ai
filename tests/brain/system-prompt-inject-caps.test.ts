/**
 * @file system-prompt-inject-caps.test.ts
 * @description Per-section byte caps on the memory blocks assembleSystemPrompt
 * injects on EVERY brain call:
 *
 *  - Recent Memory (daily log / memoryContext) — SUDO_INJECT_RECENT_MAX,
 *    default DAILY_INJECT_CHARS (4KB). Tail-kept with a trim marker.
 *  - Under-cap content is injected verbatim (exact current behavior).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { assembleSystemPrompt } from '../../src/core/brain/system-prompt.js';
import { DAILY_INJECT_CHARS } from '../../src/core/workspace/injector.js';

const ENV_KEYS = ['SUDO_INJECT_RECENT_MAX', 'SUDO_INJECT_TODAY_MAX', 'SUDO_INJECT_MEMORY_MAX'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('assembleSystemPrompt Recent Memory cap', () => {
  it('under-cap memoryContext is injected verbatim (behavior preserved)', async () => {
    const memoryContext = 'UNIQUE-SMALL-MEMORY-NOTE-12345';
    const prompt = await assembleSystemPrompt({ memoryContext });
    expect(prompt).toContain('## Recent Memory');
    expect(prompt).toContain(memoryContext);
    expect(prompt).not.toContain('[...truncated:');
  });

  it('over-cap memoryContext is tail-trimmed with the marker (default 4KB cap)', async () => {
    const head = 'OLDEST-ENTRY-MUST-BE-TRIMMED';
    const tail = 'NEWEST-ENTRY-MUST-SURVIVE';
    const filler = Array.from({ length: 800 }, (_, i) => `- [entry ${i}] daily log line`).join('\n');
    const memoryContext = `${head}\n${filler}\n${tail}`;
    expect(memoryContext.length).toBeGreaterThan(DAILY_INJECT_CHARS);

    const prompt = await assembleSystemPrompt({ memoryContext });
    expect(prompt).toContain('[...truncated:');
    expect(prompt).toContain(tail);
    expect(prompt).not.toContain(head);
  });

  it('SUDO_INJECT_RECENT_MAX tunes the cap', async () => {
    process.env['SUDO_INJECT_RECENT_MAX'] = '120';
    const tail = 'TINY-CAP-SURVIVOR';
    const memoryContext = `${'x'.repeat(500)}\n${tail}`;
    const prompt = await assembleSystemPrompt({ memoryContext });
    expect(prompt).toContain('[...truncated:');
    expect(prompt).toContain(tail);
    expect(prompt).not.toContain('x'.repeat(200));
  });

  it('invalid env value falls back to the default cap (no trim under 4KB)', async () => {
    process.env['SUDO_INJECT_RECENT_MAX'] = 'not-a-number';
    const memoryContext = 'y'.repeat(1_000); // < 4KB default
    const prompt = await assembleSystemPrompt({ memoryContext });
    expect(prompt).toContain('y'.repeat(1_000));
    expect(prompt).not.toContain('[...truncated:');
  });
});
