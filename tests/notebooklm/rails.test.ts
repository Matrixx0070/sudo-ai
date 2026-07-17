import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  allRituals,
  buildRitualManifest,
  assertTier1Budget,
  tier1WeeklyMinutes,
  TIER1_WEEKLY_BUDGET_MIN,
  registerRitual,
} from '../../src/core/notebooklm/rituals.js';
import { NOTEBOOKLM_FOLDERS } from '../../src/core/notebooklm/folders.js';
import { isNotebookLmEnabled } from '../../src/core/notebooklm/config.js';

describe('E3 ritual manifest + Tier-1 budget', () => {
  it('Tier-1 rituals stay within the ≤20 min/week budget', () => {
    expect(tier1WeeklyMinutes()).toBeLessThanOrEqual(TIER1_WEEKLY_BUDGET_MIN);
    expect(() => assertTier1Budget()).not.toThrow();
  });
  it('rejects a ritual over the 5-min design cap', () => {
    expect(() => registerRitual({ id: 'too-long', featureIds: ['Fx'], tier: 1, cadence: 'daily', clickPath: 'x', pasteBack: 'none', minutes: 6 })).toThrow(/5-min/);
  });
  it('the manifest displays the computed Tier-1 budget line', () => {
    const md = buildRitualManifest();
    expect(md).toMatch(new RegExp(`Tier-1 \\(core\\) weekly budget: \\d+ / ${TIER1_WEEKLY_BUDGET_MIN} min`));
    expect(md).toContain('self-attested');
    expect(md).toContain('brain-radio');
  });
  it('has at least the F39 seed ritual', () => {
    expect(allRituals().some((r) => r.id === 'brain-radio' && r.tier === 1)).toBe(true);
  });
});

describe('E1 folder tree', () => {
  it('declares the full notebooklm subtree, parents before children', () => {
    expect(NOTEBOOKLM_FOLDERS).toContain('notebooklm/returns/held');
    expect(NOTEBOOKLM_FOLDERS).toContain('notebooklm/embassy/outbound');
    // parent precedes child
    const idx = (p: string) => NOTEBOOKLM_FOLDERS.indexOf(p);
    expect(idx('notebooklm')).toBeLessThan(idx('notebooklm/returns'));
    expect(idx('notebooklm/returns')).toBeLessThan(idx('notebooklm/returns/held'));
    expect(idx('notebooklm/releases')).toBeLessThan(idx('notebooklm/releases/forks-museum'));
  });
});

describe('config gate', () => {
  it('requires BOTH SUDO_NOTEBOOKLM=1 and SUDO_GDRIVE=1', () => {
    expect(isNotebookLmEnabled({})).toBe(false);
    expect(isNotebookLmEnabled({ SUDO_NOTEBOOKLM: '1' })).toBe(false);
    expect(isNotebookLmEnabled({ SUDO_NOTEBOOKLM: '1', SUDO_GDRIVE: '1' })).toBe(true);
  });
});

describe('hot-path isolation — no agent/llm/memory/brain imports core/notebooklm', () => {
  const HOT_DIRS = ['src/core/agent', 'src/llm', 'src/core/memory', 'src/core/brain'];
  function* walk(dir: string): Generator<string> {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) yield* walk(p);
      else if (/\.(ts|tsx|mts)$/.test(e)) yield p;
    }
  }
  it('no hot-path module imports from core/notebooklm', () => {
    const offenders: string[] = [];
    for (const dir of HOT_DIRS) {
      for (const f of walk(dir)) {
        const src = readFileSync(f, 'utf-8');
        if (/from\s+['"][^'"]*\/notebooklm\//.test(src) || /import\s*\(\s*['"][^'"]*\/notebooklm\//.test(src)) offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });
});
