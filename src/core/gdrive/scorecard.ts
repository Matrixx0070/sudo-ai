/**
 * @file gdrive/scorecard.ts
 * @description F4 — eval scorecard + telemetry ledger (one Google Sheet).
 *
 * Tabs: Evals (row per eval run), Telemetry (daily row incl. the
 * sync-observability rider), Skills (F8, seeded now), Forks (F25, seeded
 * now), Derived (formulas seeded ONCE — trends compute Sheet-side, zero
 * tokens). Writers use values.append exclusively; the Sheet is never read
 * back into model context except as guarded data.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataPath } from '../shared/paths.js';
import { createLogger } from '../shared/logger.js';
import type { DriveClient } from './client.js';
import type { FolderIdMap } from './types.js';

const log = createLogger('gdrive:scorecard');

export const SCORECARD_NAME = 'scorecard';
const TABS = ['Evals', 'Telemetry', 'Skills', 'Forks', 'Derived'] as const;

const EVALS_HEADER = ['runId', 'suite', 'score', 'pass', 'modelRoute', 'commit', 'brainCounter', 'timestamp'];
const TELEMETRY_HEADER = [
  'date', 'tokensIn', 'tokensOut', 'estCostUsd', 'cacheHitRate', 'toolCalls', 'errorCount',
  'syncLagS', 'divergenceCount', 'queueDepthInteractive', 'queueDepthBackground',
];
// Seeded once; Sheet-side trend math (rolling means + deltas), zero tokens.
const DERIVED_ROWS: string[][] = [
  ['metric', 'value'],
  ['eval pass rate (last 30)', '=IFERROR(AVERAGE(ARRAYFORMULA(IF(OFFSET(Evals!D2,MAX(0,COUNTA(Evals!D2:D)-30),0,MIN(30,COUNTA(Evals!D2:D)),1)=TRUE,1,0))),"n/a")'],
  ['avg score (last 30)', '=IFERROR(AVERAGE(OFFSET(Evals!C2,MAX(0,COUNTA(Evals!C2:C)-30),0,MIN(30,COUNTA(Evals!C2:C)),1)),"n/a")'],
  ['cache hit 7d mean', '=IFERROR(AVERAGE(OFFSET(Telemetry!E2,MAX(0,COUNTA(Telemetry!E2:E)-7),0,MIN(7,COUNTA(Telemetry!E2:E)),1)),"n/a")'],
  ['cache hit 30d mean', '=IFERROR(AVERAGE(OFFSET(Telemetry!E2,MAX(0,COUNTA(Telemetry!E2:E)-30),0,MIN(30,COUNTA(Telemetry!E2:E)),1)),"n/a")'],
  ['errors 7d sum', '=IFERROR(SUM(OFFSET(Telemetry!G2,MAX(0,COUNTA(Telemetry!G2:G)-7),0,MIN(7,COUNTA(Telemetry!G2:G)),1)),"n/a")'],
  ['sync queue now', '=IFERROR(INDEX(Telemetry!J2:J,COUNTA(Telemetry!J2:J))+INDEX(Telemetry!K2:K,COUNTA(Telemetry!K2:K)),"n/a")'],
];

function scorecardIdCachePath(): string {
  return dataPath('gdrive', 'scorecard-id.json');
}

export function loadScorecardId(): string | null {
  try {
    return (JSON.parse(readFileSync(scorecardIdCachePath(), 'utf-8')) as { id?: string }).id ?? null;
  } catch {
    return null;
  }
}

function saveScorecardId(id: string): void {
  const p = scorecardIdCachePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ id }), { mode: 0o600 });
}

/** Idempotent: find-or-create the Sheet, ensure tabs + headers + Derived. */
export async function ensureScorecard(client: DriveClient, folders: FolderIdMap): Promise<string> {
  const cached = loadScorecardId();
  if (cached) return cached;

  const opsId = folders['ops'];
  if (!opsId) throw new Error('gdrive scorecard: ops folder id missing');
  let id: string;
  const existing = (await client.listChildren(opsId)).find((f) => f.name === SCORECARD_NAME);
  if (existing) {
    id = existing.id;
  } else {
    const created = await client.sheetsCreateSpreadsheet(SCORECARD_NAME, opsId);
    id = created.id;
  }

  const meta = await client.sheetsGetMeta(id);
  const have = new Set(meta.sheets.map((s) => s.title));
  const addRequests = TABS.filter((t) => !have.has(t)).map((t) => ({ addSheet: { properties: { title: t } } }));
  if (addRequests.length) await client.sheetsBatchUpdate(id, addRequests);

  if (!have.has('Evals')) await client.sheetsValuesAppend(id, 'Evals!A1', [EVALS_HEADER]);
  if (!have.has('Telemetry')) await client.sheetsValuesAppend(id, 'Telemetry!A1', [TELEMETRY_HEADER]);
  if (!have.has('Skills')) await client.sheetsValuesAppend(id, 'Skills!A1', [['candidate', 'suite', 'score', 'pass', 'approved', 'promotedAt']]);
  if (!have.has('Forks')) await client.sheetsValuesAppend(id, 'Forks!A1', [['fork', 'window', 'suite', 'score', 'timestamp']]);
  if (!have.has('Derived')) await client.sheetsValuesUpdate(id, 'Derived!A1', DERIVED_ROWS);

  saveScorecardId(id);
  log.info({ id, created: !existing }, 'scorecard ensured');
  return id;
}

export interface EvalRow {
  runId: string;
  suite: string;
  score: number;
  pass: boolean;
  modelRoute?: string;
  commit?: string;
  brainCounter?: number;
  timestamp: string;
}

export async function appendEvalRow(client: DriveClient, spreadsheetId: string, row: EvalRow): Promise<void> {
  await client.sheetsValuesAppend(spreadsheetId, 'Evals!A1', [[
    row.runId, row.suite, row.score, row.pass, row.modelRoute ?? '', row.commit ?? '',
    row.brainCounter ?? '', row.timestamp,
  ]]);
}

export interface TelemetryRow {
  date: string;
  tokensIn: number;
  tokensOut: number;
  estCostUsd: number;
  cacheHitRate: number;
  toolCalls: number;
  errorCount: number;
  /** Sync-observability rider. */
  syncLagS: number;
  divergenceCount: number;
  queueDepthInteractive: number;
  queueDepthBackground: number;
}

export async function appendTelemetryRow(
  client: DriveClient,
  spreadsheetId: string,
  row: TelemetryRow,
): Promise<void> {
  await client.sheetsValuesAppend(spreadsheetId, 'Telemetry!A1', [[
    row.date, row.tokensIn, row.tokensOut, row.estCostUsd, row.cacheHitRate, row.toolCalls,
    row.errorCount, row.syncLagS, row.divergenceCount, row.queueDepthInteractive, row.queueDepthBackground,
  ]]);
}

/** Test/ops probe. */
export function hasScorecardIdCache(): boolean {
  return existsSync(scorecardIdCachePath());
}
