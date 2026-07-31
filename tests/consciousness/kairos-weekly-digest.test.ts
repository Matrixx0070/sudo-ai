/**
 * ADR-0006 weekly digest — pins the orchestration that replaced the
 * timer-driven repair loop: budget gating, per-class analysis, and the
 * branch/no-branch decision. Git and arsenal are injected; no model, no repo.
 */

import { describe, it, expect } from 'vitest';
import {
  runKairosWeeklyDigest,
  digestBranchName,
  renderDigest,
  type WeeklyDigestDeps,
  type DigestAnalysis,
} from '../../src/core/consciousness/kairos-weekly-digest.js';
import type { KairosObservation } from '../../src/core/consciousness/kairos.js';

const NOW = new Date('2026-08-02T05:00:00Z');

function obs(type: 'large_file' | 'codebase_degraded', message: string): KairosObservation {
  return { timestamp: NOW.toISOString(), type, severity: 'WARN', message };
}

function deps(over: Partial<WeeklyDigestDeps>): WeeklyDigestDeps {
  return {
    observe: async () => [obs('large_file', '3 file(s) exceed 750 lines')],
    analyze: async () => ({ report: 'r', edits: [{ filePath: 'src/a.ts', content: 'x' }] }),
    consumeBudget: () => ({ allowed: true, used: 1, max: 4 }),
    git: () => { throw new Error('rev-parse miss'); }, // default: branch free, worktree ops stubbed per-test
    now: NOW,
    ...over,
  };
}

describe('digestBranchName', () => {
  it('is date-stamped and disambiguates same-day re-runs', () => {
    expect(digestBranchName(NOW)).toBe('kairos/digest-2026-08-02');
    expect(digestBranchName(NOW, 1)).toBe('kairos/digest-2026-08-02-2');
  });
});

describe('renderDigest', () => {
  it('lists every proposed file and carries the arsenal report', () => {
    const analyses: DigestAnalysis[] = [{
      observation: obs('codebase_degraded', 'TypeScript: 3 error(s)'),
      mode: 'fix',
      report: 'ARSENAL REPORT TEXT',
      edits: [{ filePath: 'src/x.ts', content: '' }, { filePath: 'src/y.ts', content: '' }],
    }];
    const md = renderDigest(analyses, NOW);
    expect(md).toContain('2026-08-02');
    expect(md).toContain('- src/x.ts');
    expect(md).toContain('- src/y.ts');
    expect(md).toContain('ARSENAL REPORT TEXT');
    expect(md).toContain('Nothing is applied');
  });
});

describe('runKairosWeeklyDigest', () => {
  it('no actionable observations → no analysis, no branch', async () => {
    let analyzed = 0;
    const summary = await runKairosWeeklyDigest(deps({
      observe: async () => [],
      analyze: async () => { analyzed++; return { report: '', edits: [] }; },
    }));
    expect(analyzed).toBe(0);
    expect(summary.branch).toBeNull();
    expect(summary.observations).toBe(0);
  });

  it('budget exhaustion halts gracefully instead of running', async () => {
    let analyzed = 0;
    const summary = await runKairosWeeklyDigest(deps({
      consumeBudget: () => ({ allowed: false, used: 4, max: 4 }),
      analyze: async () => { analyzed++; return { report: '', edits: [] }; },
    }));
    expect(analyzed).toBe(0);
    expect(summary.budgetHalted).toBe(true);
    expect(summary.branch).toBeNull();
  });

  it('analyses with zero edits do not create a branch', async () => {
    const gitCalls: string[][] = [];
    const summary = await runKairosWeeklyDigest(deps({
      analyze: async () => ({ report: 'clean', edits: [] }),
      git: (args) => { gitCalls.push(args); return ''; },
    }));
    expect(summary.analysesRun).toBe(1);
    expect(summary.branch).toBeNull();
    expect(gitCalls).toEqual([]);
  });

  it('edits land on a kairos/digest-<date> branch via a temp worktree', async () => {
    const gitCalls: string[][] = [];
    const summary = await runKairosWeeklyDigest(deps({
      observe: async () => [
        obs('large_file', '3 file(s) exceed 750 lines'),
        obs('codebase_degraded', 'TypeScript: 2 error(s)'),
      ],
      git: (args) => {
        gitCalls.push(args);
        if (args[0] === 'rev-parse') throw new Error('branch free');
        return '';
      },
    }));
    expect(summary.analysesRun).toBe(2);
    expect(summary.editsProposed).toBe(2);
    expect(summary.branch).toBe('kairos/digest-2026-08-02');
    const ops = gitCalls.map(a => a[0]);
    expect(ops).toContain('worktree'); // add + remove
    expect(ops).toContain('checkout');
    expect(ops).toContain('commit');
  });

  it('an existing digest branch gets a suffixed name', async () => {
    const summary = await runKairosWeeklyDigest(deps({
      git: (args) => {
        if (args[0] === 'rev-parse' && args.includes('refs/heads/kairos/digest-2026-08-02')) return 'deadbeef';
        if (args[0] === 'rev-parse') throw new Error('free');
        return '';
      },
    }));
    expect(summary.branch).toBe('kairos/digest-2026-08-02-2');
  });

  it('a throwing analyze degrades to a skip, never a throw', async () => {
    const summary = await runKairosWeeklyDigest(deps({
      analyze: async () => { throw new Error('model down'); },
    }));
    expect(summary.analysesSkipped).toBe(1);
    expect(summary.branch).toBeNull();
  });

  it('notify reports the branch for review', async () => {
    const notes: string[] = [];
    await runKairosWeeklyDigest(deps({
      git: (args) => { if (args[0] === 'rev-parse') throw new Error('free'); return ''; },
      notify: (title, body) => { notes.push(`${title} :: ${body}`); },
    }));
    expect(notes.join('\n')).toContain('kairos/digest-2026-08-02');
  });
});
