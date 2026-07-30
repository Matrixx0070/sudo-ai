/**
 * @file overnight-improve.test.ts
 * @description TX19 v1 — overnight cycle files a TX10 deploy card; Deploy is
 * an APPROVAL ARTIFACT only (nothing auto-applies — AL8.6); engine failure
 * files no card; absent protocol HOLDs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runOvernightCycle, renderDeployCard, overnightHourUtc } from '../../src/core/channels/overnight-improve.js';
import { CheckpointProtocol, CHECKPOINT_HOLD } from '../../src/core/channels/checkpoint-protocol.js';
import { initCheckpointProtocol, _resetCheckpointProtocol } from '../../src/core/channels/checkpoint-registry.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tx19-')); _resetCheckpointProtocol(); });
afterEach(() => { _resetCheckpointProtocol(); rmSync(dir, { recursive: true, force: true }); });

const RUN = {
  healthScore: 87,
  summary: 's',
  actions: [
    { type: 'learnings_update', description: 'Updated LEARNINGS.md', applied: true },
    { type: 'draft_patch', description: 'AutoResearch for browser.scrape', applied: false },
  ],
};

describe('TX19 overnight deploy card', () => {
  it('T19-1: Deploy tap → decision artifact persisted, result Deploy', async () => {
    const proto = new CheckpointProtocol(join(dir, 'cp.db'), async (p) => {
      setTimeout(() => proto.handleCallback(p.buttons[0]!.callbackData, 'owner'), 5);
    });
    initCheckpointProtocol(proto);
    try {
      const r = await runOvernightCycle(async () => RUN, '2026-07-30', 5_000);
      expect(r.ran).toBe(true);
      expect(r.decision).toBe('Deploy');
      const rows = proto.getPending();
      expect(rows).toHaveLength(0); // decided
    } finally { proto.close(); }
  });

  it('T19-2: nobody taps → HOLD, checkpoint stays pending (parked for review)', async () => {
    const proto = new CheckpointProtocol(join(dir, 'cp.db'), async () => {});
    initCheckpointProtocol(proto);
    try {
      const r = await runOvernightCycle(async () => RUN, '2026-07-30', 30);
      expect(r.decision).toBe(CHECKPOINT_HOLD);
      expect(proto.getPending()).toHaveLength(1);
      expect(proto.getPending()[0]!.kind).toBe('tx19:deploy');
    } finally { proto.close(); }
  });

  it('T19-3: engine failure files NO checkpoint', async () => {
    const proto = new CheckpointProtocol(join(dir, 'cp.db'), async () => {});
    initCheckpointProtocol(proto);
    try {
      const r = await runOvernightCycle(async () => { throw new Error('engine down'); }, '2026-07-30', 30);
      expect(r.ran).toBe(false);
      expect(proto.getPending()).toHaveLength(0);
    } finally { proto.close(); }
  });

  it('T19-4: absent protocol → HOLD (invariant 8)', async () => {
    const r = await runOvernightCycle(async () => RUN, '2026-07-30', 30);
    expect(r.ran).toBe(true);
    expect(r.decision).toBe(CHECKPOINT_HOLD);
  });

  it('T19-5: card renders gate-passed vs held sections + the no-auto-apply note', () => {
    const card = renderDeployCard(RUN, '2026-07-30');
    expect(card).toContain('Gate-passed (1):');
    expect(card).toContain('✓ [learnings_update]');
    expect(card).toContain('Held by gate (1):');
    expect(card).toContain('applying stays manual');
  });

  it('T19-6: hour env default 3, parsed, garbage-safe', () => {
    delete process.env['SUDO_TX19_HOUR_UTC'];
    expect(overnightHourUtc()).toBe(3);
    process.env['SUDO_TX19_HOUR_UTC'] = '5';
    expect(overnightHourUtc()).toBe(5);
    process.env['SUDO_TX19_HOUR_UTC'] = 'x';
    expect(overnightHourUtc()).toBe(3);
    delete process.env['SUDO_TX19_HOUR_UTC'];
  });
});
