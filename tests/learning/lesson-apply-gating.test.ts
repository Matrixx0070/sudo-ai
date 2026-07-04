/**
 * lesson-apply gating — proves the apply path is OFF by default (no hints) and only
 * injects canary/promoted hints when SUDO_FLYWHEEL_APPLY=1. DATA_DIR is captured at
 * module-import time, so it is set BEFORE the dynamic import.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let tmp: string;
let mod: typeof import('../../src/core/learning/lesson-apply.js');

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'lesson-gate-'));
  process.env['DATA_DIR'] = tmp;
  ({ ...mod } = await import('../../src/core/learning/lesson-apply.js'));
  // A store with one canary (inject) + one reverted (never inject).
  const store = {
    version: 1,
    lessons: [
      { lessonId: 'A', tool: 'system.exec', hint: 'HINT-A', state: 'canary', recoveryPct: 90, admittedAt: 'T0', canaryStartedAt: 'T1', canaryWindowMs: 1000, baselineFailRate: 0.4 },
      { lessonId: 'B', tool: 'system.exec', hint: 'HINT-B', state: 'reverted', recoveryPct: 90, admittedAt: 'T0', canaryWindowMs: 1000 },
    ],
  };
  writeFileSync(path.join(tmp, 'flywheel-lessons.json'), JSON.stringify(store));
});

afterAll(() => {
  delete process.env['SUDO_FLYWHEEL_APPLY'];
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
});

describe('getAppliedLessonHints gating', () => {
  it('returns [] when apply is disabled (default) — no live change', () => {
    delete process.env['SUDO_FLYWHEEL_APPLY'];
    mod.invalidateHintCache();
    expect(mod.isApplyEnabled()).toBe(false);
    expect(mod.getAppliedLessonHints(1)).toEqual([]);
  });

  it('injects only canary/promoted hints when SUDO_FLYWHEEL_APPLY=1', () => {
    process.env['SUDO_FLYWHEEL_APPLY'] = '1';
    mod.invalidateHintCache();
    const hints = mod.getAppliedLessonHints(2);
    expect(hints).toContain('HINT-A');   // canary → injected
    expect(hints).not.toContain('HINT-B'); // reverted → never injected
  });

  it('runLessonLifecycle is a no-op when apply is disabled', () => {
    delete process.env['SUDO_FLYWHEEL_APPLY'];
    const actions = mod.runLessonLifecycle({ measureFailRate: () => 0.1, nowMs: 1000, nowISO: 'T' });
    expect(actions).toEqual([]);
  });
});
