/**
 * @file tests/agent/loop-content-hash.test.ts
 * @description Focused tests for the content-hash recipe used in loop.ts veto gate (A1).
 *
 * The computeContentHash function is a module-level helper in loop.ts (not exported).
 * These tests verify the canonical recipe using the same building blocks
 * (sanitizeArgsForPrompt from veto-gate + node:crypto sha256) so that any
 * deviation in the implementation would cause hash mismatches observable in production.
 *
 * Tests:
 *   CH-1  computeContentHash recipe is deterministic — same input → same hash
 *   CH-2  Different toolName → different hash
 *   CH-3  Different args → different hash
 *   CH-4  Empty args {} → 32-char hex hash
 *   CH-5  Hash is exactly 32 hex characters
 *   CH-6  Hash contains only hex characters [0-9a-f]
 *   CH-7  computeContentHash via VetoOverrideStore roundtrip — store by hash, retrieve by hash
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { sanitizeArgsForPrompt } from '../../src/core/agent/veto-gate.js';
import Database from 'better-sqlite3';
import { VetoOverrideStore } from '../../src/core/agent/veto-override-store.js';

/**
 * Mirrors the computeContentHash function from loop.ts exactly.
 * Must stay in sync with the implementation.
 */
function computeContentHash(toolName: string, args: Record<string, unknown>): string {
  const sanitized = sanitizeArgsForPrompt(args);
  const payload   = `${toolName}:${sanitized}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 32);
}

describe('loop.ts computeContentHash recipe (A1)', () => {
  // CH-1: deterministic — same input → same hash
  it('CH-1: produces the same hash on repeated calls with same inputs', () => {
    const h1 = computeContentHash('read_file', { path: '/foo' });
    const h2 = computeContentHash('read_file', { path: '/foo' });
    expect(h1).toBe(h2);
  });

  // CH-2: different toolName → different hash
  it('CH-2: different toolName produces different hash', () => {
    const hRead  = computeContentHash('read_file',  { path: '/foo' });
    const hWrite = computeContentHash('write_file', { path: '/foo' });
    expect(hRead).not.toBe(hWrite);
  });

  // CH-3: different args → different hash
  it('CH-3: different args produces different hash', () => {
    const hFoo = computeContentHash('read_file', { path: '/foo' });
    const hBar = computeContentHash('read_file', { path: '/bar' });
    expect(hFoo).not.toBe(hBar);
  });

  // CH-4: empty args {} → produces a valid 32-char hex hash
  it('CH-4: empty args {} produces a valid 32-char hex hash', () => {
    const h = computeContentHash('my_tool', {});
    expect(h).toHaveLength(32);
    expect(/^[0-9a-f]+$/.test(h)).toBe(true);
  });

  // CH-5: hash is always exactly 32 hex characters
  it('CH-5: hash length is always exactly 32 characters', () => {
    const cases = [
      computeContentHash('tool', {}),
      computeContentHash('tool_with_long_name_here', { key: 'some value', nested: { a: 1 } }),
      computeContentHash('x', { path: 'a'.repeat(300) }),
    ];
    for (const h of cases) {
      expect(h).toHaveLength(32);
    }
  });

  // CH-6: hash contains only lowercase hex characters
  it('CH-6: hash output contains only lowercase hex characters [0-9a-f]', () => {
    const h = computeContentHash('delete_file', { path: '/tmp/important' });
    expect(/^[0-9a-f]{32}$/.test(h)).toBe(true);
  });

  // CH-7: VetoOverrideStore roundtrip — store override using computed hash, retrieve by hash
  it('CH-7: override stored with computed hash is retrievable by getOverrideByContentHash', () => {
    const db = new Database(':memory:');
    const store = new VetoOverrideStore(db);

    const toolName = 'execute_command';
    const args = { cmd: 'ls /tmp', safe: true };
    const hash = computeContentHash(toolName, args);

    store.recordOverride({
      decisionId:  `dec-${hash}`,
      contentHash: hash,
      action:      'allow',
      reason:      'pre-approved safe command verified by operator',
      createdBy:   'admin',
    });

    // Same hash computed again (deterministic) must retrieve the override
    const sameHash = computeContentHash(toolName, args);
    expect(sameHash).toBe(hash);

    const result = store.getOverrideByContentHash(sameHash);
    expect(result).not.toBeNull();
    expect(result?.action).toBe('allow');
    expect(result?.contentHash).toBe(hash);
  });

  // CH-8: sanitizeArgsForPrompt caps long string values at 200 chars — hash is still deterministic
  it('CH-8: args with long strings are sanitized deterministically before hashing', () => {
    const longVal = 'x'.repeat(500);
    const h1 = computeContentHash('read_file', { path: longVal });
    const h2 = computeContentHash('read_file', { path: longVal });
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(32);

    // Truncated vs full — should differ because sanitizeArgsForPrompt truncates at 200+ellipsis
    const shortVal = 'x'.repeat(200);
    const hShort = computeContentHash('read_file', { path: shortVal });
    expect(hShort).not.toBe(h1); // different because one is truncated
  });
});

// ---------------------------------------------------------------------------
// Wave 6F: session-history preservation after REPLAN mutation (SH-1)
// ---------------------------------------------------------------------------

describe('Wave6F: session.messages toolCalls preserved after REPLAN mutation', () => {
  /**
   * SH-1: Verifies that the shallow-copy pattern used in loop.ts
   *   assistantMsg.toolCalls = [...validToolCalls]
   * ensures that a subsequent mutation of validToolCalls
   *   (validToolCalls as unknown[]).length = 0
   * does NOT wipe the toolCalls already stored in session.messages.
   */
  it('SH-1: shallow copy decouples stored toolCalls from later array mutation', () => {
    // Simulate what loop.ts does when building assistantMsg
    const validToolCalls = [
      { id: 'tc-1', name: 'read_file',  args: { path: '/foo' }, type: 'tool-call' as const },
      { id: 'tc-2', name: 'write_file', args: { path: '/bar' }, type: 'tool-call' as const },
    ];

    // Shallow copy — mirrors: assistantMsg.toolCalls = [...validToolCalls]
    const storedToolCalls = [...validToolCalls];

    // Simulate REPLAN mutation — mirrors: (validToolCalls as unknown[]).length = 0
    (validToolCalls as unknown[]).length = 0;

    // The mutation should NOT affect the stored copy
    expect(storedToolCalls).toHaveLength(2);
    expect(storedToolCalls[0].id).toBe('tc-1');
    expect(storedToolCalls[1].id).toBe('tc-2');

    // The source array is cleared
    expect(validToolCalls).toHaveLength(0);
  });
});
