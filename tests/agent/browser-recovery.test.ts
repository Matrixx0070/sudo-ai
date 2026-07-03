/**
 * @file browser-recovery.test.ts
 * @description Unit tests for the live-loop browser recovery controller. Uses
 * injected deps (snapshot + notify) so no real browser is needed.
 */
import { describe, it, expect } from 'vitest';
import {
  computeBrowserRecovery,
  isBrowserActionTool,
  isBrowserRecoveryEnabled,
  resetBrowserRecovery,
} from '../../src/core/agent/browser-recovery.js';

function deps() {
  const notified: Array<{ title: string; message: string }> = [];
  return {
    notified,
    snapshot: async () => '[1] button "Submit"\n[2] textbox "Email"',
    notify: (title: string, message: string) => { notified.push({ title, message }); },
  };
}

describe('browser-recovery controller', () => {
  it('classifies action vs read tools', () => {
    expect(isBrowserActionTool('browser.click')).toBe(true);
    expect(isBrowserActionTool('browser.type')).toBe(true);
    expect(isBrowserActionTool('browser.navigate')).toBe(true);
    expect(isBrowserActionTool('browser.snapshot')).toBe(false);
    expect(isBrowserActionTool('browser.network')).toBe(false);
    expect(isBrowserActionTool('fs.read')).toBe(false);
  });

  it('returns nothing for non-browser-action tools', async () => {
    const d = deps();
    const out = await computeBrowserRecovery({ toolName: 'fs.read', args: {}, sessionId: 's-none' }, d);
    expect(out.escalated).toBe(false);
    expect(out.hint).toBeUndefined();
  });

  it('augments the first failures with a fresh snapshot to retry with', async () => {
    const d = deps();
    const sid = 's-augment';
    const first = await computeBrowserRecovery({ toolName: 'browser.click', args: {}, sessionId: sid }, d);
    expect(first.escalated).toBe(false);
    expect(first.hint).toContain('FRESH page snapshot');
    expect(first.hint).toContain('[1] button "Submit"');
    expect(d.notified).toHaveLength(0);

    const second = await computeBrowserRecovery({ toolName: 'browser.click', args: {}, sessionId: sid }, d);
    expect(second.escalated).toBe(false);
    expect(second.hint).toContain('FRESH page snapshot');
  });

  it('escalates on the 3rd consecutive failure: notifies operator + stop directive', async () => {
    const d = deps();
    const sid = 's-escalate';
    await computeBrowserRecovery({ toolName: 'browser.click', args: {}, sessionId: sid }, d); // 1
    await computeBrowserRecovery({ toolName: 'browser.click', args: {}, sessionId: sid }, d); // 2
    const third = await computeBrowserRecovery({ toolName: 'browser.type', args: {}, sessionId: sid }, d); // 3
    expect(third.escalated).toBe(true);
    expect(third.hint).toContain('operator notified');
    expect(third.hint).toMatch(/Stop repeating/i);
    expect(d.notified).toHaveLength(1);
    expect(d.notified[0]!.title).toMatch(/stuck/i);

    // Counter reset after escalation → next failure is treated as #1 (augment again).
    const next = await computeBrowserRecovery({ toolName: 'browser.click', args: {}, sessionId: sid }, d);
    expect(next.escalated).toBe(false);
    expect(next.hint).toContain('FRESH page snapshot');
  });

  it('a successful action (resetBrowserRecovery) clears the streak', async () => {
    const d = deps();
    const sid = 's-reset';
    await computeBrowserRecovery({ toolName: 'browser.click', args: {}, sessionId: sid }, d); // 1
    await computeBrowserRecovery({ toolName: 'browser.click', args: {}, sessionId: sid }, d); // 2
    resetBrowserRecovery(sid); // success
    // Would-be 3rd is now the 1st again → augment, not escalate.
    const out = await computeBrowserRecovery({ toolName: 'browser.click', args: {}, sessionId: sid }, d);
    expect(out.escalated).toBe(false);
    expect(d.notified).toHaveLength(0);
  });

  it('kill-switch: SUDO_BROWSER_RECOVERY=0 disables', () => {
    expect(isBrowserRecoveryEnabled({ SUDO_BROWSER_RECOVERY: '0' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isBrowserRecoveryEnabled({} as NodeJS.ProcessEnv)).toBe(true);
  });
});
