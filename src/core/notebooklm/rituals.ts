/**
 * @file notebooklm/rituals.ts
 * @description E3 ritual manifest. Each ritual = a one-click/one-listen human
 * step, tiered by adoption risk: Tier-1 core MUST total ≤20 min/week (computed
 * + displayed); Tier-2 monthly; Tier-3 quarterly. Generates
 * docs/notebooklm-rituals.md, a lazily-created Rituals scorecard tab
 * (id|tier|cadence|minutes|lastDone|due — the readApprovals lazy-tab pattern,
 * so gdrive's fixed TABS are untouched), and a rituals-status.json the F34
 * digest reads for overdue alerts. Completion is Frank ticking the row —
 * self-attested, and the manifest says so plainly.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataPath } from '../shared/paths.js';
import { createLogger } from '../shared/logger.js';
import type { DriveClient } from '../gdrive/client.js';
import type { NlmFolderMap } from './folders.js';

const log = createLogger('notebooklm:rituals');

export type RitualTier = 1 | 2 | 3;

export interface RitualSpec {
  id: string;
  featureIds: string[];
  tier: RitualTier;
  /** Human cadence label (daily/weekly/monthly/quarterly/per-event). */
  cadence: string;
  /** Exact click path. */
  clickPath: string;
  /** What to paste back + filename (or "none"). */
  pasteBack: string;
  /** Time cost in minutes (≤5 by design). */
  minutes: number;
  /** What degrades if this Tier-2/3 ritual is skipped. */
  degradesTo?: string;
}

const REGISTRY = new Map<string, RitualSpec>();
export function registerRitual(r: RitualSpec): void {
  if (r.minutes > 5) throw new Error(`ritual ${r.id}: ${r.minutes}min exceeds the 5-min design cap`);
  REGISTRY.set(r.id, r);
}
export function allRituals(): RitualSpec[] {
  return [...REGISTRY.values()];
}

// N0 seed — F39 daily radio (Tier-1). N1+ register the rest as they land.
registerRitual({
  id: 'brain-radio',
  featureIds: ['F39'],
  tier: 1,
  cadence: 'daily',
  clickPath: 'Open the "SUDO-AI Daily" notebook → refresh sources → generate Audio Overview → listen (skim)',
  pasteBack: 'none (optional reactions → F39.reaction.<date>.md in returns/)',
  // 2 min/day = 14/week: a daily ritual must stay ≤2 min or the ≤20 min/week
  // Tier-1 budget can't also fit the weekly quiz (F46/F49) + per-event approvals.
  minutes: 2,
});

/** Weekly Tier-1 minutes: sum daily×7 + weekly×1 (Tier-1 only). */
export function tier1WeeklyMinutes(rituals: RitualSpec[] = allRituals()): number {
  let total = 0;
  for (const r of rituals) {
    if (r.tier !== 1) continue;
    const perWeek = /daily/i.test(r.cadence) ? 7 : /weekly/i.test(r.cadence) ? 1 : 1;
    total += r.minutes * perWeek;
  }
  return total;
}

export const TIER1_WEEKLY_BUDGET_MIN = 20;

// ---------------------------------------------------------------------------
// Manifest generation
// ---------------------------------------------------------------------------

export function buildRitualManifest(rituals: RitualSpec[] = allRituals()): string {
  const t1 = tier1WeeklyMinutes(rituals);
  const lines: string[] = [
    '# NotebookLM Rituals',
    '',
    '> Each ritual is a one-click / one-listen human step, ≤5 min by design.',
    '> **Completion is self-attested** — you tick the Rituals scorecard row; the harness cannot verify you actually listened, only that the artifact/attestation exists.',
    '',
    `**Tier-1 (core) weekly budget: ${t1} / ${TIER1_WEEKLY_BUDGET_MIN} min** ${t1 <= TIER1_WEEKLY_BUDGET_MIN ? '✓ within budget' : '⚠️ OVER BUDGET — trim Tier-1'}`,
    '',
  ];
  for (const tier of [1, 2, 3] as RitualTier[]) {
    const group = rituals.filter((r) => r.tier === tier);
    if (!group.length) continue;
    lines.push(`## Tier ${tier} ${tier === 1 ? '(core, ≤20 min/week)' : tier === 2 ? '(monthly)' : '(quarterly)'}`, '');
    for (const r of group) {
      lines.push(
        `### ${r.id} — ${r.featureIds.join(', ')} (${r.cadence}, ~${r.minutes} min)`,
        `- **Do:** ${r.clickPath}`,
        `- **Paste back:** ${r.pasteBack}`,
        ...(r.degradesTo ? [`- **If skipped:** ${r.degradesTo}`] : []),
        '',
      );
    }
  }
  return lines.join('\n');
}

/** Assert the Tier-1 budget invariant (throws — used in the N0 gate test). */
export function assertTier1Budget(rituals: RitualSpec[] = allRituals()): void {
  const t1 = tier1WeeklyMinutes(rituals);
  if (t1 > TIER1_WEEKLY_BUDGET_MIN) {
    throw new Error(`Tier-1 rituals total ${t1} min/week > ${TIER1_WEEKLY_BUDGET_MIN} budget`);
  }
}

// ---------------------------------------------------------------------------
// Rituals scorecard tab (lazy-created, readApprovals pattern)
// ---------------------------------------------------------------------------

const RITUALS_HEADER = ['ritual', 'tier', 'cadence', 'minutes', 'lastDone (you tick)', 'featureIds'];

export async function ensureRitualsTab(
  client: DriveClient,
  scorecardId: string,
  rituals: RitualSpec[] = allRituals(),
): Promise<void> {
  const meta = await client.sheetsGetMeta(scorecardId);
  if (!meta.sheets.some((s) => s.title === 'Rituals')) {
    await client.sheetsBatchUpdate(scorecardId, [{ addSheet: { properties: { title: 'Rituals' } } }]);
  }
  // Rewrite the tab from the registry (id list is small + authoritative).
  const rows: unknown[][] = [
    RITUALS_HEADER,
    ...rituals.map((r) => [r.id, r.tier, r.cadence, r.minutes, '', r.featureIds.join(',')]),
  ];
  await client.sheetsValuesUpdate(scorecardId, 'Rituals!A1', rows);
}

// ---------------------------------------------------------------------------
// Overdue-status file for the F34 digest
// ---------------------------------------------------------------------------

export interface RitualStatus {
  generatedAt: string;
  tier1WeeklyMinutes: number;
  budget: number;
  rituals: Array<{ id: string; tier: RitualTier; cadence: string; minutes: number }>;
}

export function ritualStatusPath(): string {
  return dataPath('notebooklm', 'rituals-status.json');
}

/** Write local status + mirror a Doc into notebooklm/rituals/ for the digest. */
export async function writeRitualStatus(
  client: DriveClient,
  folders: NlmFolderMap,
  rituals: RitualSpec[] = allRituals(),
): Promise<void> {
  const status: RitualStatus = {
    generatedAt: new Date().toISOString(),
    tier1WeeklyMinutes: tier1WeeklyMinutes(rituals),
    budget: TIER1_WEEKLY_BUDGET_MIN,
    rituals: rituals.map((r) => ({ id: r.id, tier: r.tier, cadence: r.cadence, minutes: r.minutes })),
  };
  const p = ritualStatusPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(status, null, 2), { mode: 0o600 });

  const ritualsFolder = folders['notebooklm/rituals'];
  if (ritualsFolder) {
    const body = buildRitualManifest(rituals);
    const existing = (await client.listChildren(ritualsFolder)).find((f) => f.name === 'ritual-manifest');
    if (existing) await client.filesUpdateGoogleDoc(existing.id, body);
    else await client.filesCreateAsGoogleDoc('ritual-manifest', ritualsFolder, body);
  }
  log.info({ tier1: status.tier1WeeklyMinutes }, 'ritual status written');
}
