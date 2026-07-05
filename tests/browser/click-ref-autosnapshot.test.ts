/**
 * browser.click ref-not-found auto-re-snapshot: on a stale ref, re-capture and return
 * fresh refs inline (safe half of the recovery — NO blind re-click, since refs are
 * renumbered on capture). Guarded by SUDO_BROWSER_REF_AUTOSNAPSHOT; fail-open.
 *
 * Uses a zero-frame fake Page so captureStableRefs runs with no real browser.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { refNotFoundOutput } from '../../src/core/tools/builtin/browser/click.js';

// captureStableRefs iterates page.frames(); an empty list yields an empty snapshot.
const emptyPage = { frames: () => [] } as unknown as Parameters<typeof refNotFoundOutput>[0];
const throwingPage = { frames: () => { throw new Error('detached'); } } as unknown as Parameters<typeof refNotFoundOutput>[0];

afterEach(() => { delete process.env['SUDO_BROWSER_REF_AUTOSNAPSHOT']; });

describe('refNotFoundOutput', () => {
  it('default (flag unset): auto re-snapshots and returns fresh refs inline', async () => {
    const out = await refNotFoundOutput(emptyPage, 3);
    expect(out).toContain('ref=3 not found');
    expect(out).toContain('Fresh snapshot taken');
    expect(out).toContain('(no actionable elements found)'); // the empty capture rendered
  });

  it('kill-switch (=0): keeps the old static "snapshot again" hint, no capture', async () => {
    process.env['SUDO_BROWSER_REF_AUTOSNAPSHOT'] = '0';
    const out = await refNotFoundOutput(emptyPage, 7);
    expect(out).toContain('ref=7 not found');
    expect(out).toContain('call browser.snapshot again');
    expect(out).not.toContain('Fresh snapshot taken');
  });

  it('fail-open: a capture error falls back to the static hint (never throws)', async () => {
    const out = await refNotFoundOutput(throwingPage, 1);
    expect(out).toContain('call browser.snapshot again');
  });

  it('never auto-clicks — the result is only a message (no click side effect asserted by shape)', async () => {
    const out = await refNotFoundOutput(emptyPage, 2);
    // The output is purely informational: it tells the agent to RETRY, it does not click.
    expect(out).toMatch(/retry browser\.click/i);
  });
});
