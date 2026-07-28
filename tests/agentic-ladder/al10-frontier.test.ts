/**
 * @file al10-frontier.test.ts
 * @description AL10 frontier engine — proposal engine ONLY:
 *   - ledger append/dedup/rank/pick/decline + markdown mirror;
 *   - miners are pure over injected seams (signals rows, failure clusters,
 *     eval saturation, abstraction patterns incl. god nodes);
 *   - the draft ADR carries the doctrine skeleton and NO authority;
 *   - the review pack ranks by value/cost and embeds the generational
 *     scorecard; the scan cron registers flag-OFF by default (AL10.6).
 */

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import {
  FrontierLedger,
  mineSignals,
  mineFailureClusters,
  mineEvalSaturation,
  mineAbstractions,
  draftAdr,
  buildReviewPack,
  registerFrontierScanCron,
  FRONTIER_SCAN_JOB_NAME,
  type FrontierEntryInput,
} from '../../src/core/self-improvement/index.js';
import type { DetectedPatterns } from '../../src/core/self-improvement/index.js';
import type { CronJob } from '../../src/core/cron/types.js';

const dir = mkdtempSync(join(tmpdir(), 'al10-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env['SUDO_AL_FRONTIER'];
});

const entry = (key: string, value = 3, cost = 2): FrontierEntryInput => ({
  key,
  signal: `signal ${key}`,
  evidence: 'evidence cited',
  proposedCapability: `capability for ${key}`,
  estCost: cost,
  estValue: value,
  dependencies: [],
  source: 'manual',
});

describe('AL10.1 frontier ledger', () => {
  it('appends deduped, ranks by value/cost, human decisions are terminal, markdown mirrors', () => {
    const ledger = new FrontierLedger(join(dir, 'frontier.db'));
    expect(ledger.append(entry('a', 4, 1))).toBe(true);
    expect(ledger.append(entry('a'))).toBe(false); // dedup
    expect(ledger.append(entry('b', 2, 4))).toBe(true);
    expect(() => ledger.append(entry('bad', 9, 1))).toThrow(/1\.\.5/);

    // Ids are looked up, not assumed: a deduped insert still burns an
    // AUTOINCREMENT id, so 'b' is not necessarily id 2.
    const byKey = Object.fromEntries(ledger.list().map((e) => [e.key, e.id]));
    const picked = ledger.pick(byKey['a']!, 'frank', 'F131');
    expect(picked).toMatchObject({ status: 'picked', featureId: 'F131', decidedBy: 'frank' });
    expect(() => ledger.pick(byKey['a']!, 'frank', 'F132')).toThrow(/already decided/);
    ledger.decline(byKey['b']!, 'frank');

    const mdPath = join(dir, 'FRONTIER.md');
    ledger.syncMarkdown(mdPath);
    const md = readFileSync(mdPath, 'utf-8');
    expect(md).toContain('machine-proposed capability directions');
    expect(md).toContain(`#${byKey['a']} PICKED as F131`);
    ledger.close();
  });
});

describe('AL10 miners — pure over injected seams', () => {
  it('mineSignals parses SIGNALS.md rows and skips prose', () => {
    const rows = mineSignals([
      '# SIGNALS',
      '2026-07-28 | users pipe bench output into dashboards | 4 requests in traces | first-class bench export API',
      'not a row',
    ].join('\n'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'signals', proposedCapability: 'first-class bench export API' });
    expect(rows[0]!.evidence).toContain('SIGNALS.md 2026-07-28');
  });

  it('mineFailureClusters thresholds on rate+volume; mineEvalSaturation on maxed suites', () => {
    const patterns: DetectedPatterns = {
      failingTools: [
        { name: 'browser.scrape', calls: 10, failures: 4, failRate: 0.4 },
        { name: 'rare.tool', calls: 2, failures: 2, failRate: 1 }, // volume too low
      ],
      unusedTools: [], badFeedbackTypes: [], routingGaps: [], cronIssues: [],
      healthScore: 80, analysedAt: '2026-07-28T12:00:00.000Z',
    };
    const clusters = mineFailureClusters(patterns);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.key).toBe('failure-cluster:browser.scrape');

    const sat = mineEvalSaturation([
      { suite: 'agent-tasks', passRate: 0.97, tasks: 8 },
      { suite: 'builtin-tasks', passRate: 0.6, tasks: 5 },
    ]);
    expect(sat).toHaveLength(1);
    expect(sat[0]!.proposedCapability).toMatch(/proposes against, never edits/);
  });

  it('mineAbstractions: ≥3 same-type adoptions → engine proposal; god nodes → restructure ADR path', () => {
    const retention = (type: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: i, proposalId: `p-${type}-${i}`, artifactType: type,
        baselineScore: 0.5, candidateScore: 0.6, evalSetHash: 'h', adoptionPr: 'pr', revertRef: 'r',
        adoptedAt: 'now', lastRecheckAt: null, recheckStatus: 'ok' as const, flagReason: null,
      }));
    const out = mineAbstractions({
      generations: [],
      retention: [...retention('prompt', 3), ...retention('tool', 2)],
      graph: { godNodes: [{ name: 'loop.ts', degree: 120 }, { name: 'small.ts', degree: 4 }] },
    });
    expect(out.map((e) => e.key).sort()).toEqual(['abstraction:artifact:prompt', 'abstraction:god-node:loop.ts']);
    expect(out.find((e) => e.key.includes('god-node'))!.proposedCapability).toMatch(/AFTER ADR approval/);
  });

  it('draftAdr carries the doctrine skeleton and explicitly no authority', () => {
    const adr = draftAdr(entry('x'));
    for (const section of ['## Problem', '## Alternatives', '## Decision', '## Tradeoffs', '## Consequences']) {
      expect(adr).toContain(section);
    }
    expect(adr).toMatch(/DRAFT — machine-proposed, human-decided/);
    expect(adr).toMatch(/carries NO authority/);
  });
});

describe('AL10.5 review pack + AL10.6 flag-OFF cron', () => {
  it('the pack ranks by value/cost and embeds scorecard + saturation', () => {
    const ledger = new FrontierLedger(join(dir, 'pack.db'));
    ledger.append(entry('low', 2, 4));
    ledger.append(entry('high', 5, 1));
    const pack = buildReviewPack({
      ledger,
      generations: [{ manifestVersion: '1.0.0', proposals: 4, byStatus: {}, adopted: 2, meanScoreDelta: 0.12, flagged: 1 }],
      saturation: [{ suite: 'agent-tasks', passRate: 0.97, tasks: 8 }],
    });
    const highIdx = pack.indexOf('capability for high');
    const lowIdx = pack.indexOf('capability for low');
    expect(highIdx).toBeGreaterThan(-1);
    expect(highIdx).toBeLessThan(lowIdx); // ranked
    expect(pack).toContain('manifest 1.0.0: 4 proposals, 2 adopted');
    expect(pack).toContain('SATURATED');
    expect(pack).toMatch(/loop closes through the human/);
    ledger.close();
  });

  it('the scan cron registers DISABLED by default and enables only under SUDO_AL_FRONTIER=1', () => {
    const jobs = new Map<string, CronJob>();
    const scheduler = {
      listJobs: () => [...jobs.values()],
      removeJob: (id: string) => void jobs.delete(id),
      addJob: (job: Omit<CronJob, 'id'> & { id: string }) => (jobs.set(job.id, job as CronJob), job as CronJob),
    };
    delete process.env['SUDO_AL_FRONTIER'];
    expect(registerFrontierScanCron(scheduler)).toMatchObject({ id: 'al10-frontier-scan', enabled: false, name: FRONTIER_SCAN_JOB_NAME });
    process.env['SUDO_AL_FRONTIER'] = '1';
    expect(registerFrontierScanCron(scheduler).enabled).toBe(true);
    expect(jobs.size).toBe(1); // idempotent
  });
});
