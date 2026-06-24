/**
 * @file stuck-detector.test.ts
 * @description Tests for StuckDetector — result-aware repeated-error detection.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { StuckDetector, looksLikeToolError } from '../../src/core/agent/stuck-detector.js';

const ERR = 'Error executing tool shell.exec: Error: ENOENT no such file';

describe('StuckDetector', () => {
  let detector: StuckDetector;

  beforeEach(() => {
    detector = new StuckDetector({ enabled: true, warnThreshold: 3, abortThreshold: 5 });
  });

  it('is disabled by default (env flag absent)', () => {
    const d = new StuckDetector();
    expect(d.enabled).toBe(false);
    for (let i = 0; i < 10; i++) {
      expect(d.recordResult('shell.exec', ERR, true).action).toBe('allow');
    }
  });

  it('allows successful results', () => {
    expect(detector.recordResult('shell.exec', 'ok', false).action).toBe('allow');
    expect(detector.getStreak().count).toBe(0);
  });

  it('allows isolated errors below the warn threshold', () => {
    expect(detector.recordResult('shell.exec', ERR, true).action).toBe('allow');
    expect(detector.recordResult('shell.exec', ERR, true).action).toBe('allow');
    expect(detector.getStreak()).toEqual({ toolName: 'shell.exec', count: 2 });
  });

  it('warns at the warn threshold and only once per signature', () => {
    detector.recordResult('shell.exec', ERR, true);
    detector.recordResult('shell.exec', ERR, true);
    const warn = detector.recordResult('shell.exec', ERR, true);
    expect(warn.action).toBe('warn');
    expect(warn.reason).toContain('shell.exec');
    // 4th identical error: still below abort, but no duplicate warn
    expect(detector.recordResult('shell.exec', ERR, true).action).toBe('allow');
  });

  it('aborts at the abort threshold', () => {
    for (let i = 0; i < 4; i++) detector.recordResult('shell.exec', ERR, true);
    const result = detector.recordResult('shell.exec', ERR, true);
    expect(result.action).toBe('abort');
    expect(result.reason).toContain('5 consecutive');
  });

  it('resets the streak on success', () => {
    detector.recordResult('shell.exec', ERR, true);
    detector.recordResult('shell.exec', ERR, true);
    detector.recordResult('shell.exec', 'ok now', false);
    expect(detector.getStreak().count).toBe(0);
    expect(detector.recordResult('shell.exec', ERR, true).action).toBe('allow');
  });

  it('resets the streak when a different error appears', () => {
    detector.recordResult('shell.exec', ERR, true);
    detector.recordResult('shell.exec', ERR, true);
    detector.recordResult('shell.exec', 'Error: completely different failure', true);
    expect(detector.getStreak().count).toBe(1);
  });

  it('resets the streak when a different tool errors', () => {
    detector.recordResult('shell.exec', ERR, true);
    detector.recordResult('shell.exec', ERR, true);
    detector.recordResult('fs.read_file', ERR, true);
    expect(detector.getStreak()).toEqual({ toolName: 'fs.read_file', count: 1 });
  });

  it('treats whitespace-only differences as the same error', () => {
    detector.recordResult('shell.exec', `  ${ERR}\n\n`, true);
    detector.recordResult('shell.exec', ERR.replace(' ', '   '), true);
    const result = detector.recordResult('shell.exec', ERR, true);
    expect(result.action).toBe('warn');
  });

  it('treats errors differing within the first 300 chars as distinct', () => {
    detector.recordResult('shell.exec', 'Error: A', true);
    detector.recordResult('shell.exec', 'Error: B', true);
    expect(detector.getStreak().count).toBe(1);
  });

  it('exempts wait/poll-style tools (REPEAT_EXEMPT_TOOLS)', () => {
    for (let i = 0; i < 10; i++) {
      expect(detector.recordResult('browser.screenshot', ERR, true).action).toBe('allow');
    }
    expect(detector.getStreak().count).toBe(0);
  });

  it('reset() clears streak and warn dedup', () => {
    detector.recordResult('shell.exec', ERR, true);
    detector.recordResult('shell.exec', ERR, true);
    detector.recordResult('shell.exec', ERR, true); // warn
    detector.reset();
    expect(detector.getStreak()).toEqual({ toolName: null, count: 0 });
    detector.recordResult('shell.exec', ERR, true);
    detector.recordResult('shell.exec', ERR, true);
    // warn fires again after reset (new run)
    expect(detector.recordResult('shell.exec', ERR, true).action).toBe('warn');
  });

  it('returns to a clean state after an abort (no instant re-abort)', () => {
    for (let i = 0; i < 4; i++) detector.recordResult('shell.exec', ERR, true);
    expect(detector.recordResult('shell.exec', ERR, true).action).toBe('abort');
    expect(detector.getStreak()).toEqual({ toolName: null, count: 0 });
    // Recording after abort re-accumulates from 1
    expect(detector.recordResult('shell.exec', ERR, true).action).toBe('allow');
    expect(detector.getStreak().count).toBe(1);
  });

  it('falls back to default thresholds for non-positive env values', () => {
    const prevWarn = process.env['SUDO_STUCK_DETECTOR_WARN_THRESHOLD'];
    const prevAbort = process.env['SUDO_STUCK_DETECTOR_ABORT_THRESHOLD'];
    process.env['SUDO_STUCK_DETECTOR_WARN_THRESHOLD'] = '0';
    process.env['SUDO_STUCK_DETECTOR_ABORT_THRESHOLD'] = '-2';
    try {
      const d = new StuckDetector({ enabled: true });
      d.recordResult('shell.exec', ERR, true);
      d.recordResult('shell.exec', ERR, true);
      expect(d.recordResult('shell.exec', ERR, true).action).toBe('warn'); // default 3
      d.recordResult('shell.exec', ERR, true);
      expect(d.recordResult('shell.exec', ERR, true).action).toBe('abort'); // default 5
    } finally {
      if (prevWarn === undefined) delete process.env['SUDO_STUCK_DETECTOR_WARN_THRESHOLD'];
      else process.env['SUDO_STUCK_DETECTOR_WARN_THRESHOLD'] = prevWarn;
      if (prevAbort === undefined) delete process.env['SUDO_STUCK_DETECTOR_ABORT_THRESHOLD'];
      else process.env['SUDO_STUCK_DETECTOR_ABORT_THRESHOLD'] = prevAbort;
    }
  });

  it('honors env-flag enablement', () => {
    const prev = process.env['SUDO_STUCK_DETECTOR'];
    process.env['SUDO_STUCK_DETECTOR'] = '1';
    try {
      expect(new StuckDetector().enabled).toBe(true);
    } finally {
      if (prev === undefined) delete process.env['SUDO_STUCK_DETECTOR'];
      else process.env['SUDO_STUCK_DETECTOR'] = prev;
    }
  });
});

describe('looksLikeToolError — command/exec failure markers', () => {
  it('flags common command/exec failures that do NOT start with "error"', () => {
    expect(looksLikeToolError('Command exited with code 127:\n/bin/bash: line 1: foo: command not found')).toBe(true);
    expect(looksLikeToolError('Command exited with code 1: boom')).toBe(true);
    expect(looksLikeToolError('cat: /x: No such file or directory')).toBe(true);
    expect(looksLikeToolError('bash: /etc/shadow: Permission denied')).toBe(true);
    expect(looksLikeToolError('The tool call failed.')).toBe(true);
    expect(looksLikeToolError('Traceback (most recent call last):\n  ...')).toBe(true);
  });

  it('does NOT flag successes or exit code 0', () => {
    expect(looksLikeToolError('All checks passed. 0 errors.')).toBe(false);
    expect(looksLikeToolError('Command exited with code 0: done')).toBe(false);
    expect(looksLikeToolError('Saved file to /tmp/out.txt')).toBe(false);
    expect(looksLikeToolError('{"ok":true,"rows":3}')).toBe(false);
  });

  it('makes StuckDetector build a streak on a repeated exec failure (the live-test case)', () => {
    // This is the exact result shape the live test produced — it does NOT start
    // with "error", so isToolResultSuccess alone called it a success and the
    // streak never built. With the marker check the streak now accumulates.
    const detector = new StuckDetector({ enabled: true, warnThreshold: 2, abortThreshold: 8 });
    const exec = 'Command exited with code 127:\n/bin/bash: line 1: thiscommanddoesnotexist123: command not found';
    const isErr = looksLikeToolError(exec); // what the loop now passes
    expect(isErr).toBe(true);
    expect(detector.recordResult('system.exec', exec, isErr).action).toBe('allow'); // streak 1
    expect(detector.recordResult('system.exec', exec, isErr).action).toBe('warn');  // streak 2 → warn
  });
});
