/**
 * ToolSuccessStore (gap #1) — proves recorded outcomes produce a bounded bias
 * and that the bias actually re-ranks ToolRouter selection at decision time.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ToolSuccessStore } from '../../src/core/agent/tool-success-store.js';
import { ToolRouter } from '../../src/core/agent/tool-router.js';

function fakeRegistry(tools: Array<{ name: string; category: string }>) {
  const schemas = tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.name, parameters: {} } }));
  return {
    getSchemaForLLM: () => schemas,
    listEnabled: () => tools.map((t) => ({ name: t.name, description: t.name, category: t.category, parameters: {} })),
  };
}

describe('ToolSuccessStore — outcome → bias', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); });
  afterEach(() => { db.close(); });

  it('emits no bias while under MIN_SAMPLES (explore cold)', () => {
    const s = new ToolSuccessStore(db, { minSamples: 5 });
    for (let i = 0; i < 4; i++) s.record('t.flaky', false);
    expect(s.bias('t.flaky')).toBe(0);
    expect(s.bias('t.never-seen')).toBe(0);
  });

  it('down-weights a chronically-failing tool and up-weights a reliable one', () => {
    const s = new ToolSuccessStore(db, { minSamples: 5 });
    for (let i = 0; i < 10; i++) s.record('t.bad', false);
    for (let i = 0; i < 10; i++) s.record('t.good', true);
    expect(s.bias('t.bad')).toBeLessThan(0);
    expect(s.bias('t.good')).toBeGreaterThan(0);
    expect(s.bias('t.bad')).toBeLessThan(s.bias('t.good'));
  });

  it('bias stays within the clamp bounds', () => {
    const s = new ToolSuccessStore(db, { minSamples: 3, minBias: -2, maxBias: 1 });
    for (let i = 0; i < 30; i++) s.record('t.bad', false);
    for (let i = 0; i < 30; i++) s.record('t.good', true);
    expect(s.bias('t.bad')).toBeGreaterThanOrEqual(-2);
    expect(s.bias('t.good')).toBeLessThanOrEqual(1);
  });

  it('persists across instances (compounds over restarts)', () => {
    const s1 = new ToolSuccessStore(db, { minSamples: 5 });
    for (let i = 0; i < 8; i++) s1.record('t.bad', false);
    const written = s1.flush();
    expect(written).toBeGreaterThan(0);
    const s2 = new ToolSuccessStore(db, { minSamples: 5 }); // fresh cache, same db
    expect(s2.bias('t.bad')).toBeLessThan(0);
    expect(s2.successRate('t.bad')).not.toBeNull();
  });
});

describe('ToolRouter — outcome bias re-ranks selection', () => {
  const TOOLS = [
    { name: 'meta.self-modify', category: 'meta' },
    { name: 'system.exec', category: 'system' },
    { name: 'coder.read-file', category: 'coder' },
    // two siblings in the same category with equal keyword relevance
    { name: 'github.aaa', category: 'github' },
    { name: 'github.bbb', category: 'github' },
  ];
  const MSG = 'do something on github please';

  it('preserves registration order for equal-relevance siblings without bias', () => {
    const router = new ToolRouter(fakeRegistry(TOOLS) as never);
    const n = router.route(MSG).map((s) => s.function.name);
    expect(n).toContain('github.aaa');
    expect(n).toContain('github.bbb');
    expect(n.indexOf('github.aaa')).toBeLessThan(n.indexOf('github.bbb'));
  });

  it('sinks a down-weighted tool below its reliable sibling', () => {
    const router = new ToolRouter(fakeRegistry(TOOLS) as never);
    router.setOutcomeBias((name) => (name === 'github.aaa' ? -2 : 0));
    const n = router.route(MSG).map((s) => s.function.name);
    expect(n.indexOf('github.bbb')).toBeLessThan(n.indexOf('github.aaa'));
  });
});
