/**
 * Tests for the billing CostTracker — focus on the prompt-cache discount
 * reaching the cost-reporter dashboard.
 *
 * The dashboard sums `estimated_cost_usd` from api_call_log. For that number to
 * reflect Anthropic prompt caching (reads ~0.1x, writes ~1.25x), the billing
 * layer must (a) compute cost via the canonical cache-aware rate model, and
 * (b) persist the cache split so it can be derived even when no cost is supplied.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CostTracker, estimateCost } from '../../src/core/billing/cost-tracker.js';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cost-tracker-'));
  dbPath = join(dir, 'mind.db');
});

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('billing estimateCost — now cache-aware (delegates to brain/costs)', () => {
  it('discounts cache-read tokens instead of billing them at the full input rate', () => {
    // 27k total input, 25.7k of it cache-read — the consciousness-tick shape.
    const full = estimateCost('claude-oauth/claude-opus-4-8', 27028, 115);
    const cached = estimateCost('claude-oauth/claude-opus-4-8', 27028, 115, 25749, 0);
    expect(cached).toBeLessThan(full / 4);
    expect(cached).toBeGreaterThan(0.01);
    expect(cached).toBeLessThan(0.04);
  });

  it('prices Anthropic Opus 4.8 (previously absent → billed $0 via the stale table)', () => {
    // Pure-output call: Opus 4.8 output is $25/M.
    expect(estimateCost('anthropic/claude-opus-4-8', 0, 1_000_000)).toBeCloseTo(25, 5);
  });
});

describe('CostTracker.record — cache split feeds the dashboard cost', () => {
  it('derives a cache-discounted cost when none is supplied, and round-trips the split', () => {
    const tracker = new CostTracker(dbPath);
    tracker.record({
      provider: 'anthropic',
      model: 'claude-oauth/claude-opus-4-8',
      promptTokens: 27028,        // total incl. cached
      completionTokens: 115,
      totalTokens: 27143,
      latencyMs: 1200,
      success: true,
      source: 'consciousness',
      cacheReadTokens: 25749,
      cacheCreationTokens: 0,
      // estimatedCostUsd omitted → tracker computes it cache-aware
    });

    const [row] = tracker.getRecentCalls(1);
    expect(row.cacheReadTokens).toBe(25749);
    expect(row.cacheCreationTokens).toBe(0);
    // ~$0.02/tick, not the ~$0.137 a full-rate bill would produce.
    expect(row.estimatedCostUsd).toBeGreaterThan(0.01);
    expect(row.estimatedCostUsd).toBeLessThan(0.04);

    const byModel = tracker.getCostByModel();
    expect(byModel[0].totalCost).toBeLessThan(0.04);
  });

  it('trusts an explicitly supplied (already cache-aware) cost', () => {
    const tracker = new CostTracker(dbPath);
    tracker.record({
      provider: 'anthropic', model: 'claude-oauth/claude-opus-4-8',
      promptTokens: 27028, completionTokens: 115, totalTokens: 27143,
      estimatedCostUsd: 0.0216745, latencyMs: 1000, success: true, source: 'consciousness',
      cacheReadTokens: 25749, cacheCreationTokens: 0,
    });
    expect(tracker.getRecentCalls(1)[0].estimatedCostUsd).toBeCloseTo(0.0216745, 6);
  });
});

describe('CostTracker — additive migration on a pre-existing table', () => {
  it('adds the cache columns to an api_call_log created before they existed', () => {
    // Simulate the legacy schema (no cache columns).
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE api_call_log (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost_usd REAL NOT NULL DEFAULT 0,
        latency_ms INTEGER NOT NULL DEFAULT 0, success INTEGER NOT NULL DEFAULT 1,
        error TEXT, source TEXT NOT NULL DEFAULT 'chat', called_at TEXT NOT NULL
      )`);
    legacy.close();

    // Opening via CostTracker must migrate (ALTER TABLE ADD COLUMN) without throwing.
    const tracker = new CostTracker(dbPath);
    expect(() => tracker.record({
      provider: 'anthropic', model: 'claude-oauth/claude-opus-4-8',
      promptTokens: 1000, completionTokens: 50, totalTokens: 1050,
      latencyMs: 100, success: true, source: 'chat',
      cacheReadTokens: 800, cacheCreationTokens: 0,
    })).not.toThrow();
    expect(tracker.getRecentCalls(1)[0].cacheReadTokens).toBe(800);
  });
});

describe('CostTracker — retention policy', () => {
  const RET = 'SUDO_COST_RETENTION_DAYS';
  let savedRet: string | undefined;

  beforeEach(() => { savedRet = process.env[RET]; delete process.env[RET]; });
  afterEach(() => {
    if (savedRet === undefined) delete process.env[RET]; else process.env[RET] = savedRet;
  });

  /** Insert a row at an explicit called_at via a raw handle (record() can't backdate). */
  function insertAt(path: string, calledAt: string): void {
    const raw = new Database(path);
    raw.prepare(`
      INSERT INTO api_call_log
        (id, provider, model, prompt_tokens, completion_tokens, total_tokens,
         estimated_cost_usd, latency_ms, success, source,
         cache_read_tokens, cache_creation_tokens, called_at)
      VALUES (:id,'anthropic','m',0,0,0,0.01,0,1,'chat',0,0,:called_at)
    `).run({ id: `${calledAt}-${Math.random()}`, called_at: calledAt });
    raw.close();
  }
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

  it('prune(days) deletes rows older than the window and keeps recent ones', () => {
    const tracker = new CostTracker(dbPath);
    insertAt(dbPath, daysAgo(40));
    insertAt(dbPath, daysAgo(31));
    insertAt(dbPath, daysAgo(5));
    const deleted = tracker.prune(30);
    expect(deleted).toBe(2);
    const rows = tracker.getRecentCalls(50);
    expect(rows.length).toBe(1);
    expect(new Date(rows[0].calledAt).getTime()).toBeGreaterThan(Date.now() - 10 * 86_400_000);
  });

  it('SUDO_COST_RETENTION_DAYS=0 disables pruning (keep everything)', () => {
    process.env[RET] = '0';
    const tracker = new CostTracker(dbPath);
    insertAt(dbPath, daysAgo(400));
    expect(tracker.prune()).toBe(0);
    expect(tracker.getRecentCalls(50).length).toBe(1);
  });

  it('honours SUDO_COST_RETENTION_DAYS override', () => {
    process.env[RET] = '7';
    const tracker = new CostTracker(dbPath);
    insertAt(dbPath, daysAgo(10));
    insertAt(dbPath, daysAgo(3));
    expect(tracker.prune()).toBe(1); // 10d old > 7d window
    expect(tracker.getRecentCalls(50).length).toBe(1);
  });

  it('prunes the backlog once at construction', () => {
    // Materialise the current schema (incl. cache columns) via a throwaway
    // tracker, seed an old row, then re-open: the new tracker prunes on init.
    new CostTracker(dbPath);
    insertAt(dbPath, daysAgo(90));
    const reopened = new CostTracker(dbPath); // constructor calls prune()
    expect(reopened.getRecentCalls(50).length).toBe(0);
  });
});
