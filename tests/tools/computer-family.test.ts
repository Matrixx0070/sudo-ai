/**
 * @file computer-family.test.ts
 * @description Phase 0 — the registered `computer.*` tool family.
 *
 * Covers: registration surface, kill-switch, execution-authority gating
 * (autonomous proceeds / gated refuses), read-only screenshot, and text-carry
 * for computer.type. The platform driver is faked via the test seam so no real
 * xdotool/scrot is invoked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolRegistry } from '../../src/core/tools/registry.js';
import {
  registerComputerUseTools,
  computerUseFamily,
  __setComputerUseDriverForTest,
} from '../../src/core/tools/builtin/computer-use/index.js';
import type { IComputerUse } from '../../src/core/tools/builtin/computer-use/cross-platform/index.js';
import type { ToolContext } from '../../src/core/tools/types.js';

function fakeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 't',
    workingDir: '/tmp',
    config: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    isOwner: true,
    ...over,
  } as ToolContext;
}

function makeFakeDriver() {
  const calls: Array<{ method: string; params: unknown }> = [];
  const driver: IComputerUse = {
    async exec() { return { success: true, stdout: '', stderr: '', exitCode: 0, durationMs: 0, platform: 'linux' }; },
    async browser(p) { calls.push({ method: 'browser', params: p }); return { action: String(p.action), success: true }; },
    async file() { return { success: true }; },
    async gui(p) { calls.push({ method: 'gui', params: p }); return { action: String(p.action), success: true, screenshot: p.action === 'screenshot' ? 'BASE64PNG' : undefined }; },
    async desktop(p) { calls.push({ method: 'desktop', params: p }); return { action: String(p.action), success: true, data: { windows: ['w1'] } }; },
  };
  return { driver, calls };
}

describe('computer.* family (Phase 0)', () => {
  const ENV = process.env;
  beforeEach(() => {
    delete process.env['SUDO_COMPUTER_USE_DISABLE'];
    delete process.env['SUDO_AUTHORITY_MODE'];
    delete process.env['SUDO_AUTO_APPROVE'];
  });
  afterEach(() => {
    __setComputerUseDriverForTest(undefined);
    process.env = ENV;
    vi.restoreAllMocks();
  });

  it('registers exactly the six-tool surface under the computer category', () => {
    const reg = new ToolRegistry();
    registerComputerUseTools(reg);
    const names = computerUseFamily.map((t) => t.name).sort();
    expect(names).toEqual([
      'computer.click',
      'computer.key',
      'computer.screenshot',
      'computer.scroll',
      'computer.type',
      'computer.window',
    ]);
    for (const t of computerUseFamily) {
      expect(t.category).toBe('computer');
      expect(reg.get(t.name)).toBeDefined();
    }
    // screenshot is read-only; input tools are destructive.
    expect(reg.get('computer.screenshot')!.safety).toBe('readonly');
    expect(reg.get('computer.click')!.safety).toBe('destructive');
  });

  it('screenshot returns base64 PNG in data (read-only, no gating)', async () => {
    const { driver, calls } = makeFakeDriver();
    __setComputerUseDriverForTest(driver);
    const reg = new ToolRegistry();
    registerComputerUseTools(reg);
    const res = await reg.get('computer.screenshot')!.execute({}, fakeCtx({ isOwner: false }));
    expect(res.success).toBe(true);
    expect((res.data as { screenshot: string }).screenshot).toBe('BASE64PNG');
    expect(calls).toEqual([{ method: 'gui', params: { action: 'screenshot' } }]);
  });

  it('computer.type carries the text payload through to the driver', async () => {
    const { driver, calls } = makeFakeDriver();
    __setComputerUseDriverForTest(driver);
    const reg = new ToolRegistry();
    registerComputerUseTools(reg);
    const res = await reg.get('computer.type')!.execute({ text: 'hello world' }, fakeCtx());
    expect(res.success).toBe(true);
    expect(calls[0]).toEqual({ method: 'gui', params: { action: 'type', text: 'hello world' } });
  });

  it('kill-switch hard-stops every action including read-only screenshot', async () => {
    const { driver, calls } = makeFakeDriver();
    __setComputerUseDriverForTest(driver);
    process.env['SUDO_COMPUTER_USE_DISABLE'] = '1';
    const reg = new ToolRegistry();
    registerComputerUseTools(reg);
    const shot = await reg.get('computer.screenshot')!.execute({}, fakeCtx());
    const click = await reg.get('computer.click')!.execute({ x: 1, y: 2 }, fakeCtx());
    expect(shot.success).toBe(false);
    expect(click.success).toBe(false);
    expect(calls.length).toBe(0); // never reached the driver
  });

  it('gated authority mode refuses mutating actions (requires prompt)', async () => {
    const { driver, calls } = makeFakeDriver();
    __setComputerUseDriverForTest(driver);
    process.env['SUDO_AUTHORITY_MODE'] = 'gated';
    const reg = new ToolRegistry();
    registerComputerUseTools(reg);
    const res = await reg.get('computer.click')!.execute({ x: 5, y: 5 }, fakeCtx());
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/confirmation|refused/i);
    expect(calls.length).toBe(0);
  });

  it('autonomous authority mode lets a mutating action proceed to the driver', async () => {
    const { driver, calls } = makeFakeDriver();
    __setComputerUseDriverForTest(driver);
    process.env['SUDO_AUTHORITY_MODE'] = 'autonomous';
    const reg = new ToolRegistry();
    registerComputerUseTools(reg);
    const res = await reg.get('computer.click')!.execute({ x: 7, y: 9 }, fakeCtx());
    expect(res.success).toBe(true);
    expect(calls[0]).toEqual({ method: 'gui', params: { action: 'click', x: 7, y: 9 } });
  });

  it('computer.window list is read-only; focus requires a target', async () => {
    const { driver, calls } = makeFakeDriver();
    __setComputerUseDriverForTest(driver);
    const reg = new ToolRegistry();
    registerComputerUseTools(reg);
    const list = await reg.get('computer.window')!.execute({ action: 'list' }, fakeCtx());
    expect(list.success).toBe(true);
    expect((list.data as { windows: string[] }).windows).toEqual(['w1']);
    const focusNoTarget = await reg.get('computer.window')!.execute({ action: 'focus' }, fakeCtx());
    expect(focusNoTarget.success).toBe(false);
    expect(focusNoTarget.output).toMatch(/requires a target/);
    expect(calls).toEqual([{ method: 'desktop', params: { action: 'list', target: undefined } }]);
  });
});
