/**
 * @file provenance.test.ts
 * @description TX28 — tap-to-verify provenance: live traces.db lookup, toast
 * rendering, callback round-trip, read-only + fail-soft.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import {
  provenanceCallbackData, parseProvenanceCallback, lookupProvenance, renderProvenanceToast,
} from '../../src/core/channels/provenance.js';

function makeTracesDb(dir: string): string {
  const p = join(dir, 'traces.db');
  const db = new Database(p);
  db.exec(`CREATE TABLE traces (
    id INTEGER PRIMARY KEY AUTOINCREMENT, trace_type TEXT NOT NULL, session_id TEXT,
    model TEXT, success INTEGER NOT NULL DEFAULT 1, latency_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.prepare("INSERT INTO traces (trace_type, session_id, model, success, latency_ms, created_at) VALUES ('brain_call','s1','ollama/glm-5.2:cloud',1,2300,'2026-07-30 10:00:00')").run();
  db.prepare("INSERT INTO traces (trace_type, session_id, model, success, latency_ms, created_at) VALUES ('brain_call','s1','google/gemini-2.5-flash',0,900,'2026-07-30 10:05:00')").run();
  db.close();
  return p;
}

describe('TX28 provenance', () => {
  it('PROV-1: callback data round-trips within 64 bytes', () => {
    const data = provenanceCallbackData('aI4-9ykOFrQJdh2QUqdKk');
    expect(data.length).toBeLessThanOrEqual(64);
    expect(parseProvenanceCallback(data)).toBe('aI4-9ykOFrQJdh2QUqdKk');
    expect(parseProvenanceCallback('tx10:cp:x:0')).toBeNull();
  });

  it('PROV-2: lookup returns the LATEST brain_call for the session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tx28-'));
    try {
      const row = lookupProvenance(makeTracesDb(dir), 's1')!;
      expect(row.model).toBe('google/gemini-2.5-flash');
      expect(row.success).toBe(false);
      expect(row.latencyMs).toBe(900);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('PROV-3: unknown session / missing db fail soft to null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tx28b-'));
    try {
      expect(lookupProvenance(makeTracesDb(dir), 'nope')).toBeNull();
      expect(lookupProvenance(join(dir, 'absent.db'), 's1')).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('PROV-4: toast renders compactly and caps at 200 chars', () => {
    expect(renderProvenanceToast({ model: 'ollama/glm-5.2:cloud', success: true, latencyMs: 2300, createdAt: '2026-07-30 10:00:00' }))
      .toBe('🔍 ollama/glm-5.2:cloud · ok · 2.3s · 10:00:00 UTC');
    expect(renderProvenanceToast(null)).toContain('No provenance');
    expect(renderProvenanceToast({ model: 'x'.repeat(300), success: true, latencyMs: null, createdAt: null }).length).toBeLessThanOrEqual(200);
  });
});
