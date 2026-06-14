/**
 * @file tests/fleet/command-queue.test.ts
 * @description Gap #28c slice 2 — command queue persistence + long-poll.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CommandQueue } from '../../src/core/fleet/command-queue.js';

let tmp: string;
let q: CommandQueue;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'sudo-fleet-q-'));
  q = new CommandQueue({ dbPath: path.join(tmp, 'fleet.db') });
});
afterEach(() => { q.close(); rmSync(tmp, { recursive: true, force: true }); });

describe('CommandQueue', () => {
  it('CQ-01: enqueue + pickup round-trip', () => {
    const id = q.enqueue({ deviceId: 'd1', command: { kind: 'model.get' }, dispatcher: 'admin@host' });
    const row = q.pickup('d1');
    expect(row?.commandId).toBe(id);
    expect(row?.status).toBe('in_flight');
    expect(row?.kind).toBe('model.get');
  });

  it('CQ-02: pickup returns undefined when nothing queued', () => {
    expect(q.pickup('d-empty')).toBeUndefined();
  });

  it('CQ-03: pickup re-delivers the same in_flight command (crash-recovery)', () => {
    // Intentional: if the device picked up command A, crashed before POSTing
    // a result, then re-polled, it must get the same A back. Slice 2 picks
    // queued OR in_flight to preserve this invariant.
    const a = q.enqueue({ deviceId: 'd', command: { kind: 'model.get' }, dispatcher: 'x' });
    q.enqueue({ deviceId: 'd', command: { kind: 'model.get' }, dispatcher: 'x' });
    const first = q.pickup('d');
    const second = q.pickup('d');
    expect(first?.commandId).toBe(a);
    expect(second?.commandId).toBe(a); // re-delivered, NOT the next queued
  });

  it('CQ-03b: after complete, the next pickup returns the next queued command', () => {
    const a = q.enqueue({ deviceId: 'd', command: { kind: 'model.get' }, dispatcher: 'x' });
    const b = q.enqueue({ deviceId: 'd', command: { kind: 'model.set', args: { model: 'x' } }, dispatcher: 'x' });
    q.pickup('d'); // → A in_flight
    q.complete({ commandId: a, result: { status: 'completed' } });
    expect(q.pickup('d')?.commandId).toBe(b);
  });

  it('CQ-04: complete marks status + result', () => {
    const id = q.enqueue({ deviceId: 'd', command: { kind: 'model.set', args: { model: 'gpt-4' } }, dispatcher: 'admin' });
    q.pickup('d'); // → in_flight
    const updated = q.complete({ commandId: id, result: { status: 'completed', result: { model: 'gpt-4' } } });
    expect(updated?.status).toBe('completed');
    expect(updated?.resultJson).toBe('{"model":"gpt-4"}');
  });

  it('CQ-05: complete returns undefined for unknown command', () => {
    expect(q.complete({ commandId: 'nope', result: { status: 'completed' } })).toBeUndefined();
  });

  it('CQ-06: complete on already-completed command is a no-op (returns undefined)', () => {
    const id = q.enqueue({ deviceId: 'd', command: { kind: 'model.get' }, dispatcher: 'x' });
    q.pickup('d');
    q.complete({ commandId: id, result: { status: 'completed' } });
    expect(q.complete({ commandId: id, result: { status: 'completed' } })).toBeUndefined();
  });

  it('CQ-07: long-poll resolves when enqueue lands', async () => {
    const promise = q.pickupLongPoll('d', 1000);
    setTimeout(() => q.enqueue({ deviceId: 'd', command: { kind: 'model.get' }, dispatcher: 'x' }), 50);
    const row = await promise;
    expect(row?.kind).toBe('model.get');
    expect(row?.status).toBe('in_flight');
  });

  it('CQ-08: long-poll returns undefined on timeout', async () => {
    const row = await q.pickupLongPoll('d-quiet', 100);
    expect(row).toBeUndefined();
  });

  it('CQ-09: pickup is FIFO across multiple deviceIds (independent queues)', () => {
    q.enqueue({ deviceId: 'd-a', command: { kind: 'model.get' }, dispatcher: 'x' });
    q.enqueue({ deviceId: 'd-b', command: { kind: 'model.set', args: { model: 'x' } }, dispatcher: 'x' });
    expect(q.pickup('d-a')?.kind).toBe('model.get');
    expect(q.pickup('d-b')?.kind).toBe('model.set');
  });

  it('CQ-10: markTimeout transitions queued→timeout', () => {
    const id = q.enqueue({ deviceId: 'd', command: { kind: 'model.get' }, dispatcher: 'x' });
    const r = q.markTimeout(id);
    expect(r?.status).toBe('timeout');
  });

  it('CQ-11: queue survives close+reopen — persisted rows still visible', () => {
    q.enqueue({ deviceId: 'd', command: { kind: 'model.get' }, dispatcher: 'x' });
    q.close();
    const q2 = new CommandQueue({ dbPath: path.join(tmp, 'fleet.db') });
    expect(q2.count()).toBe(1);
    expect(q2.pickup('d')?.kind).toBe('model.get');
    q2.close();
    q = new CommandQueue({ dbPath: path.join(tmp, 'fleet.db') }); // for afterEach
  });

  it('CQ-12: listForDevice returns recent commands for a device only', () => {
    q.enqueue({ deviceId: 'd-a', command: { kind: 'model.get' }, dispatcher: 'x' });
    q.enqueue({ deviceId: 'd-b', command: { kind: 'model.get' }, dispatcher: 'x' });
    q.enqueue({ deviceId: 'd-a', command: { kind: 'model.set', args: { model: 'gpt-4' } }, dispatcher: 'x' });
    const aList = q.listForDevice('d-a');
    expect(aList.length).toBe(2);
    expect(aList.every((c) => c.deviceId === 'd-a')).toBe(true);
  });
});
