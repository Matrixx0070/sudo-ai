/**
 * BO2b/S1 regression — the prompt-cache tail relocation keeps the request's
 * cacheable region ([stable system prompt] + [append-only history]) byte-stable
 * across turns that differ only in the newest user message + per-turn tail
 * context. Pure-function tests (no daemon, no LLM) so the invariant is enforced
 * in CI.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { relocateVolatileToTail } from '../../src/core/brain/prompt-cache-tail.js';
import type { BrainMessage } from '../../src/core/brain/types.js';

const sys = (content: string, durable = false): BrainMessage =>
  ({ role: 'system', content, ...(durable ? { _durable: true } : {}) }) as BrainMessage;
const user = (content: string): BrainMessage => ({ role: 'user', content });
const asst = (content: string): BrainMessage => ({ role: 'assistant', content });

const hash = (msgs: BrainMessage[]): string =>
  createHash('sha256').update(JSON.stringify(msgs)).digest('hex');

describe('BO2b/S1 prompt-cache tail relocation', () => {
  it('only the newest user message changes — the system + prior-history region is returned byte-identical', () => {
    const base: BrainMessage[] = [
      sys('STABLE PERSONA HEADER', true),
      user('turn 1'),
      asst('pong'),
      sys('AUTO-ROUTING [INTENT: conversation]'), // per-turn, non-durable → relocated
      user('turn 2'),
    ];
    const out = relocateVolatileToTail(base, '## Recent Memory\nlog\n\n## Current Date & Time\nT');

    // Durable header + prior history are the SAME objects, in order, untouched.
    expect(out[0]).toBe(base[0]); // durable persona
    expect(out[1]).toBe(base[1]); // u1
    expect(out[2]).toBe(base[2]); // a1
    // The per-turn AUTO-ROUTING system message is gone from the array (relocated).
    expect(out.some((m) => m.role === 'system' && String(m.content).startsWith('AUTO-ROUTING'))).toBe(false);
    // The newest user message now carries the relocated context BEFORE the question.
    const last = out[out.length - 1]!;
    expect(last.role).toBe('user');
    expect(String(last.content).endsWith('turn 2')).toBe(true);
    expect(String(last.content)).toContain('AUTO-ROUTING [INTENT: conversation]');
    expect(String(last.content)).toContain('## Recent Memory');
  });

  it('cacheable prefix is append-only across two turns (only newest user + tail differ)', () => {
    const durablePersona = sys('STABLE PERSONA HEADER', true);
    // Turn 2 request: prior [u1,a1] + this turn's per-turn system + newest user.
    const turn2: BrainMessage[] = [
      durablePersona,
      user('turn 1'),
      asst('pong'),
      sys('AUTO-ROUTING [INTENT: conversation]'),
      user('turn 2'),
    ];
    // Turn 3 request: history grew append-only (u2,a2 now persisted, tail stripped),
    // fresh per-turn system + newest user + a different volatile block.
    const turn3: BrainMessage[] = [
      durablePersona,
      user('turn 1'),
      asst('pong'),
      user('turn 2'),
      asst('pong'),
      sys('AUTO-ROUTING [INTENT: conversation]'),
      user('turn 3'),
    ];
    const rel2 = relocateVolatileToTail(turn2, '## Recent Memory\nlog-at-turn-2\n\n## Current Date & Time\nT2');
    const rel3 = relocateVolatileToTail(turn3, '## Recent Memory\nlog-at-turn-3-longer\n\n## Current Date & Time\nT3');

    // The shared append-only prefix [persona, u1, a1] must hash identically — this
    // is exactly the region an implicit-prefix cache reuses turn-over-turn.
    expect(hash(rel3.slice(0, 3))).toBe(hash(rel2.slice(0, 3)));
    // And rel3's prefix strictly extends rel2's (append-only, never rewritten).
    expect(rel3.length).toBeGreaterThan(rel2.length);
  });

  it('preserves ALL relocated content (nothing dropped) and dedups the daily log', () => {
    const dailyLog = '- did a thing\n- did another';
    const msgs: BrainMessage[] = [
      sys('PERSONA', true),
      sys(`## Today\n${dailyLog}`),            // duplicate of Recent Memory → deduped
      sys('AUTO-ROUTING [INTENT: x]'),          // per-turn → relocated
      sys('DEEP INSIGHT: be careful'),          // per-turn → relocated
      user('do the task'),
    ];
    const volatile = `## Recent Memory\n${dailyLog}\n\n## Current Date & Time\nT`;
    const out = relocateVolatileToTail(msgs, volatile);
    const tail = String(out[out.length - 1]!.content);

    expect(tail).toContain('AUTO-ROUTING [INTENT: x]');
    expect(tail).toContain('DEEP INSIGHT: be careful');
    expect(tail).toContain('## Recent Memory');
    // The daily-log body appears exactly ONCE (## Today deduped against Recent Memory).
    const occurrences = tail.split(dailyLog).length - 1;
    expect(occurrences).toBe(1);
  });

  it('keeps _durable summaries and session-stable memory in the cached prefix', () => {
    const msgs: BrainMessage[] = [
      sys('PERSONA', true),
      sys('[SESSION FORK — continued from X]\nsummary', true), // durable → prefix
      sys('## Yesterday\nyesterday log'),                       // stable → prefix
      sys('## Long-Term Memory\nfacts'),                        // stable → prefix
      sys('AUTO-ROUTING [INTENT: x]'),                          // per-turn → tail
      user('q'),
    ];
    const out = relocateVolatileToTail(msgs, '## Current Date & Time\nT');
    // durable + stable memory remain as role:'system' in the prefix (cacheable).
    const prefixSystem = out.filter((m) => m.role === 'system').map((m) => String(m.content));
    expect(prefixSystem.some((c) => c.startsWith('[SESSION FORK'))).toBe(true);
    expect(prefixSystem.some((c) => c.startsWith('## Yesterday'))).toBe(true);
    expect(prefixSystem.some((c) => c.startsWith('## Long-Term Memory'))).toBe(true);
    // AUTO-ROUTING moved to the tail user message.
    expect(prefixSystem.some((c) => c.startsWith('AUTO-ROUTING'))).toBe(false);
    expect(String(out[out.length - 1]!.content)).toContain('AUTO-ROUTING');
  });

  it('no per-turn content and no volatile block → returns the input unchanged (byte-identical)', () => {
    const msgs: BrainMessage[] = [sys('PERSONA', true), user('turn 1'), asst('pong'), user('turn 2')];
    const out = relocateVolatileToTail(msgs, '');
    expect(out).toBe(msgs); // reference-equal no-op
  });
});
