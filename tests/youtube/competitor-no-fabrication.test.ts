/**
 * Regression test for GAP-15.
 *
 * `checkActivity()` used to prompt the brain to "generate 1-3 realistic activity
 * alerts" from a competitor's stored metadata, then insert the reply into the
 * alerts table — same table, same shape as a real observation, with no network
 * call anywhere. Because the output was varied and specific rather than an
 * obvious constant, it read as intelligence.
 *
 * These tests assert the brain is never consulted and that no invented event
 * types reach the alerts table.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompetitorMonitor } from '../../src/core/competitive/competitor-monitor.js';
import type { ToolBrain } from '../../src/core/brain/brain-text.js';

const dirs: string[] = [];

function monitor(brain?: ToolBrain) {
  const dir = mkdtempSync(join(tmpdir(), 'yt-comp-'));
  dirs.push(dir);
  return new CompetitorMonitor(join(dir, 'competitors.db'), brain);
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A brain that fails the test if it is ever consulted. */
function forbiddenBrain(): { brain: ToolBrain; called: () => boolean } {
  let called = false;
  return {
    brain: {
      chat: async () => {
        called = true;
        return '[{"type":"viral_video","description":"They hit 2M views on a Shorts upload."}]';
      },
    } as unknown as ToolBrain,
    called: () => called,
  };
}

const NAME = 'Some Finance Channel';
const URL = 'https://youtube.com/@somefinance';
const NICHE = 'personal finance';
const add = (m: CompetitorMonitor) => m.addCompetitor(NAME, URL, NICHE);

describe('competitor monitoring does not fabricate activity', () => {
  it('never consults the brain, even when one is supplied', async () => {
    const { brain, called } = forbiddenBrain();
    const m = monitor(brain);
    const id = add(m);

    await m.checkActivity(id);

    expect(called(), 'checkActivity must not ask a model to invent observations').toBe(false);
  });

  it('emits only the honest manual-check alert', async () => {
    const { brain } = forbiddenBrain();
    const m = monitor(brain);
    const id = add(m);

    const alerts = await m.checkActivity(id);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.description).toContain('Manual check recommended');
    expect(alerts[0]!.description).toContain(URL);
    // The invented event types must not appear.
    expect(alerts.map(a => a.type)).not.toContain('viral_video');
    expect(alerts.map(a => a.type)).not.toContain('new_upload');
    expect(alerts.map(a => a.type)).not.toContain('milestone');
  });

  it('behaves identically with and without a brain — the brain is now inert', async () => {
    const withBrain = monitor(forbiddenBrain().brain);
    const withoutBrain = monitor();

    const a = await withBrain.checkActivity(add(withBrain));
    const b = await withoutBrain.checkActivity(add(withoutBrain));

    expect(a.map(x => ({ type: x.type, description: x.description })))
      .toEqual(b.map(x => ({ type: x.type, description: x.description })));
  });

  it('makes no network call', async () => {
    const m = monitor();
    const id = add(m);

    const original = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      throw new Error('no network expected');
    }) as typeof globalThis.fetch;
    try {
      await m.checkActivity(id);
    } finally {
      globalThis.fetch = original;
    }
    expect(called).toBe(false);
  });

  it('still rejects an unknown competitor id', async () => {
    const m = monitor();
    await expect(m.checkActivity('does-not-exist')).rejects.toThrow(/not found/i);
  });
});
