/**
 * @file gdrive/report.ts
 * @description F3 — the nightly self-report.
 *
 * Aggregates the day (audit rows, cron run outcomes, ingestion + held
 * quarantine items) into a fixed-section markdown report (<= 800 words) and
 * uploads it WITH CONVERSION as a Google Doc under ops/reports/daily/ —
 * a Doc deliberately, because Docs carry the comment channel F6 polls.
 */

import { createLogger } from '../shared/logger.js';
import type { DriveClient } from './client.js';
import type { FolderIdMap } from './types.js';

const log = createLogger('gdrive:report');

/** Duck-typed audit read surface (real impl: AuditTrail.query). */
export interface AuditQueryLike {
  query(filter: { since?: string; limit?: number }): Array<{
    actor: string;
    action: string;
    resource: string;
    outcome: string;
    timestamp: string;
    metadata?: Record<string, unknown> | null;
  }>;
}

export interface DailyReportInputs {
  date: string; // YYYY-MM-DD
  auditRows: Array<{ actor: string; action: string; outcome: string; metadata?: Record<string, unknown> | null }>;
  heldQuarantine: string[]; // file names awaiting HUMAN review
  openQuestions?: string[];
  tomorrowPlan?: string[];
}

const MAX_WORDS = 800;

function wordCap(text: string): string {
  const words = text.split(/\s+/);
  return words.length <= MAX_WORDS ? text : `${words.slice(0, MAX_WORDS).join(' ')}\n\n[...capped at ${MAX_WORDS} words]`;
}

/** Pure renderer — fixed section order per spec. */
export function buildDailyReport(inputs: DailyReportInputs): string {
  const byAction = new Map<string, { total: number; failed: number }>();
  for (const row of inputs.auditRows) {
    const s = byAction.get(row.action) ?? { total: 0, failed: 0 };
    s.total++;
    if (row.outcome !== 'success') s.failed++;
    byAction.set(row.action, s);
  }
  const failures = inputs.auditRows.filter((r) => r.outcome === 'error' || r.outcome === 'failure');
  const denials = inputs.auditRows.filter((r) => r.outcome === 'denied');

  const lines: string[] = [
    `# Daily Self-Report — ${inputs.date}`,
    '',
    '## What I did',
    ...(byAction.size
      ? [...byAction.entries()].map(([a, s]) => `- ${a}: ${s.total} run(s)${s.failed ? `, ${s.failed} failed` : ''}`)
      : ['- (no recorded activity)']),
    '',
    '## What failed',
    ...(failures.length
      ? failures.slice(0, 15).map((f) => `- ${f.action}: ${String(f.metadata?.['error'] ?? f.metadata?.['reason'] ?? 'see audit log').slice(0, 160)}`)
      : ['- nothing failed']),
    '',
    '## What I learned / refused',
    ...(denials.length
      ? denials.slice(0, 10).map((d) => `- REFUSED ${d.action}: ${String(d.metadata?.['reason'] ?? d.metadata?.['detail'] ?? '').slice(0, 160)}`)
      : ['- no refusals']),
    '',
    '## Open questions (needs Frank)',
    ...(inputs.heldQuarantine.length
      ? inputs.heldQuarantine.map((n) => `- HELD in quarantine: **${n}** — review the report beside it`)
      : ['- nothing held']),
    ...(inputs.openQuestions ?? []).map((q) => `- ${q}`),
    '',
    '## Tomorrow',
    ...((inputs.tomorrowPlan?.length ? inputs.tomorrowPlan : ['- continue scheduled jobs (checkpoint, inbox, drill)']).map(
      (p) => (p.startsWith('-') ? p : `- ${p}`),
    )),
    '',
    '*Comment on any line — corrections are read within one poll cycle (F6).*',
  ];
  return wordCap(lines.join('\n'));
}

/** Collect held-quarantine names from the quarantine folder listing. */
export async function listHeldQuarantine(client: DriveClient, folders: FolderIdMap): Promise<string[]> {
  const q = folders['knowledge/quarantine'];
  if (!q) return [];
  const children = await client.listChildren(q);
  return children.filter((f) => f.name.endsWith('.HELD.report.json')).map((f) => f.name.replace(/\.HELD\.report\.json$/, ''));
}

export interface DailyReportResult {
  fileId: string;
  name: string;
}

/** Render + upload the report as a comment-able Google Doc. */
export async function publishDailyReport(
  client: DriveClient,
  folders: FolderIdMap,
  inputs: DailyReportInputs,
): Promise<DailyReportResult> {
  const reportsFolder = folders['ops/reports'];
  if (!reportsFolder) throw new Error('gdrive report: ops/reports folder id missing');
  const markdown = buildDailyReport(inputs);
  const name = `daily-${inputs.date}`;
  // One Doc per day: update in place when today's already exists (re-runs).
  const existing = (await client.listChildren(reportsFolder)).find((f) => f.name === name);
  if (existing) {
    await client.filesUpdateGoogleDoc(existing.id, markdown);
    log.info({ name, fileId: existing.id }, 'daily report updated');
    return { fileId: existing.id, name };
  }
  const created = await client.filesCreateAsGoogleDoc(name, reportsFolder, markdown);
  log.info({ name, fileId: created.id }, 'daily report published');
  return { fileId: created.id, name };
}
