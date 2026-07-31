/** Resource sampler (ADR-0007 Phase 2): /proc process-tree RSS + CPU metering. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listProcessTree, startResourceSampler } from '../../../src/core/eval/sandbox/resource-sampler.js';
import { RunJournal, readJournal } from '../../../src/core/eval/sandbox/run-journal.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-sampler-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('listProcessTree', () => {
  it('includes the root pid itself', () => {
    expect(listProcessTree(process.pid)).toContain(process.pid);
  });
});

describe('startResourceSampler — sampling self', () => {
  it('measures nonzero RSS + CPU for this process and journals resource.sample events', async () => {
    const journalPath = path.join(dir, 'journal.jsonl');
    const sampler = startResourceSampler({
      pid: process.pid,
      journal: new RunJournal(journalPath),
      intervalMs: 40,
    });
    await sleep(120);
    const totals = sampler.stop();

    // a live Node process is well past 10 MB RSS and has burned some CPU
    expect(totals.peakRssMb).toBeGreaterThan(10);
    expect(totals.cpuSecs).toBeGreaterThan(0);
    expect(totals.samples).toBeGreaterThanOrEqual(2);

    const events = readJournal(journalPath).filter((e) => e.type === 'resource.sample');
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(Number(events[0]!['rssMb'])).toBeGreaterThan(10);
    expect(Number(events[0]!['pids'])).toBeGreaterThanOrEqual(1);
  });

  it('stop() is safe and idempotent-ish after the target vanishes (no throw)', async () => {
    // a pid that certainly does not exist — sampler must degrade to zeros
    const sampler = startResourceSampler({ pid: 2 ** 22 - 3, intervalMs: 30 });
    await sleep(70);
    const totals = sampler.stop();
    expect(totals.samples).toBeGreaterThanOrEqual(1);
    expect(totals.peakRssMb).toBe(0);
  });
});
