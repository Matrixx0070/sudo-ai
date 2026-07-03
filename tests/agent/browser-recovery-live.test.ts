/**
 * @file browser-recovery-live.test.ts
 * @description LIVE end-to-end proof of the augment/self-heal path on a REAL stale
 * ref. Launches a real headless browser, stamps ref 1, re-renders the page so ref 1
 * is stale, then drives browser.click ref=1 through the REAL executeToolCalls + REAL
 * browser tool registry. Asserts the recovery hint carries FRESH refs captured from
 * the live re-rendered page — i.e. defaultSnapshot ran against a real browser.
 *
 * Skips when Chromium isn't installed (CI), matching the other real-browser suites.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { browserAvailable } from '../browser/_browser-available.js';
import { executeToolCalls } from '../../src/core/agent/loop-helpers.js';
import type { SessionLike } from '../../src/core/agent/loop-helpers.js';
import type { AgentState } from '../../src/core/agent/types.js';
import { resetBrowserRecovery } from '../../src/core/agent/browser-recovery.js';
import { ToolRegistry } from '../../src/core/tools/registry.js';
import { registerBrowserTools } from '../../src/core/tools/builtin/browser/index.js';
import { BrowserManager } from '../../src/core/tools/builtin/browser/browser-manager.js';
import { captureStableRefs } from '../../src/core/tools/builtin/browser/stable-ref.js';

const SID = 'recovery-live-session';

function makeState(): AgentState {
  return {
    sessionId: SID,
    isCompacting: false,
    pendingToolCalls: 0,
    iterationCount: 0,
    maxIterations: 50,
    consecutiveReplans: 0,
  } as AgentState;
}

describe.skipIf(!browserAvailable())('live browser recovery — real stale ref', () => {
  let registry: ToolRegistry;
  const prevAutoApprove = process.env['SUDO_AUTO_APPROVE'];

  beforeAll(async () => {
    process.env['SUDO_AUTO_APPROVE'] = '1'; // no approval prompts in-test

    const mgr = BrowserManager.getInstance();
    const inst = await mgr.launch('default', true);
    const page = await inst.context.newPage();

    // 1) Original page — stamp refs. Ref 1 now points at "Alpha Button".
    await page.setContent('<button id="a">Alpha Button</button>', { waitUntil: 'load' });
    const original = await captureStableRefs(page);
    expect(original.refs.some((r) => r.name === 'Alpha Button')).toBe(true);

    // 2) Re-render the page — the DOM (and its data-sudo-ref attrs) is replaced,
    //    so ref 1 is now STALE. New actionable elements appear.
    await page.setContent(
      '<button id="b">Beta Button</button><input aria-label="Search box" />',
      { waitUntil: 'load' },
    );

    registry = new ToolRegistry();
    registerBrowserTools(registry);
  }, 40_000);

  afterAll(async () => {
    await BrowserManager.getInstance().close('default').catch(() => {});
    if (prevAutoApprove === undefined) delete process.env['SUDO_AUTO_APPROVE'];
    else process.env['SUDO_AUTO_APPROVE'] = prevAutoApprove;
  });

  it('clicking a stale ref fails, and recovery injects FRESH refs from the live page', async () => {
    resetBrowserRecovery(SID);
    const session: SessionLike = { id: SID, messages: [] };

    await executeToolCalls(
      [{ id: 'tc-live-1', name: 'browser.click', arguments: { ref: 1 } }],
      session,
      makeState(),
      () => undefined,
      registry,
    );

    expect(session.messages).toHaveLength(1);
    const msg = String(session.messages[0]!.content);

    // The stale-ref click failed...
    expect(msg).toContain('ref=1 not found');
    // ...and live-loop recovery augmented the message with a fresh snapshot...
    expect(msg).toContain('[BROWSER RECOVERY]');
    expect(msg).toContain('FRESH page snapshot');
    // ...captured from the REAL re-rendered page (new elements, not the stale one).
    expect(msg).toContain('Beta Button');
    expect(msg).toContain('Search box');
    expect(msg).not.toContain('Alpha Button');
  }, 30_000);
});
