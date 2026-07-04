/** lesson-store — pure lifecycle ops + crash-safe persistence. */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  emptyStore, loadLessonStore, saveLessonStore, upsertCandidate,
  startCanary, resolveCanary, activeLessonHints,
} from '../../src/core/learning/lesson-store.js';

const dirs: string[] = [];
const mkdir = () => { const d = mkdtempSync(path.join(tmpdir(), 'lesson-store-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) { try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* */ } } });

const base = { lessonId: 'L1', tool: 'system.exec', hint: 'do not use pipes', recoveryPct: 90, canaryWindowMs: 1000 };

describe('pure lifecycle ops', () => {
  it('upsertCandidate adds once, is idempotent', () => {
    const a = upsertCandidate(emptyStore(), base, 'T0');
    expect(a.added).toBe(true);
    expect(a.store.lessons[0]!.state).toBe('candidate');
    const b = upsertCandidate(a.store, base, 'T1');
    expect(b.added).toBe(false);
    expect(b.store.lessons).toHaveLength(1);
  });
  it('candidate → canary records baseline; only canary/promoted are active hints', () => {
    const s0 = upsertCandidate(emptyStore(), base, 'T0').store;
    expect(activeLessonHints(s0)).toEqual([]); // candidate not injected
    const s1 = startCanary(s0, 'L1', 0.4, 'T1');
    expect(s1.lessons[0]!.state).toBe('canary');
    expect(s1.lessons[0]!.baselineFailRate).toBe(0.4);
    expect(activeLessonHints(s1)).toEqual(['do not use pipes']); // canary IS injected
    const promoted = resolveCanary(s1, 'L1', 0.1, true, 'T2', 'improved');
    expect(promoted.lessons[0]!.state).toBe('promoted');
    expect(activeLessonHints(promoted)).toEqual(['do not use pipes']);
    const reverted = resolveCanary(s1, 'L1', 0.5, false, 'T2', 'regressed');
    expect(reverted.lessons[0]!.state).toBe('reverted');
    expect(activeLessonHints(reverted)).toEqual([]); // reverted NOT injected
  });
});

describe('persistence', () => {
  it('round-trips atomically; a corrupt file loads as empty (fail-open)', () => {
    const p = path.join(mkdir(), 'lessons.json');
    expect(loadLessonStore(p)).toEqual(emptyStore()); // missing → empty
    const s = startCanary(upsertCandidate(emptyStore(), base, 'T0').store, 'L1', 0.3, 'T1');
    saveLessonStore(p, s);
    expect(loadLessonStore(p).lessons[0]!.state).toBe('canary');
    writeFileSync(p, '{ not json');
    expect(loadLessonStore(p)).toEqual(emptyStore()); // corrupt → empty
  });
});
