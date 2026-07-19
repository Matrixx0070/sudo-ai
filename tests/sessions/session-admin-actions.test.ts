/**
 * @file tests/sessions/session-admin-actions.test.ts
 * @description BO9 / S8 — unit tests for the pure fork/archive action logic.
 * These encode the two beat-OpenClaw guarantees:
 *  - FORK copies history into a NEW session and NEVER mutates the source
 *    (additive; source array + fields untouched).
 *  - ARCHIVE requires an explicit confirm — an unconfirmed call is REJECTED
 *    with `confirm_required` before any state change; archive is a reversible
 *    state mark, never a hard delete.
 */

import { describe, it, expect } from 'vitest';
import {
  planArchive,
  isConfirmed,
  buildForkedSession,
  type ForkableSession,
} from '../../src/core/sessions/session-admin-actions.js';

function session(over: Partial<ForkableSession> = {}): ForkableSession {
  return {
    id: 'src-1',
    channel: 'web',
    peerId: 'peer-9',
    state: 'active',
    model: 'grok-4.5',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      { role: 'tool', content: '{"ok":true}', toolName: 'search' },
    ],
    createdAt: new Date('2026-07-19T10:00:00.000Z'),
    updatedAt: new Date('2026-07-19T11:00:00.000Z'),
    ...over,
  };
}

describe('planArchive — confirm gate (beat OpenClaw)', () => {
  const current = { state: 'active' as const };

  it('REJECTS an unconfirmed archive with confirm_required', () => {
    const plan = planArchive({ id: 'src-1', confirm: undefined }, current);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.code).toBe('confirm_required');
  });

  it('REJECTS confirm=false', () => {
    const plan = planArchive({ id: 'src-1', confirm: false }, current);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.code).toBe('confirm_required');
  });

  it('REJECTS an empty-string / wrong-id token', () => {
    expect(planArchive({ id: 'src-1', confirm: '' }, current).ok).toBe(false);
    expect(planArchive({ id: 'src-1', confirm: 'other-id' }, current).ok).toBe(false);
  });

  it('ACCEPTS confirm=true', () => {
    const plan = planArchive({ id: 'src-1', confirm: true }, current);
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.nextState).toBe('archived');
  });

  it('ACCEPTS a type-to-confirm token equal to the id, and the string "true"', () => {
    expect(planArchive({ id: 'src-1', confirm: 'src-1' }, current).ok).toBe(true);
    expect(planArchive({ id: 'src-1', confirm: 'true' }, current).ok).toBe(true);
  });

  it('reports not_found when the session is missing', () => {
    const plan = planArchive({ id: 'nope', confirm: true }, null);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.code).toBe('not_found');
  });

  it('is idempotent — already_archived is a distinct non-ok code', () => {
    const plan = planArchive({ id: 'src-1', confirm: true }, { state: 'archived' });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.code).toBe('already_archived');
  });

  it('isConfirmed is strict about accepted forms', () => {
    expect(isConfirmed(true, 'x')).toBe(true);
    expect(isConfirmed('true', 'x')).toBe(true);
    expect(isConfirmed('x', 'x')).toBe(true);
    expect(isConfirmed(false, 'x')).toBe(false);
    expect(isConfirmed(undefined, 'x')).toBe(false);
    expect(isConfirmed('', 'x')).toBe(false);
    expect(isConfirmed('false', 'x')).toBe(false);
  });
});

describe('buildForkedSession — additive copy (beat OpenClaw)', () => {
  it('copies the full message history into a new session', () => {
    const src = session();
    const fork = buildForkedSession(src, { newId: 'fork-1', now: new Date('2026-07-19T12:00:00.000Z') });
    // notice + 3 copied messages
    expect(fork.id).toBe('fork-1');
    expect(fork.state).toBe('active');
    expect(fork.forkedFrom).toBe('src-1');
    const copied = fork.messages.filter((m) => !m.content.startsWith('[SESSION FORK'));
    expect(copied).toHaveLength(3);
    expect(copied.map((m) => m.content)).toEqual(['hello', 'hi there', '{"ok":true}']);
    expect(copied[2]!.toolName).toBe('search');
  });

  it('prepends a fork lineage notice by default', () => {
    const fork = buildForkedSession(session(), { newId: 'fork-2' });
    expect(fork.messages[0]!.role).toBe('system');
    expect(fork.messages[0]!.content).toContain('[SESSION FORK');
    expect(fork.messages[0]!.content).toContain('src-1');
  });

  it('can suppress the notice', () => {
    const fork = buildForkedSession(session(), { newId: 'fork-3', addNotice: false });
    expect(fork.messages).toHaveLength(3);
    expect(fork.messages[0]!.content).toBe('hello');
  });

  it('NEVER mutates the source session (additive guarantee)', () => {
    const src = session();
    const srcSnapshot = JSON.stringify(src.messages);
    const srcLen = src.messages.length;
    const fork = buildForkedSession(src, { newId: 'fork-4' });
    // source untouched
    expect(src.messages).toHaveLength(srcLen);
    expect(JSON.stringify(src.messages)).toBe(srcSnapshot);
    // deep copy — mutating the fork does not touch the source
    fork.messages[fork.messages.length - 1]!.content = 'MUTATED';
    expect(src.messages[src.messages.length - 1]!.content).toBe('{"ok":true}');
  });

  it('derives a collision-free peer id so it never hijacks the live active session', () => {
    const fork = buildForkedSession(session(), { newId: 'fork-5' });
    expect(fork.peerId).toBe('peer-9#fork:fork-5');
    expect(fork.channel).toBe('web');
  });

  it('honors an explicit peerId override', () => {
    const fork = buildForkedSession(session(), { newId: 'fork-6', peerId: 'custom' });
    expect(fork.peerId).toBe('custom');
  });
});
