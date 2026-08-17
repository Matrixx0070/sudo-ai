/**
 * @file computer-drivers.test.ts
 * @description Phase 4 — the IComputerDriver boundary. Platform detection, the
 * driver contract (via a MockDriver), proof that the UNCHANGED core executor
 * runs end-to-end through an arbitrary driver, and per-platform capability
 * contracts for the Wayland/Windows/macOS drivers.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { detectPlatform, createDriver, type IComputerDriver, type LowLevelAction } from '../../src/core/tools/builtin/computer-use/core/driver.js';
import { driverSink, driverStructuredActor } from '../../src/core/tools/builtin/computer-use/core/driver-adapters.js';
import { PerceptionService } from '../../src/core/tools/builtin/computer-use/core/perception.js';
import { GroundingResolver } from '../../src/core/tools/builtin/computer-use/core/grounding.js';
import { ActionExecutor } from '../../src/core/tools/builtin/computer-use/core/executor.js';
import { LinuxX11Driver } from '../../src/core/tools/builtin/computer-use/core/drivers/linux-x11.js';
import { LinuxWaylandDriver } from '../../src/core/tools/builtin/computer-use/core/drivers/linux-wayland.js';
import { WindowsDriver } from '../../src/core/tools/builtin/computer-use/core/drivers/windows.js';
import { MacDriver, osaStr } from '../../src/core/tools/builtin/computer-use/core/drivers/macos.js';
import type { UIElement } from '../../src/core/tools/builtin/computer-use/core/types.js';

/** A fully in-memory driver — the contract reference. */
class MockDriver implements IComputerDriver {
  readonly platform = 'linux-x11' as const;
  frame = 0;
  injected: LowLevelAction[] = [];
  structuredCalls = 0;
  els: UIElement[] = [{ i: 0, role: 'push button', name: 'Go', states: ['showing', 'enabled'], x: 10, y: 10, w: 40, h: 20, app: 'mock' }];
  capabilities() { return { accessibility: true, structuredAction: true, windows: true }; }
  async capture() { this.frame++; return { png: Buffer.from(`frame-${this.frame}`), width: 800, height: 600 }; }
  async axTree() { return this.els; }
  async windows() { return [{ title: 'MockWin', x: 0, y: 0, w: 800, h: 600, active: true }]; }
  async inject(_t: string, a: LowLevelAction) { this.injected.push(a); return { success: true }; }
  async structuredAction() { this.structuredCalls++; return true; }
}

describe('platform detection', () => {
  const origPlat = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const ENV = { ...process.env };
  afterEach(() => {
    Object.defineProperty(process, 'platform', origPlat);
    process.env = { ...ENV };
  });
  const setPlat = (p: string) => Object.defineProperty(process, 'platform', { value: p, configurable: true });

  it('detects windows/macos/wayland/x11', () => {
    setPlat('win32'); expect(detectPlatform()).toBe('windows');
    setPlat('darwin'); expect(detectPlatform()).toBe('macos');
    setPlat('linux'); process.env['XDG_SESSION_TYPE'] = 'wayland'; expect(detectPlatform()).toBe('linux-wayland');
    process.env['XDG_SESSION_TYPE'] = 'x11'; process.env['DISPLAY'] = ':0'; expect(detectPlatform()).toBe('linux-x11');
  });

  it('createDriver returns the requested platform driver', async () => {
    expect((await createDriver('linux-x11')).platform).toBe('linux-x11');
    expect((await createDriver('linux-wayland')).platform).toBe('linux-wayland');
    expect((await createDriver('windows')).platform).toBe('windows');
    expect((await createDriver('macos')).platform).toBe('macos');
  });
});

describe('IComputerDriver contract (MockDriver)', () => {
  it('satisfies the capture/axTree/windows/inject/structuredAction shape', async () => {
    const d = new MockDriver();
    const cap = await d.capture(':t');
    expect(Buffer.isBuffer(cap.png)).toBe(true);
    expect(cap.width).toBe(800);
    expect(Array.isArray(await d.axTree(':t'))).toBe(true);
    expect((await d.windows(':t'))[0].title).toBe('MockWin');
    expect((await d.inject(':t', { kind: 'click', x: 1, y: 1 })).success).toBe(true);
    expect(await d.structuredAction(':t', { name: 'Go' })).toBe(true);
    expect(d.capabilities()).toMatchObject({ accessibility: true, structuredAction: true, windows: true });
  });
});

describe('the unchanged core runs end-to-end through any driver', () => {
  it('drives a verified plan via a MockDriver (perception + sink + structured all through the driver)', async () => {
    const driver = new MockDriver();
    const perception = new PerceptionService({ driver, accessibility: true, intersectWindows: false });
    const exec = new ActionExecutor({
      sessionId: 't', display: ':mock', perception, grounding: new GroundingResolver(),
      sink: driverSink(driver, ':mock'), structuredActor: driverStructuredActor(driver, ':mock'),
      ownerVerified: true, settleMs: 0,
    });
    const res = await exec.run({ subgoal: 'go', actions: [
      { kind: 'click', target: { text: 'Go' }, expect: { changed: true } },
      { kind: 'type', text: 'hello', expect: { changed: true } },
    ]});
    expect(res.success).toBe(true);
    // click went through the structured (AX) path; type went through inject.
    expect(res.steps[0].structured).toBe(true);
    expect(driver.injected.some((a) => a.kind === 'type' && a.text === 'hello')).toBe(true);
  });
});

describe('per-platform capability contracts', () => {
  it('X11 driver: full capabilities; rejects flag-smuggling key without spawning', async () => {
    const d = new LinuxX11Driver();
    expect(d.capabilities()).toMatchObject({ accessibility: true, structuredAction: true, windows: true });
    expect((await d.inject(':999', { kind: 'key', key: '--evil' })).success).toBe(false);
  });

  it('Wayland driver: focus_window is unsupported (no global window control)', async () => {
    const d = new LinuxWaylandDriver();
    expect(d.platform).toBe('linux-wayland');
    const r = await d.inject(':0', { kind: 'focus_window', window: 'x' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Wayland/);
  });

  it('macOS driver: pointer actions await the Phase 5 CGEvent helper; capabilities declared', async () => {
    const d = new MacDriver();
    expect(d.capabilities().accessibility).toBe(true);
    const r = await d.inject(':0', { kind: 'click', x: 1, y: 1 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/CGEvent|helper/);
  });

  it('Windows driver: declares full capabilities and correct platform', () => {
    const d = new WindowsDriver();
    expect(d.platform).toBe('windows');
    expect(d.capabilities()).toMatchObject({ accessibility: true, structuredAction: true, windows: true });
  });

  it('macOS AppleScript escaping neutralises backslash-then-quote injection', () => {
    // Backslash must be doubled BEFORE the quote is escaped, else a trailing
    // backslash would consume the closing quote and inject AppleScript.
    expect(osaStr('a"b')).toBe('a\\"b');
    expect(osaStr('a\\')).toBe('a\\\\');
    expect(osaStr('"; do shell script "evil')).toBe('\\"; do shell script \\"evil');
  });
});
