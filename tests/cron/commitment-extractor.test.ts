/**
 * @file tests/cron/commitment-extractor.test.ts
 * @description Tests for the commitment extractor — parse guard + bounded
 *   scheduling (confidence floor, horizon cap, job cap, dedup).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Isolate DATA_DIR before the cron store module (which captures CRON_DIR from
// PATHS at load) is imported, so this never touches the real cron/jobs.json.
vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');
  process.env['DATA_DIR'] = mkdtempSync(join(tmpdir(), 'commit-datadir-'));
});

import { CronStore } from '../../src/core/cron/store.js';
import { CommitmentExtractor, parseCommitments } from '../../src/core/cron/commitment-extractor.js';

function futureIso(msFromNow: number): string {
  return new Date(Date.now() + msFromNow).toISOString();
}
function brainReturning(json: string) {
  return { call: async () => ({ content: json }) };
}

describe('parseCommitments', () => {
  it('parses clean and fenced JSON, [] on garbage', () => {
    expect(parseCommitments('{"commitments":[{"action":"remind","when":"2026-07-09T09:00:00Z","confidence":0.9}]}'))
      .toEqual([{ action: 'remind', when: '2026-07-09T09:00:00Z', confidence: 0.9 }]);
    expect(parseCommitments('```json\n{"commitments":[]}\n```')).toEqual([]);
    expect(parseCommitments('no json here')).toEqual([]);
    expect(parseCommitments('{"commitments":"nope"}')).toEqual([]);
  });
});

describe('CommitmentExtractor.onTurnEnd', () => {
  let store: CronStore;
  const saved = process.env['SUDO_COMMITMENTS'];

  beforeEach(() => {
    store = new CronStore();
    for (const j of store.list()) store.remove(j.id); // clean slate each test
    process.env['SUDO_COMMITMENTS'] = '1';
  });
  afterEach(() => {
    for (const j of store.list()) store.remove(j.id);
    if (saved === undefined) delete process.env['SUDO_COMMITMENTS'];
    else process.env['SUDO_COMMITMENTS'] = saved;
  });

  const commitmentJobs = () => store.list().filter((j) => j.name.startsWith('commitment:'));

  it('schedules a valid one-shot commitment', async () => {
    const ce = new CommitmentExtractor(brainReturning(`{"commitments":[{"action":"remind to drink water","when":"${futureIso(120000)}","confidence":0.9}]}`), store);
    await ce.onTurnEnd('s1', 'remind me', 'I will remind you in 2 minutes.');
    const jobs = commitmentJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].schedule.kind).toBe('at');
    expect(jobs[0].payload.kind).toBe('agentTurn');
  });

  it('cheap pre-filter: no future-intent marker → brain never called', async () => {
    let called = 0;
    const ce = new CommitmentExtractor({ call: async () => { called++; return { content: '{"commitments":[]}' }; } }, store);
    await ce.onTurnEnd('s1', 'hi', 'Here is the answer, done.');
    expect(called).toBe(0);
    expect(commitmentJobs()).toHaveLength(0);
  });

  it('dedups identical follow-ups', async () => {
    const ce = new CommitmentExtractor(brainReturning(`{"commitments":[{"action":"send the report","when":"${futureIso(120000)}","confidence":0.9}]}`), store);
    await ce.onTurnEnd('s1', 'x', 'I will follow up and send the report.');
    await ce.onTurnEnd('s1', 'x', 'I will follow up and send the report.');
    expect(commitmentJobs()).toHaveLength(1);
  });

  it('rejects low confidence, past, and far-future commitments', async () => {
    await new CommitmentExtractor(brainReturning(`{"commitments":[{"action":"a","when":"${futureIso(120000)}","confidence":0.4}]}`), store).onTurnEnd('s', 'x', 'I will do it later');
    await new CommitmentExtractor(brainReturning(`{"commitments":[{"action":"b","when":"${futureIso(-120000)}","confidence":0.9}]}`), store).onTurnEnd('s', 'x', 'I will do it later');
    await new CommitmentExtractor(brainReturning(`{"commitments":[{"action":"c","when":"${futureIso(30*24*3600*1000)}","confidence":0.9}]}`), store).onTurnEnd('s', 'x', 'I will do it later');
    expect(commitmentJobs()).toHaveLength(0);
  });

  it('caps pending commitments', async () => {
    process.env['SUDO_COMMITMENTS_MAX_JOBS'] = '2';
    let n = 0;
    const ce = new CommitmentExtractor({ call: async () => ({ content: `{"commitments":[{"action":"job ${n++}","when":"${futureIso(120000 + n * 1000)}","confidence":0.9}]}` }) }, store);
    for (let i = 0; i < 5; i++) await ce.onTurnEnd('s', 'x', 'I will follow up');
    expect(commitmentJobs().length).toBeLessThanOrEqual(2);
    delete process.env['SUDO_COMMITMENTS_MAX_JOBS'];
  });

  it('brain throwing is fail-open', async () => {
    const ce = new CommitmentExtractor({ call: async () => { throw new Error('boom'); } }, store);
    await expect(ce.onTurnEnd('s', 'x', 'I will follow up tomorrow')).resolves.toBeUndefined();
    expect(commitmentJobs()).toHaveLength(0);
  });
});
