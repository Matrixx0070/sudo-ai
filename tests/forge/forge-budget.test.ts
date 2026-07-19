/**
 * F108 slice 2 — forge kill-switch + spend budget.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  forgeEnabled,
  resolveForgeCaps,
  ForgeBudget,
  getForgeSpendSnapshot,
  __resetForgeDailyUsage,
} from '../../src/core/forge/forge-budget.js';
import { ForgeOrchestrator } from '../../src/core/forge/forge-orchestrator.js';
import { XaiEnsemble } from '../../src/core/forge/xai-ensemble.js';

const savedEnv = { ...process.env };

beforeEach(() => {
  __resetForgeDailyUsage();
});
afterEach(() => {
  process.env = { ...savedEnv };
  __resetForgeDailyUsage();
});

describe('F108 forge kill-switch', () => {
  it('defaults ON to preserve behaviour; SUDO_FORGE=0 disables', () => {
    expect(forgeEnabled({})).toBe(true);
    expect(forgeEnabled({ SUDO_FORGE: '1' })).toBe(true);
    expect(forgeEnabled({ SUDO_FORGE: '0' })).toBe(false);
  });

  it('ForgeOrchestrator.forge returns a failure result when disabled', async () => {
    process.env['SUDO_FORGE'] = '0';
    const orch = new ForgeOrchestrator();
    const res = await orch.forge({ description: 'anything', outputDir: 'src/generated' });
    expect(res.success).toBe(false);
    expect(res.files).toHaveLength(0);
  });
});

describe('F108 forge budget caps', () => {
  it('parses env caps and treats off/none as disabled (Infinity)', () => {
    const caps = resolveForgeCaps({
      SUDO_FORGE_BUDGET_USD_PER_RUN: '5',
      SUDO_FORGE_BUDGET_USD_PER_DAY: 'off',
      SUDO_FORGE_BUDGET_TOKENS_PER_RUN: '1000',
    });
    expect(caps.usdPerRun).toBe(5);
    expect(caps.usdPerDay).toBe(Infinity);
    expect(caps.tokensPerRun).toBe(1000);
  });

  it('per-run token cap trips checkExhausted', () => {
    const b = new ForgeBudget({ SUDO_FORGE_BUDGET_TOKENS_PER_RUN: '1000' });
    expect(b.checkExhausted().exhausted).toBe(false);
    b.recordUsage(1200);
    const c = b.checkExhausted();
    expect(c.exhausted).toBe(true);
    expect(c.reason).toMatch(/per-run token/);
  });

  it('per-day USD cap accumulates across runs (process-local)', () => {
    const env = { SUDO_FORGE_BUDGET_USD_PER_DAY: '0.01', SUDO_FORGE_USD_PER_1K_TOKENS: '0.002' };
    const run1 = new ForgeBudget(env);
    run1.recordUsage(3000); // 3k tokens * 0.002 = $0.006
    expect(run1.checkExhausted().exhausted).toBe(false);
    const run2 = new ForgeBudget(env);
    run2.recordUsage(3000); // day total now $0.012 > $0.01
    const c = run2.checkExhausted();
    expect(c.exhausted).toBe(true);
    expect(c.reason).toMatch(/per-day USD/);
    expect(getForgeSpendSnapshot().usd).toBeGreaterThan(0.01);
  });
});

describe('F108 XaiEnsemble budget enforcement', () => {
  it('throws before any network call when the budget is already exhausted', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const b = new ForgeBudget({ SUDO_FORGE_BUDGET_TOKENS_PER_RUN: '10' });
    b.recordUsage(50); // already over the 10-token per-run cap
    const xai = new XaiEnsemble(b);
    await expect(
      xai.callModel('architect', [{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow(/forge budget exhausted/);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
