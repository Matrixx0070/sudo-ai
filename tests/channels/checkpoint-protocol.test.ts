/**
 * @file checkpoint-protocol.test.ts
 * @description TX10 — the checkpoint seam is harness-enforced (invariant 8):
 * unblocking requires a PERSISTED decision artifact; timeouts resolve HOLD and
 * leave the checkpoint pending; decisions survive restart; stale/invalid taps
 * are ignored.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CheckpointProtocol,
  CHECKPOINT_HOLD,
  checkpointCallbackData,
  parseCheckpointCallback,
} from '../../src/core/channels/checkpoint-protocol.js';

let dir: string;
let proto: CheckpointProtocol;
const sent: Array<{ checkpointId: string; buttons: Array<{ text: string; callbackData: string }> }> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tx10-'));
  sent.length = 0;
  proto = new CheckpointProtocol(join(dir, 'checkpoints.db'), async (p) => { sent.push(p); });
});

afterEach(() => {
  proto.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('TX10 checkpoint protocol', () => {
  it('CP-1: tap → decision persisted FIRST, waiter resolves with the option', async () => {
    const pending = proto.request({ kind: 'mission:phase-1', question: 'Ship it?', options: ['Approve', 'Redirect', 'Abort'] });
    await new Promise((r) => setTimeout(r, 5));
    expect(sent).toHaveLength(1);
    const tap = sent[0]!.buttons[0]!; // Approve

    const handled = proto.handleCallback(tap.callbackData, 'owner-frank');
    expect(handled).toBe(true);

    const result = await pending;
    expect(result.decision).toBe('Approve');
    expect(result.decided).toBe(true);
    // The artifact is the source of truth.
    const row = proto.get(result.checkpointId)!;
    expect(row.status).toBe('decided');
    expect(row.decision).toBe('Approve');
    expect(row.decidedBy).toBe('owner-frank');
    expect(row.decidedAt).toBeTruthy();
  });

  it('CP-2: timeout resolves HOLD and the checkpoint STAYS pending (no auto-approve)', async () => {
    const result = await proto.request({ kind: 'tx19:deploy', question: 'Deploy?', options: ['Yes', 'No'], timeoutMs: 30 });
    expect(result.decision).toBe(CHECKPOINT_HOLD);
    expect(result.decided).toBe(false);
    const pendingRows = proto.getPending();
    expect(pendingRows).toHaveLength(1);
    expect(pendingRows[0]!.status).toBe('pending');
  });

  it('CP-3: a late decision after timeout still lands in the artifact (restart-safe path)', async () => {
    const result = await proto.request({ kind: 'k', question: 'q', options: ['Go'], timeoutMs: 20 });
    expect(result.decision).toBe(CHECKPOINT_HOLD);
    const id = proto.getPending()[0]!.id;
    const decided = proto.decide(id, 0, 'owner-late');
    expect(decided).toBe('Go');
    expect(proto.get(id)!.status).toBe('decided');
    expect(proto.getPending()).toHaveLength(0);
  });

  it('CP-4: double-tap and out-of-range taps are ignored', async () => {
    const pending = proto.request({ kind: 'k', question: 'q', options: ['A', 'B'], timeoutMs: 5_000 });
    await new Promise((r) => setTimeout(r, 5));
    const id = sent[0]!.checkpointId;
    expect(proto.decide(id, 99, 'owner')).toBeNull(); // out of range — still pending
    expect(proto.decide(id, 1, 'owner')).toBe('B');
    expect(proto.decide(id, 0, 'owner')).toBeNull(); // already decided
    const result = await pending;
    expect(result.decision).toBe('B');
    expect(proto.get(id)!.decision).toBe('B');
  });

  it('CP-5: pending checkpoints survive a protocol restart (new instance, same db)', async () => {
    void proto.request({ kind: 'k', question: 'persist me', options: ['Ok'], timeoutMs: 60_000 });
    await new Promise((r) => setTimeout(r, 5));
    const id = sent[0]!.checkpointId;

    const second = new CheckpointProtocol(join(dir, 'checkpoints.db'));
    try {
      const rows = second.getPending();
      expect(rows.map((r) => r.id)).toContain(id);
      expect(second.decide(id, 0, 'owner-after-restart')).toBe('Ok');
      expect(second.get(id)!.status).toBe('decided');
    } finally {
      second.close();
    }
  });

  it('CP-6: a failing sender persists the artifact and keeps waiting (no unblock on send error)', async () => {
    const broken = new CheckpointProtocol(join(dir, 'cp2.db'), async () => { throw new Error('telegram down'); });
    try {
      const result = await broken.request({ kind: 'k', question: 'q', options: ['A'], timeoutMs: 30 });
      expect(result.decision).toBe(CHECKPOINT_HOLD);
      expect(broken.getPending()).toHaveLength(1);
    } finally {
      broken.close();
    }
  });

  it('CP-7: callback data round-trips and rejects foreign prefixes', () => {
    const data = checkpointCallbackData('abc-123', 2);
    expect(parseCheckpointCallback(data)).toEqual({ checkpointId: 'abc-123', optionIndex: 2 });
    expect(parseCheckpointCallback('tx1:stop:xyz')).toBeNull();
    expect(parseCheckpointCallback('tx10:cp:no-index')).toBeNull();
  });
});
