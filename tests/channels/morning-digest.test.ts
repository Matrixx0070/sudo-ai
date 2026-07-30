/**
 * @file morning-digest.test.ts
 * @description TX7 — pure digest renderer + fail-soft snapshot assembly.
 */
import { describe, it, expect } from 'vitest';
import { renderMorningDigest, buildDigestSnapshot, digestHourUtc } from '../../src/core/channels/morning-digest.js';

describe('TX7 morning digest', () => {
  it('DIG-1: renders the full card with all sections', () => {
    const card = renderMorningDigest({
      date: '2026-07-30',
      spend: { todayUsd: 12.34, budgetUsd: 150 },
      cron: { enabledCount: 24, failingCount: 1, lastFailureName: 'gdrive-beat' },
      brain: { domainsUp: 2, domainCount: 3, disabledCount: 1, coolingCount: 3 },
      missions: [{ title: 'Vendor comparison', status: 'awaiting_decision' }],
      pendingCheckpoints: [{ kind: 'mission:Vendor comparison', question: 'Proceed to purchase?' }],
      incidentCount: 0,
    });
    expect(card).toContain('$12.34 / $150.00');
    expect(card).toContain('⚠️ 1 failing (gdrive-beat)');
    expect(card).toContain('domains 2/3 up (1 disabled, 3 cooling)');
    expect(card).toContain('Quiet night');
    expect(card).toContain('Vendor comparison — awaiting_decision');
    expect(card).toContain('Waiting on you');
    expect(card).toContain('Proceed to purchase?');
  });

  it('DIG-2: single-domain brain gets the warning marker', () => {
    const card = renderMorningDigest(buildDigestSnapshot({
      brain: () => ({ domainsUp: 1, domainCount: 3, disabledCount: 4, coolingCount: 0 }),
    }, '2026-07-30'));
    expect(card).toContain('⚠️ domains 1/3 up');
  });

  it('DIG-3: throwing readers degrade to defaults, never throw', () => {
    const snap = buildDigestSnapshot({
      spend: () => { throw new Error('db locked'); },
      incidents: () => { throw new Error('nope'); },
    }, '2026-07-30');
    expect(snap.spend.todayUsd).toBeNull();
    expect(snap.incidentCount).toBe(0);
    expect(renderMorningDigest(snap)).toContain('$?');
  });

  it('DIG-4: digest hour env parses with sane default', () => {
    delete process.env['SUDO_TG_DIGEST_HOUR_UTC'];
    expect(digestHourUtc()).toBe(7);
    process.env['SUDO_TG_DIGEST_HOUR_UTC'] = '22';
    expect(digestHourUtc()).toBe(22);
    process.env['SUDO_TG_DIGEST_HOUR_UTC'] = 'nope';
    expect(digestHourUtc()).toBe(7);
    delete process.env['SUDO_TG_DIGEST_HOUR_UTC'];
  });
});
