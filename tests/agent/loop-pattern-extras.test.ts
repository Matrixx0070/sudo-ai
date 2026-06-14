/**
 * Doom-loop detection extras (gap #23) — exercises
 * `WriteCycleDetector` and `PollingStagnationDetector` directly.
 * Pure detectors, no I/O, no fake timers — assertions on the
 * `{action, reason}` return contract.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  WriteCycleDetector,
  PollingStagnationDetector,
  WRITE_TOOL_NAMES,
  READ_TOOL_NAMES,
} from '../../src/core/agent/loop-pattern-extras.js';

// Capture and restore process.env between tests so threshold overrides
// don't leak.
let originalEnv: Record<string, string | undefined>;
beforeEach(() => {
  originalEnv = {
    SUDO_WRITE_CYCLE_WARN: process.env['SUDO_WRITE_CYCLE_WARN'],
    SUDO_WRITE_CYCLE_ABORT: process.env['SUDO_WRITE_CYCLE_ABORT'],
    SUDO_POLL_STAGNATION_WARN: process.env['SUDO_POLL_STAGNATION_WARN'],
    SUDO_POLL_STAGNATION_ABORT: process.env['SUDO_POLL_STAGNATION_ABORT'],
  };
});
afterEach(() => {
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

describe('shared constants', () => {
  it('WRITE_TOOL_NAMES covers the canonical write tools', () => {
    expect(WRITE_TOOL_NAMES.has('coder.write-file')).toBe(true);
    expect(WRITE_TOOL_NAMES.has('coder.apply-patch')).toBe(true);
    expect(WRITE_TOOL_NAMES.has('memory.save')).toBe(true);
  });

  it('READ_TOOL_NAMES covers the canonical read tools', () => {
    expect(READ_TOOL_NAMES.has('coder.read-file')).toBe(true);
    expect(READ_TOOL_NAMES.has('fs.read')).toBe(true);
    expect(READ_TOOL_NAMES.has('web.fetch')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WriteCycleDetector
// ---------------------------------------------------------------------------

describe('WriteCycleDetector', () => {
  it('returns allow for non-write tools', () => {
    const d = new WriteCycleDetector();
    expect(d.recordCall('coder.read-file', { path: '/x.md' })).toEqual({ action: 'allow' });
    expect(d.recordCall('system.exec', { command: 'ls' })).toEqual({ action: 'allow' });
  });

  it('returns allow for write tools without a target path', () => {
    const d = new WriteCycleDetector();
    expect(d.recordCall('coder.write-file', { content: 'x' })).toEqual({ action: 'allow' });
  });

  it('does NOT count idempotent rewrites (same content)', () => {
    const d = new WriteCycleDetector();
    for (let i = 0; i < 20; i++) {
      const r = d.recordCall('coder.write-file', { path: '/a.md', content: 'same' });
      expect(r.action).toBe('allow');
    }
    expect(d.getCount('/a.md')).toBe(1);
  });

  it('warns when rewrites with different content cross the warn threshold (default 4)', () => {
    const d = new WriteCycleDetector();
    let warned = false;
    for (let i = 0; i < 5; i++) {
      const r = d.recordCall('coder.write-file', { path: '/a.md', content: `v${i}` });
      if (r.action === 'warn') warned = true;
    }
    expect(warned).toBe(true);
  });

  it('aborts when rewrites cross the abort threshold (default 8)', () => {
    const d = new WriteCycleDetector();
    let aborted = false;
    for (let i = 0; i < 10; i++) {
      const r = d.recordCall('coder.write-file', { path: '/a.md', content: `v${i}` });
      if (r.action === 'abort') aborted = true;
    }
    expect(aborted).toBe(true);
  });

  it('warns at most once per path (no spam)', () => {
    const d = new WriteCycleDetector();
    let warnCount = 0;
    for (let i = 0; i < 7; i++) {
      const r = d.recordCall('coder.write-file', { path: '/a.md', content: `v${i}` });
      if (r.action === 'warn') warnCount++;
    }
    expect(warnCount).toBe(1);
  });

  it('honours env-overridden thresholds', () => {
    process.env['SUDO_WRITE_CYCLE_WARN'] = '2';
    process.env['SUDO_WRITE_CYCLE_ABORT'] = '3';
    const d = new WriteCycleDetector();
    const r1 = d.recordCall('coder.write-file', { path: '/x', content: 'a' });
    const r2 = d.recordCall('coder.write-file', { path: '/x', content: 'b' });
    const r3 = d.recordCall('coder.write-file', { path: '/x', content: 'c' });
    expect(r1.action).toBe('allow');
    expect(r2.action).toBe('warn');
    expect(r3.action).toBe('abort');
  });

  it('falls back to defaults on malformed / non-positive env values (verifier MED #3)', () => {
    process.env['SUDO_WRITE_CYCLE_WARN'] = 'not-a-number';
    process.env['SUDO_WRITE_CYCLE_ABORT'] = '-5';
    const d = new WriteCycleDetector();
    // Defaults: warn 4 / abort 8 — first 3 calls should NOT warn.
    let warnedBeforeFour = false;
    for (let i = 0; i < 3; i++) {
      const r = d.recordCall('coder.write-file', { path: '/x', content: `v${i}` });
      if (r.action === 'warn') warnedBeforeFour = true;
    }
    expect(warnedBeforeFour).toBe(false);
    // The 4th distinct-content write hits the default warn threshold.
    const r4 = d.recordCall('coder.write-file', { path: '/x', content: 'v3' });
    expect(r4.action).toBe('warn');
  });

  it('uses `file` or `filepath` arg keys when `path` is absent', () => {
    const d = new WriteCycleDetector();
    d.recordCall('coder.write-file', { file: '/y.md', content: 'a' });
    d.recordCall('coder.write-file', { file: '/y.md', content: 'b' });
    expect(d.getCount('/y.md')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// PollingStagnationDetector
// ---------------------------------------------------------------------------

describe('PollingStagnationDetector', () => {
  it('returns allow for non-read non-write tools', () => {
    const d = new PollingStagnationDetector();
    expect(d.recordCall('meta.classify-bash', { command: 'ls' })).toEqual({ action: 'allow' });
  });

  it('returns allow when read has no target', () => {
    const d = new PollingStagnationDetector();
    expect(d.recordCall('fs.read', { offset: 0 })).toEqual({ action: 'allow' });
  });

  it('warns after N consecutive reads of the same path (default 5)', () => {
    const d = new PollingStagnationDetector();
    let warned = false;
    for (let i = 0; i < 6; i++) {
      const r = d.recordCall('coder.read-file', { path: '/status.json' });
      if (r.action === 'warn') warned = true;
    }
    expect(warned).toBe(true);
  });

  it('aborts after N consecutive reads (default 10)', () => {
    const d = new PollingStagnationDetector();
    let aborted = false;
    for (let i = 0; i < 12; i++) {
      const r = d.recordCall('coder.read-file', { path: '/status.json' });
      if (r.action === 'abort') aborted = true;
    }
    expect(aborted).toBe(true);
  });

  it('a write to path P resets ONLY P\'s counter; other paths keep their counts (verifier HIGH #1)', () => {
    const d = new PollingStagnationDetector();
    for (let i = 0; i < 4; i++) {
      d.recordCall('coder.read-file', { path: '/a' });
      d.recordCall('coder.read-file', { path: '/b' });
    }
    expect(d.getCount('/a')).toBe(4);
    expect(d.getCount('/b')).toBe(4);
    // Write to /a clears /a's counter but leaves /b untouched.
    d.recordCall('coder.write-file', { path: '/a', content: 'progress' });
    expect(d.getCount('/a')).toBe(0);
    expect(d.getCount('/b')).toBe(4);
    // A subsequent read of /b still counts toward stagnation.
    d.recordCall('coder.read-file', { path: '/b' });
    expect(d.getCount('/b')).toBe(5);
  });

  it('a write with no target leaves counters intact', () => {
    const d = new PollingStagnationDetector();
    d.recordCall('coder.read-file', { path: '/a' });
    d.recordCall('coder.read-file', { path: '/a' });
    d.recordCall('coder.write-file', { content: 'no target' });
    expect(d.getCount('/a')).toBe(2);
  });

  it('reads of DIFFERENT paths are tracked independently', () => {
    const d = new PollingStagnationDetector();
    d.recordCall('coder.read-file', { path: '/a' });
    d.recordCall('coder.read-file', { path: '/b' });
    d.recordCall('coder.read-file', { path: '/a' });
    expect(d.getCount('/a')).toBe(2);
    expect(d.getCount('/b')).toBe(1);
  });

  it('warns at most once per path (no spam)', () => {
    const d = new PollingStagnationDetector();
    let warnCount = 0;
    for (let i = 0; i < 9; i++) {
      const r = d.recordCall('coder.read-file', { path: '/x' });
      if (r.action === 'warn') warnCount++;
    }
    expect(warnCount).toBe(1);
  });

  it('honours env-overridden thresholds', () => {
    process.env['SUDO_POLL_STAGNATION_WARN'] = '2';
    process.env['SUDO_POLL_STAGNATION_ABORT'] = '3';
    const d = new PollingStagnationDetector();
    const r1 = d.recordCall('coder.read-file', { path: '/x' });
    const r2 = d.recordCall('coder.read-file', { path: '/x' });
    const r3 = d.recordCall('coder.read-file', { path: '/x' });
    expect(r1.action).toBe('allow');
    expect(r2.action).toBe('warn');
    expect(r3.action).toBe('abort');
  });

  it('uses `url` arg for web.fetch polling', () => {
    const d = new PollingStagnationDetector();
    d.recordCall('web.fetch', { url: 'https://api/status' });
    d.recordCall('web.fetch', { url: 'https://api/status' });
    expect(d.getCount('https://api/status')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Cross-detector interactions
// ---------------------------------------------------------------------------

describe('detectors are independent', () => {
  it('a write recorded by WriteCycleDetector does NOT affect PollingStagnationDetector counts', () => {
    const w = new WriteCycleDetector();
    const p = new PollingStagnationDetector();
    p.recordCall('coder.read-file', { path: '/a' });
    w.recordCall('coder.write-file', { path: '/a', content: 'x' });
    expect(p.getCount('/a')).toBe(1); // the WRITE didn't go through `p`
  });
});
