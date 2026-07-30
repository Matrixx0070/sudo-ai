/**
 * @file memory-cards.test.ts
 * @description TX14/TX27 read-only cards: real temp sqlite fixtures, fail-soft
 * on missing dbs, and — the invariant-9 guard — the module exposes NO
 * mutation surface.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import * as cards from '../../src/core/channels/memory-cards.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tx1427-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function makeMindDb(): string {
  const p = join(dir, 'mind.db');
  const db = new Database(p);
  db.exec(`CREATE TABLE chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT, path TEXT DEFAULT '', source TEXT DEFAULT 'conversation', is_evergreen INTEGER DEFAULT 0, superseded_by INTEGER, created_at TEXT DEFAULT '2026-07-30T10:00:00Z')`);
  db.prepare("INSERT INTO chunks (text, path, source, is_evergreen) VALUES ('a','memory/a.md','conversation',1)").run();
  db.prepare("INSERT INTO chunks (text, path, source) VALUES ('b','memory/b.md','learning')").run();
  db.prepare("INSERT INTO chunks (text, path, source, superseded_by) VALUES ('c','memory/c.md','learning',1)").run();
  db.close();
  return p;
}

describe('TX14 /memory card', () => {
  it('MEM-1: renders totals, sources, retirement, recents', () => {
    const card = cards.buildMemoryCard(makeMindDb());
    expect(card).toContain('Chunks: **3** (1 evergreen · 1 retired by contradiction)');
    expect(card).toContain('learning: 1'); // superseded excluded from live by-source
    expect(card).toContain('memory/c.md');
    expect(card).toContain('never solo');
  });

  it('MEM-2: missing db renders honest unavailable', () => {
    expect(cards.buildMemoryCard(join(dir, 'absent.db'))).toContain('(unavailable');
  });
});

describe('TX27 /institution card', () => {
  it('INST-1: composes knowledge + decisions + activity; partial dbs degrade per-section', () => {
    const gw = join(dir, 'gateway.db');
    const g = new Database(gw);
    g.exec("CREATE TABLE policy_decisions (id INTEGER PRIMARY KEY, created_at TEXT DEFAULT '2026-07-30T09:00:00Z')");
    g.prepare('INSERT INTO policy_decisions DEFAULT VALUES').run();
    g.close();
    const card = cards.buildInstitutionCard({ mindDb: makeMindDb(), gatewayDb: gw, tracesDb: join(dir, 'absent.db') });
    expect(card).toContain('**2** live chunks');
    expect(card).toContain('Decisions logged: **1**');
    expect(card).toContain('Activity: (unavailable)');
  });
});

describe('invariant 9 guard', () => {
  it('INV9-1: the module exports ONLY read/render functions — no mutation surface', () => {
    expect(Object.keys(cards).sort()).toEqual(['buildInstitutionCard', 'buildMemoryCard']);
  });
});
