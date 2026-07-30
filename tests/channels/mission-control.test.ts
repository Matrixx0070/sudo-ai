/**
 * @file mission-control.test.ts
 * @description TX9 v1 — mission registry + living card + TX10 decision points.
 * The card is one message edited in place; checkpoints ride the TX10 protocol
 * with HOLD-never-continues semantics (invariant 8); missions survive restart.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MissionControl, renderMissionCard } from '../../src/core/channels/mission-control.js';
import { CheckpointProtocol, CHECKPOINT_HOLD } from '../../src/core/channels/checkpoint-protocol.js';
import { initCheckpointProtocol, _resetCheckpointProtocol } from '../../src/core/channels/checkpoint-registry.js';

let dir: string;
let mc: MissionControl;
const posts: string[] = [];
const edits: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tx9-'));
  posts.length = 0;
  edits.length = 0;
  _resetCheckpointProtocol();
  mc = new MissionControl(join(dir, 'missions.db'), {
    post: async (text) => { posts.push(text); return { chatId: 'chat-1', messageId: 'msg-1' }; },
    edit: async (_c, _m, text) => { edits.push(text); },
  });
});

afterEach(() => {
  mc.close();
  _resetCheckpointProtocol();
  rmSync(dir, { recursive: true, force: true });
});

describe('TX9 mission control', () => {
  it('MC-1: start posts the living card with phase list; first phase running', async () => {
    const m = await mc.start('Vendor comparison', ['Research', 'Compare', 'Report']);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain('Mission: Vendor comparison');
    expect(posts[0]).toContain('✻ Research');
    expect(posts[0]).toContain('· Compare');
    expect(m.chatId).toBe('chat-1');
  });

  it('MC-2: phase done → card edited in place, next phase auto-starts', async () => {
    const m = await mc.start('T', ['A', 'B']);
    await mc.updatePhase(m.id, 'A', 'done', '3 vendors found');
    expect(edits.at(-1)).toContain('✓ A — 3 vendors found');
    expect(edits.at(-1)).toContain('✻ B');
  });

  it('MC-3: checkpoint Approve resumes; artifact persisted via TX10', async () => {
    const proto = new CheckpointProtocol(join(dir, 'cp.db'), async (p) => {
      // Owner taps "Approve" as soon as the prompt arrives.
      setTimeout(() => proto.handleCallback(p.buttons[0]!.callbackData, 'owner'), 5);
    });
    initCheckpointProtocol(proto);
    try {
      const m = await mc.start('T', ['A']);
      const decision = await mc.checkpoint(m.id, 'Proceed to purchase?', 5_000);
      expect(decision).toBe('Approve');
      expect(mc.get(m.id)!.status).toBe('running');
      // Card reflected the awaiting state at some point.
      expect(edits.some((e) => e.includes('awaiting your decision'))).toBe(true);
    } finally { proto.close(); }
  });

  it('MC-4: checkpoint Abort settles the mission aborted', async () => {
    const proto = new CheckpointProtocol(join(dir, 'cp.db'), async (p) => {
      setTimeout(() => proto.handleCallback(p.buttons[2]!.callbackData, 'owner'), 5);
    });
    initCheckpointProtocol(proto);
    try {
      const m = await mc.start('T', ['A']);
      const decision = await mc.checkpoint(m.id, 'Proceed?', 5_000);
      expect(decision).toBe('Abort');
      expect(mc.get(m.id)!.status).toBe('aborted');
    } finally { proto.close(); }
  });

  it('MC-5: HOLD (timeout) leaves the mission awaiting_decision — never continues', async () => {
    const proto = new CheckpointProtocol(join(dir, 'cp.db'), async () => { /* nobody taps */ });
    initCheckpointProtocol(proto);
    try {
      const m = await mc.start('T', ['A']);
      const decision = await mc.checkpoint(m.id, 'Proceed?', 30);
      expect(decision).toBe(CHECKPOINT_HOLD);
      expect(mc.get(m.id)!.status).toBe('awaiting_decision');
    } finally { proto.close(); }
  });

  it('MC-6: no checkpoint protocol wired → HOLD (invariant 8)', async () => {
    const m = await mc.start('T', ['A']);
    const decision = await mc.checkpoint(m.id, 'Proceed?', 30);
    expect(decision).toBe(CHECKPOINT_HOLD);
    expect(mc.get(m.id)!.status).toBe('awaiting_decision');
  });

  it('MC-7: active missions survive restart (new instance, same db)', async () => {
    const m = await mc.start('Persist me', ['A']);
    const second = new MissionControl(join(dir, 'missions.db'));
    try {
      const active = second.getActive();
      expect(active.map((x) => x.id)).toContain(m.id);
    } finally { second.close(); }
  });

  it('MC-8: card transport failure never breaks the mission (uncarded but running)', async () => {
    const broken = new MissionControl(join(dir, 'm2.db'), {
      post: async () => { throw new Error('telegram down'); },
      edit: async () => { throw new Error('telegram down'); },
    });
    try {
      const m = await broken.start('T', ['A']);
      expect(broken.get(m.id)!.status).toBe('running');
      await broken.complete(m.id, 'done anyway');
      expect(broken.get(m.id)!.status).toBe('done');
    } finally { broken.close(); }
  });

  it('MC-9: renderer is pure and complete', () => {
    const text = renderMissionCard({
      id: 'x', title: 'T', status: 'done',
      phases: [{ name: 'A', status: 'done', note: 'ok' }, { name: 'B', status: 'skipped' }],
      createdAt: '', updatedAt: '',
    });
    expect(text).toContain('✅ complete');
    expect(text).toContain('✓ A — ok');
    expect(text).toContain('↷ B');
  });
});
