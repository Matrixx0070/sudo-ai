/**
 * @file memory-cards.ts
 * @description TX14 v1 (/memory) + TX27 v1 (/institution) — READ-ONLY owner
 * cards over the knowledge stores. No mutation surface at all: tap-to-correct
 * /forget (TX14 v2) is deliberately absent until it ships WITH the two-reader
 * consensus rules (CLAUDE.md invariant 9 — surgery is never solo). All reads
 * fail soft to em-dashes; a missing db renders an honest "(unavailable)".
 */

import DatabaseCtor from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';

const log = createLogger('channels:memory-cards');

function withDb<T>(path: string, fn: (db: import('better-sqlite3').Database) => T): T | null {
  try {
    const db = new DatabaseCtor(path, { readonly: true, fileMustExist: true });
    try { return fn(db); } finally { db.close(); }
  } catch (err) {
    log.debug({ path, err: String(err) }, 'memory-card read failed (rendering unavailable)');
    return null;
  }
}

/** TX14 — what's in working memory right now. Read-only. */
export function buildMemoryCard(mindDbPath: string): string {
  const stats = withDb(mindDbPath, (db) => ({
    total: (db.prepare('SELECT COUNT(*) c FROM chunks').get() as { c: number }).c,
    bySource: db.prepare('SELECT source, COUNT(*) c FROM chunks WHERE superseded_by IS NULL GROUP BY source ORDER BY c DESC LIMIT 6').all() as Array<{ source: string; c: number }>,
    evergreen: (db.prepare('SELECT COUNT(*) c FROM chunks WHERE is_evergreen=1').get() as { c: number }).c,
    superseded: (db.prepare('SELECT COUNT(*) c FROM chunks WHERE superseded_by IS NOT NULL').get() as { c: number }).c,
    recent: db.prepare("SELECT path, created_at FROM chunks ORDER BY id DESC LIMIT 5").all() as Array<{ path: string; created_at: string }>,
  }));
  if (!stats) return '🧠 **Memory**\n\n(unavailable — mind.db not readable)';
  const lines = [
    '🧠 **Memory** (read-only)',
    '',
    `Chunks: **${stats.total}** (${stats.evergreen} evergreen · ${stats.superseded} retired by contradiction)`,
    ...stats.bySource.map((s) => `  • ${s.source}: ${s.c}`),
    '',
    'Recent:',
    ...stats.recent.map((r) => `  · ${r.path || '(unpathed)'} — ${r.created_at.slice(0, 16).replace('T', ' ')}`),
    '',
    '_Corrections/forget ship with two-reader consensus (v2) — never solo._',
  ];
  return lines.join('\n');
}

/** TX27 — what the institution knows: knowledge, decisions, activity. Read-only. */
export function buildInstitutionCard(paths: { mindDb: string; gatewayDb: string; tracesDb: string }): string {
  const knowledge = withDb(paths.mindDb, (db) => ({
    chunks: (db.prepare('SELECT COUNT(*) c FROM chunks WHERE superseded_by IS NULL').get() as { c: number }).c,
    evergreen: (db.prepare('SELECT COUNT(*) c FROM chunks WHERE is_evergreen=1').get() as { c: number }).c,
    learned: (db.prepare("SELECT COUNT(*) c FROM chunks WHERE source='learning'").get() as { c: number }).c,
  }));
  const decisions = withDb(paths.gatewayDb, (db) => ({
    count: (db.prepare('SELECT COUNT(*) c FROM policy_decisions').get() as { c: number }).c,
    last: (db.prepare('SELECT MAX(created_at) m FROM policy_decisions').get() as { m: string | null }).m,
  }));
  const activity = withDb(paths.tracesDb, (db) => ({
    brainCalls: (db.prepare("SELECT COUNT(*) c FROM traces WHERE trace_type='brain_call'").get() as { c: number }).c,
    toolCalls: (db.prepare("SELECT COUNT(*) c FROM traces WHERE trace_type!='brain_call'").get() as { c: number }).c,
  }));
  const lines = [
    '🏛 **Institutional memory** (read-only)',
    '',
    knowledge
      ? `Knowledge: **${knowledge.chunks}** live chunks · ${knowledge.evergreen} doctrine (evergreen) · ${knowledge.learned} learned`
      : 'Knowledge: (unavailable)',
    decisions
      ? `Decisions logged: **${decisions.count}**${decisions.last ? ` (last ${decisions.last.slice(0, 16).replace('T', ' ')})` : ''}`
      : 'Decisions: (unavailable)',
    activity
      ? `Recorded activity: ${activity.brainCalls} brain calls · ${activity.toolCalls} tool traces`
      : 'Activity: (unavailable)',
    '',
    '_Sources: mind.db · gateway.db policy_decisions · traces.db. Nothing here mutates._',
  ];
  return lines.join('\n');
}
