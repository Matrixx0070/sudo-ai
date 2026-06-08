/**
 * Tests for SkillForge — auto-generates skills from successful tool sequences.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SkillForge, type ToolPattern, type SkillCandidate } from '../../src/core/learning/skill-forge.js';
import type { TraceStore, TraceRecord } from '../../src/core/learning/trace-store.js';
import type { TraceAnalyzer } from '../../src/core/learning/trace-analyzer.js';
import path from 'path';
import os from 'os';
import { rmSync, existsSync, readFileSync } from 'fs';

// -- Mock factories -----------------------------------------------------------

function mockTraceStore(traces: TraceRecord[] = []): TraceStore {
  return {
    query: vi.fn().mockImplementation((q: Record<string, unknown>) => {
      let r = [...traces];
      if (q.type) r = r.filter(t => t.traceType === q.type);
      if (q.success !== undefined) r = r.filter(t => t.success === q.success);
      if (q.limit) r = r.slice(0, q.limit as number);
      return r;
    }),
    record: vi.fn(), refreshAggregates: vi.fn(), getAggregates: vi.fn().mockReturnValue([]),
    getErrorClusters: vi.fn().mockReturnValue([]), count: vi.fn().mockReturnValue(traces.length),
    close: vi.fn(),
  } as unknown as TraceStore;
}

function mockAnalyzer(): TraceAnalyzer {
  return { analyze: vi.fn().mockReturnValue({ modelToolStats: [], modelCategoryStats: [], errorClusters: [], anomalies: [], window: { since: '', until: '', label: 'last_24h' } }) } as unknown as TraceAnalyzer;
}

/** Build trace records for multiple sessions with ordered tool calls. */
function buildTraces(sessions: Record<string, { tool: string; success: boolean }[]>): TraceRecord[] {
  const out: TraceRecord[] = [];
  const base = Date.now() - 3600000;
  for (const [sid, calls] of Object.entries(sessions)) {
    calls.forEach((c, i) => {
      out.push({ traceType: 'tool_call', sessionId: sid, toolName: c.tool, success: c.success, latencyMs: 100 + i * 10, createdAt: new Date(base + i * 60000).toISOString() } as TraceRecord);
    });
  }
  return out;
}

describe('SkillForge', () => {
  let tmpDir: string;
  let forge: SkillForge;

  beforeEach(() => { tmpDir = path.join(os.tmpdir(), `sf-test-${Date.now()}`); });
  afterEach(() => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ } });

  // 1. scan finds recurring patterns
  it('scan finds recurring patterns', async () => {
    const traces = buildTraces({
      s1: [{ tool: 'web_search', success: true }, { tool: 'scrape', success: true }],
      s2: [{ tool: 'web_search', success: true }, { tool: 'scrape', success: true }],
      s3: [{ tool: 'web_search', success: true }, { tool: 'scrape', success: true }],
    });
    forge = new SkillForge(mockTraceStore(traces), mockAnalyzer(), tmpDir);
    const candidates = await forge.scan();
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    const match = candidates.find(c => c.pattern.toolSequence.includes('web_search') && c.pattern.toolSequence.includes('scrape'));
    expect(match).toBeDefined();
    expect(match!.pattern.occurrenceCount).toBeGreaterThanOrEqual(3);
  });

  // 2. forge generates SKILL.md content
  it('forge generates SKILL.md content', async () => {
    forge = new SkillForge(mockTraceStore(), mockAnalyzer(), tmpDir);
    const pattern: ToolPattern = { toolSequence: ['web_search', 'scrape', 'summarize'], intentPattern: 'research then extract then summarize', successRate: 0.9, occurrenceCount: 5, avgLatencyMs: 350 };
    const content = await forge.forge(pattern);
    expect(content).toContain('---');
    expect(content).toContain('name:');
    expect(content).toContain('description:');
    expect(content).toContain('tools:');
    expect(content).toContain('confidence:');
    expect(content).toContain('# ');
  });

  // 3. accept writes skill file
  it('accept writes skill file', async () => {
    forge = new SkillForge(mockTraceStore(), mockAnalyzer(), tmpDir);
    const candidate: SkillCandidate = { pattern: { toolSequence: ['read', 'edit'], intentPattern: 'read then modify', successRate: 0.85, occurrenceCount: 7, avgLatencyMs: 200 }, generatedSkill: '---\nname: read-and-edit\n---\n# Read And Edit', confidence: 0.85 };
    const result = await forge.accept(candidate);
    expect(result.accepted).toBe(true);
    expect(result.skillName).toBe('read-and-edit');
    expect(existsSync(result.skillPath)).toBe(true);
    expect(readFileSync(result.skillPath, 'utf8')).toContain('read-and-edit');
  });

  // 4. reject records rejection reason
  it('reject records rejection reason', () => {
    forge = new SkillForge(mockTraceStore(), mockAnalyzer(), tmpDir);
    const candidate: SkillCandidate = { pattern: { toolSequence: ['bad'], intentPattern: 'bad pattern', successRate: 0.5, occurrenceCount: 2, avgLatencyMs: 1000 }, generatedSkill: '---\n---\n# Bad', confidence: 0.5 };
    forge.reject(candidate, 'Low success rate');
    const stats = forge.getStats();
    expect(stats.skillsRejected).toBe(1);
    expect(stats.skillsForged).toBe(0);
  });

  // 5. patterns below threshold not generated
  it('patterns below threshold not generated', async () => {
    const traces = buildTraces({
      s1: [{ tool: 'a', success: true }, { tool: 'b', success: false }],
      s2: [{ tool: 'a', success: true }, { tool: 'b', success: false }],
      s3: [{ tool: 'a', success: true }, { tool: 'b', success: false }],
      s4: [{ tool: 'a', success: true }, { tool: 'b', success: true }],
      s5: [{ tool: 'a', success: true }, { tool: 'b', success: true }],
    });
    forge = new SkillForge(mockTraceStore(traces), mockAnalyzer(), tmpDir);
    const candidates = await forge.scan();
    for (const c of candidates) {
      expect(c.pattern.successRate).toBeGreaterThanOrEqual(0.80);
    }
  });

  // 6. skill YAML frontmatter is valid
  it('skill YAML frontmatter is valid', async () => {
    forge = new SkillForge(mockTraceStore(), mockAnalyzer(), tmpDir);
    const pattern: ToolPattern = { toolSequence: ['web_search', 'summarize'], intentPattern: 'research then summarize', successRate: 0.92, occurrenceCount: 8, avgLatencyMs: 300 };
    const content = await forge.forge(pattern);
    const fm = content.split('---')[1]!;
    expect(fm).toMatch(/name:\s+.+/);
    expect(fm).toMatch(/description:\s+.+/);
    expect(fm).toMatch(/tools:/);
    expect(fm).toMatch(/triggers:/);
    expect(fm).toMatch(/confidence:\s+[\d.]+/);
  });

  // 7. stats tracking works
  it('stats tracking works', async () => {
    const traces = buildTraces({
      s1: [{ tool: 'x', success: true }, { tool: 'y', success: true }],
      s2: [{ tool: 'x', success: true }, { tool: 'y', success: true }],
      s3: [{ tool: 'x', success: true }, { tool: 'y', success: true }],
    });
    forge = new SkillForge(mockTraceStore(traces), mockAnalyzer(), tmpDir);
    await forge.scan();
    const candidate: SkillCandidate = { pattern: { toolSequence: ['a', 'b'], intentPattern: 'a then b', successRate: 0.9, occurrenceCount: 5, avgLatencyMs: 100 }, generatedSkill: '---\nname: a-and-b\n---\n# A And B', confidence: 0.9 };
    await forge.accept(candidate);
    forge.reject({ ...candidate, confidence: 0.4 }, 'Too low');
    const stats = forge.getStats();
    expect(stats.skillsForged).toBe(1);
    expect(stats.skillsRejected).toBe(1);
    expect(typeof stats.avgConfidence).toBe('number');
  });

  // 8. cooperative async scan (SUDO_SKILL_FORGE_ASYNC) yields output IDENTICAL to
  //    the default path — proves the event-loop yields don't change results. The
  //    fixture has > YIELD_EVERY (50) sessions so the cooperative path really yields.
  it('cooperative scan yields output identical to the default path (with real yields)', async () => {
    const sessions: Record<string, { tool: string; success: boolean }[]> = {};
    for (let i = 0; i < 130; i++) {
      sessions[`ok${i}`] = [
        { tool: 'web_search', success: true },
        { tool: 'scrape', success: true },
        { tool: 'summarize', success: true },
      ];
      if (i % 3 === 0) {
        sessions[`bad${i}`] = [
          { tool: 'read', success: true },
          { tool: 'edit', success: false },
        ];
      }
    }
    const traces = buildTraces(sessions);
    const prev = process.env['SUDO_SKILL_FORGE_ASYNC'];
    try {
      delete process.env['SUDO_SKILL_FORGE_ASYNC'];
      const sync = await new SkillForge(mockTraceStore(traces), mockAnalyzer(), tmpDir).scan();

      process.env['SUDO_SKILL_FORGE_ASYNC'] = '1';
      const coop = await new SkillForge(mockTraceStore(traces), mockAnalyzer(), tmpDir).scan();

      expect(sync.length).toBeGreaterThan(0); // guard: the fixture really produces candidates
      expect(coop).toEqual(sync);
    } finally {
      if (prev === undefined) delete process.env['SUDO_SKILL_FORGE_ASYNC'];
      else process.env['SUDO_SKILL_FORGE_ASYNC'] = prev;
    }
  });

  // 9. cooperative scan with a trace set BELOW the counter yield threshold still
  //    matches the default output. (The structural yields — between the two queries
  //    and between the two extractWindows passes — still fire; only the YIELD_EVERY
  //    counter-based yields are skipped, since there are far fewer than 50 sessions.)
  it('cooperative scan below the yield threshold still matches default output', async () => {
    const traces = buildTraces({
      s1: [{ tool: 'web_search', success: true }, { tool: 'scrape', success: true }],
      s2: [{ tool: 'web_search', success: true }, { tool: 'scrape', success: true }],
      s3: [{ tool: 'web_search', success: true }, { tool: 'scrape', success: true }],
    });
    const prev = process.env['SUDO_SKILL_FORGE_ASYNC'];
    try {
      delete process.env['SUDO_SKILL_FORGE_ASYNC'];
      const sync = await new SkillForge(mockTraceStore(traces), mockAnalyzer(), tmpDir).scan();

      process.env['SUDO_SKILL_FORGE_ASYNC'] = '1';
      const coop = await new SkillForge(mockTraceStore(traces), mockAnalyzer(), tmpDir).scan();

      expect(sync.length).toBeGreaterThanOrEqual(1);
      expect(coop).toEqual(sync);
    } finally {
      if (prev === undefined) delete process.env['SUDO_SKILL_FORGE_ASYNC'];
      else process.env['SUDO_SKILL_FORGE_ASYNC'] = prev;
    }
  });
});