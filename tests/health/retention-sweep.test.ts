/**
 * F113/F114 — retention sweep.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { runRetentionSweep } from '../../src/core/health/retention-sweep.js';

let dir: string;
const OLD = new Date(Date.now() - 200 * 86_400_000).toISOString();
const NEW = new Date().toISOString();

beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'f113-')); });
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env['SUDO_RETENTION_SWEEP'];
});

function makeConsciousnessDb(): string {
  const p = path.join(dir, 'consciousness.db');
  const db = new Database(p);
  db.exec(`
    CREATE TABLE body_state_log (id INTEGER PRIMARY KEY, sampled_at TEXT);
    CREATE TABLE emotional_state_log (id INTEGER PRIMARY KEY, created_at TEXT);
    CREATE TABLE thoughts (id INTEGER PRIMARY KEY, created_at TEXT);
    CREATE TABLE surprise_events (id INTEGER PRIMARY KEY, created_at TEXT);
    CREATE TABLE user_interaction_log (id INTEGER PRIMARY KEY, created_at TEXT);
    CREATE TABLE episodes (id TEXT PRIMARY KEY, started_at TEXT, significance REAL);
    CREATE TABLE concept_edges (id INTEGER PRIMARY KEY);
  `);
  db.prepare('INSERT INTO body_state_log (sampled_at) VALUES (?), (?)').run(OLD, NEW);
  db.prepare('INSERT INTO thoughts (created_at) VALUES (?), (?)').run(OLD, NEW);
  db.prepare("INSERT INTO episodes VALUES ('old-insig', ?, 0.2), ('old-SIG', ?, 0.95), ('new', ?, 0.1)").run(OLD, OLD, NEW);
  db.close();
  return p;
}

function makeMindDb(): string {
  const p = path.join(dir, 'mind.db');
  const db = new Database(p);
  db.exec(`
    CREATE TABLE embedding_cache (hash TEXT PRIMARY KEY, created_at TEXT);
    CREATE TABLE cron_runs (id INTEGER PRIMARY KEY, ran_at TEXT);
    CREATE TABLE task_queue (id TEXT PRIMARY KEY, status TEXT, created_at TEXT, completed_at TEXT);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, status TEXT, finished_at TEXT, updated_at TEXT);
  `);
  db.prepare("INSERT INTO embedding_cache VALUES ('old', ?), ('new', ?)").run(OLD, NEW);
  db.prepare('INSERT INTO cron_runs (ran_at) VALUES (?), (?)').run(OLD, NEW);
  db.prepare(`INSERT INTO task_queue VALUES
    ('old-cancelled', 'cancelled', ?, NULL),
    ('old-created-fresh-done', 'completed', ?, ?),
    ('old-queued', 'queued', ?, NULL),
    ('new-completed', 'completed', ?, ?)`).run(OLD, OLD, NEW, OLD, NEW, NEW);
  db.prepare("INSERT INTO tasks (status, finished_at, updated_at) VALUES ('done', ?, ?), ('running', ?, ?)").run(OLD, OLD, OLD, OLD);
  db.close();
  return p;
}

describe('runRetentionSweep — mind.db caches + terminal tasks', () => {
  it('prunes old cache/run-history rows and ONLY terminal, truly-old tasks', () => {
    makeMindDb();
    const report = runRetentionSweep(dir);
    expect(report.tablesPruned['mind.db:embedding_cache']).toBe(1);
    expect(report.tablesPruned['mind.db:cron_runs']).toBe(1);
    expect(report.tablesPruned['mind.db:task_queue']).toBe(1); // only old-cancelled
    expect(report.tablesPruned['mind.db:tasks']).toBe(1);      // only the done one
    const db = new Database(path.join(dir, 'mind.db'), { readonly: true });
    const tq = db.prepare('SELECT id FROM task_queue ORDER BY id').all().map((r) => (r as { id: string }).id);
    const taskStatuses = db.prepare('SELECT status FROM tasks').all().map((r) => (r as { status: string }).status);
    db.close();
    // Old-but-recently-completed kept (COALESCE uses completed_at); active tasks
    // are NEVER pruned regardless of age.
    expect(tq).toEqual(['new-completed', 'old-created-fresh-done', 'old-queued']);
    expect(taskStatuses).toEqual(['running']);
  });
});

describe('runRetentionSweep (F113/F114)', () => {
  it('prunes old rows but keeps recent + significant episodes', () => {
    makeConsciousnessDb();
    const report = runRetentionSweep(dir);
    expect(report.tablesPruned['consciousness.db:body_state_log']).toBe(1);
    expect(report.tablesPruned['consciousness.db:thoughts']).toBe(1);
    expect(report.tablesPruned['consciousness.db:episodes']).toBe(1); // only old-insig
    const db = new Database(path.join(dir, 'consciousness.db'), { readonly: true });
    const ids = db.prepare('SELECT id FROM episodes ORDER BY id').all().map((r: { id?: unknown }) => (r as { id: string }).id);
    db.close();
    expect(ids).toEqual(['new', 'old-SIG']);
  });

  it('rotates oversize files and caps dirs', () => {
    writeFileSync(path.join(dir, 'kairos.log'), 'x'.repeat(9 * 1024 * 1024));
    const wfDir = path.join(dir, 'workflow-runs');
    mkdirSync(wfDir);
    for (let i = 0; i < 510; i++) writeFileSync(path.join(wfDir, `run-${i}.json`), '{}');
    const report = runRetentionSweep(dir);
    expect(report.filesRotated).toContain('kairos.log');
    expect(existsSync(path.join(dir, 'kairos.log.1'))).toBe(true);
    expect(report.dirFilesDeleted['workflow-runs']).toBe(10);
  });

  it('checkpoints WALs (F114)', () => {
    const p = path.join(dir, 'gateway.db');
    const db = new Database(p);
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE t (x)');
    for (let i = 0; i < 200; i++) db.prepare('INSERT INTO t VALUES (?)').run(i);
    db.close();
    const report = runRetentionSweep(dir);
    expect(report.walCheckpointed).toContain('gateway.db');
    const wal = path.join(dir, 'gateway.db-wal');
    if (existsSync(wal)) expect(statSync(wal).size).toBe(0);
  });

  it('kill-switch skips everything', () => {
    makeConsciousnessDb();
    process.env['SUDO_RETENTION_SWEEP'] = '0';
    const report = runRetentionSweep(dir);
    expect(report.skipped).toBe(true);
    expect(Object.keys(report.tablesPruned)).toHaveLength(0);
  });

  it('missing files/dirs are silently fine', () => {
    const report = runRetentionSweep(dir);
    expect(report.skipped).toBe(false);
    expect(report.walCheckpointed).toEqual([]);
  });
});
