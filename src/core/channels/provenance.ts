/**
 * @file provenance.ts
 * @description TX28 v1 — tap-to-verify provenance. A 🔍 button on the reply
 * keyboard (SUDO_TG_PROVENANCE=1, default OFF) answers "which model produced
 * this?" as a callback TOAST — zero chat clutter, no extra messages. The tap
 * resolves LIVE from traces.db (the session's most recent brain_call row):
 * model, success, latency, age. Read-only; pairs with the verifiability
 * ladder (ADR 0002) — the rung field slots in once grading ships.
 */

import DatabaseCtor from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';

const log = createLogger('channels:tx28');

export const PROVENANCE_CALLBACK_PREFIX = 'tx28:p:';

export function provenanceEnabled(): boolean {
  return process.env['SUDO_TG_PROVENANCE'] === '1';
}

export function provenanceCallbackData(sessionId: string): string {
  // Session ids are ~21 chars; prefix+id stays under Telegram's 64-byte cap.
  return `${PROVENANCE_CALLBACK_PREFIX}${sessionId}`.slice(0, 64);
}

export function parseProvenanceCallback(data: string): string | null {
  return data.startsWith(PROVENANCE_CALLBACK_PREFIX) ? data.slice(PROVENANCE_CALLBACK_PREFIX.length) : null;
}

export interface ProvenanceRow {
  model: string | null;
  success: boolean;
  latencyMs: number | null;
  createdAt: string | null;
}

/** Latest brain_call for a session from traces.db. Read-only; null when absent. */
export function lookupProvenance(tracesDbPath: string, sessionId: string): ProvenanceRow | null {
  try {
    const db = new DatabaseCtor(tracesDbPath, { readonly: true, fileMustExist: true });
    try {
      const r = db.prepare(
        "SELECT model, success, latency_ms, created_at FROM traces WHERE session_id = ? AND trace_type = 'brain_call' ORDER BY id DESC LIMIT 1",
      ).get(sessionId) as { model?: string; success?: number; latency_ms?: number; created_at?: string } | undefined;
      if (!r) return null;
      return {
        model: r.model ?? null,
        success: r.success === 1,
        latencyMs: r.latency_ms ?? null,
        createdAt: r.created_at ?? null,
      };
    } finally { db.close(); }
  } catch (err) {
    log.debug({ err: String(err) }, 'TX28 provenance lookup failed');
    return null;
  }
}

/** Render the toast text (Telegram caps callback answers at 200 chars). Pure. */
export function renderProvenanceToast(row: ProvenanceRow | null): string {
  if (!row) return 'No provenance recorded for this session yet.';
  const parts = [
    `🔍 ${row.model ?? 'unknown model'}`,
    row.success ? 'ok' : 'failed',
  ];
  if (row.latencyMs != null) parts.push(`${(row.latencyMs / 1000).toFixed(1)}s`);
  if (row.createdAt) parts.push(row.createdAt.slice(11, 19) + ' UTC');
  return parts.join(' · ').slice(0, 195);
}
