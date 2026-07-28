/**
 * @file al8-retention-and-tools.test.ts
 * @description AL8.3 tool delivery via the REAL Spec-9 SkillWorkshop gate
 * (injection scan + workspace-tier capability pinning + path confinement)
 * with the CATEGORY_MAP gotcha as a contract, and AL8.4 retention ledger:
 * immutable adoption facts, quarterly recheck flags-never-reverts,
 * unverifiable rows skipped not flagged, and the flag-OFF cron registration.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import {
  toolPlugin,
  RetentionLedger,
  registerRetentionRecheckCron,
  RETENTION_RECHECK_JOB_NAME,
  type ImprovementDraft,
} from '../../src/core/self-improvement/index.js';
import { SkillWorkshop } from '../../src/core/skills/workshop.js';
import type { CronJob } from '../../src/core/cron/types.js';

const dir = mkdtempSync(join(tmpdir(), 'al834-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const draft = (payload: unknown): ImprovementDraft =>
  ({ type: 'tool', title: 't', rationale: 'r', evalPlan: 'e', payload });

// ---------------------------------------------------------------------------
// AL8.3 — tool artifacts through the real workshop gate
// ---------------------------------------------------------------------------

describe('AL8.3 tool artifacts — the skill package is the vehicle', () => {
  const workshop = new SkillWorkshop({
    mindDbPath: join(dir, 'mind.db'),
    skillsRoot: join(dir, 'skills'),
    stagingDir: join(dir, 'staging'),
  });
  const plugin = toolPlugin({
    workshopGate: (p) => workshop.gate(p),
    knownCategory: (c) => ['textproc', 'coder', 'system'].includes(c),
  });

  const CLEAN_SKILL = '# Summarizer\n\nSummarize long documents into bullet points.\n';

  it('a clean generated skill package clears the REAL workshop gate', async () => {
    const r = await plugin.validate(
      draft({ skillName: 'gen-summarizer', version: '1.0.0', markdown: CLEAN_SKILL, categories: ['textproc'] }),
    );
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/cleared the workshop gate.*textproc/);
  });

  it('the gate refuses capability escalation beyond the workspace tier', async () => {
    const escalating = '---\nname: gen-sneaky\ndescription: t\nversion: 1.0.0\ncaps: [shell.exec]\n---\n\nDo things.\n';
    const r = await plugin.validate(draft({ skillName: 'gen-sneaky', version: '1.0.0', markdown: escalating }));
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/workshop gate refused.*capabilities beyond workspace tier/);
  });

  it('the gate refuses unsafe skill names (path confinement)', async () => {
    const r = await plugin.validate(draft({ skillName: '../escape', version: '1.0.0', markdown: CLEAN_SKILL }));
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/workshop gate refused/);
  });

  it('CATEGORY_MAP gotcha as a contract: unroutable categories are refused', async () => {
    const r = await plugin.validate(
      draft({ skillName: 'gen-x', version: '1.0.0', markdown: CLEAN_SKILL, categories: ['brand-new-cat'] }),
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/unroutable tool categories.*textproc gotcha.*brand-new-cat/);
    // Declared categories with NO checker wired is also a refusal, not a pass.
    const noChecker = toolPlugin({ workshopGate: (p) => workshop.gate(p) });
    const r2 = await noChecker.validate(
      draft({ skillName: 'gen-y', version: '1.0.0', markdown: CLEAN_SKILL, categories: ['textproc'] }),
    );
    expect(r2.ok).toBe(false);
    expect(r2.detail).toMatch(/no CATEGORY_MAP checker wired/);
  });

  it('malformed payloads are refused before any gate work', async () => {
    expect((await plugin.validate(draft({ skillName: '', version: '1', markdown: 'x' }))).ok).toBe(false);
    expect((await plugin.validate(draft(null))).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AL8.4 — retention ledger + quarterly recheck
// ---------------------------------------------------------------------------

describe('AL8.4 retention ledger', () => {
  const adoption = (proposalId: string, baseline = 0.7, candidate = 0.8) => ({
    proposalId,
    artifactType: 'prompt',
    baselineScore: baseline,
    candidateScore: candidate,
    evalSetHash: 'sha256:abc123',
    adoptionPr: 'https://example.test/pr/42',
    revertRef: 'revert:deadbeef',
  });

  it('records adoptions fail-loud and lists them with immutable facts', () => {
    const ledger = new RetentionLedger(join(dir, 'retention1.db'));
    const row = ledger.recordAdoption(adoption('prop-1'));
    expect(row).toMatchObject({ proposalId: 'prop-1', recheckStatus: 'ok', lastRecheckAt: null });
    expect(() => ledger.recordAdoption({ ...adoption('prop-2'), baselineScore: NaN })).toThrow(/finite number/);
    expect(() => ledger.recordAdoption({ ...adoption('prop-3'), evalSetHash: ' ' })).toThrow(/non-empty string/);
    expect(ledger.list()).toHaveLength(1);
    ledger.close();
  });

  it('recheck FLAGS what no longer beats baseline — and never reverts anything', async () => {
    const ledger = new RetentionLedger(join(dir, 'retention2.db'));
    ledger.recordAdoption(adoption('still-good', 0.7, 0.85));
    ledger.recordAdoption(adoption('regressed', 0.7, 0.8));
    ledger.recordAdoption(adoption('uncheckable', 0.7, 0.8));

    const result = await ledger.recheck(async (row) => {
      if (row.proposalId === 'still-good') return 0.82; // still beats 0.7
      if (row.proposalId === 'regressed') return 0.65; // no longer beats baseline
      return null; // cannot evaluate
    });

    expect(result).toMatchObject({ checked: 2, skipped: 1 });
    expect(result.flagged.map((r) => r.proposalId)).toEqual(['regressed']);
    const rows = Object.fromEntries(ledger.list().map((r) => [r.proposalId, r]));
    expect(rows['still-good']).toMatchObject({ recheckStatus: 'ok' });
    expect(rows['regressed']).toMatchObject({ recheckStatus: 'flagged' });
    expect(rows['regressed']!.flagReason).toMatch(/0\.650 no longer beats baseline 0\.700/);
    // Never-drop: the row (and its revert ref) is intact — flagged, not gone.
    expect(rows['regressed']!.revertRef).toBe('revert:deadbeef');
    // Unverifiable ≠ failing: the uncheckable row is untouched, not flagged.
    expect(rows['uncheckable']).toMatchObject({ recheckStatus: 'ok', lastRecheckAt: null });
    // A throwing evaluator also skips, never flags.
    const boom = await ledger.recheck(async () => { throw new Error('bench down'); });
    expect(boom).toMatchObject({ checked: 0, skipped: 3, flagged: [] });
    ledger.close();
  });

  it('quarterly cron registers flag-OFF by default, idempotently, and enables under the flag', () => {
    const jobs = new Map<string, CronJob>();
    const scheduler = {
      listJobs: () => [...jobs.values()],
      removeJob: (id: string) => void jobs.delete(id),
      addJob: (job: Omit<CronJob, 'id'> & { id: string }) => {
        jobs.set(job.id, job as CronJob);
        return job as CronJob;
      },
    };

    const prev = process.env['SUDO_AL8_RETENTION_RECHECK'];
    try {
      delete process.env['SUDO_AL8_RETENTION_RECHECK'];
      const job = registerRetentionRecheckCron(scheduler);
      expect(job).toMatchObject({ id: 'al8-retention-recheck', enabled: false, name: RETENTION_RECHECK_JOB_NAME });
      expect((job.schedule as { expr: string }).expr).toBe('0 4 1 */3 *');

      process.env['SUDO_AL8_RETENTION_RECHECK'] = '1';
      const again = registerRetentionRecheckCron(scheduler); // idempotent re-register
      expect(again.enabled).toBe(true);
      expect(jobs.size).toBe(1);
    } finally {
      if (prev === undefined) delete process.env['SUDO_AL8_RETENTION_RECHECK'];
      else process.env['SUDO_AL8_RETENTION_RECHECK'] = prev;
    }
  });
});
