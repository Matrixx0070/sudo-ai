/**
 * Blocker #1 from the 2026-08-05 autonomy audit (the agent's own top-ranked):
 * a run halted at the spend cap left ZERO durable artifacts, so the next turn
 * started cold. The journal makes a halt a PAUSE: progress is written as it
 * happens and replayed into the next turn as a resume digest.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'journal-'));
  process.env['DATA_DIR'] = tmp;
  vi.resetModules();
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env['DATA_DIR'];
  delete process.env['SUDO_RUN_JOURNAL'];
});

async function load() {
  return import('../../src/core/agent/run-journal.js');
}

describe('journal round-trip', () => {
  it('appends and reads entries in order', async () => {
    const j = await load();
    j.appendEntry('s1', { kind: 'start', at: '2026-08-05T00:00:00Z', runId: 'r1', goal: 'do it' });
    j.appendEntry('s1', { kind: 'step', at: '2026-08-05T00:00:01Z', runId: 'r1', iteration: 1, tools: ['system.exec'] });
    const entries = j.readEntries('s1');
    expect(entries).toHaveLength(2);
    expect(entries[0]!.kind).toBe('start');
  });

  it('survives a malformed/partial tail line', async () => {
    const j = await load();
    j.appendEntry('s2', { kind: 'start', at: 'x', runId: 'r1', goal: 'g' });
    const { appendFileSync } = await import('node:fs');
    appendFileSync(path.join(tmp, 'run-journal', 's2.jsonl'), '{"kind":"ste');
    expect(j.readEntries('s2')).toHaveLength(1);
  });

  it('SUDO_RUN_JOURNAL=0 disables reads and writes', async () => {
    process.env['SUDO_RUN_JOURNAL'] = '0';
    const j = await load();
    j.appendEntry('s3', { kind: 'start', at: 'x', runId: 'r1', goal: 'g' });
    expect(j.readEntries('s3')).toEqual([]);
    expect(j.consumeResumeDigest('s3')).toBe('');
  });
});

describe('findResumableRun', () => {
  it('finds the last halted, unsettled run', async () => {
    const { findResumableRun } = await load();
    const r = findResumableRun([
      { kind: 'start', at: 'a', runId: 'r1', goal: 'big mission' },
      { kind: 'step', at: 'b', runId: 'r1', iteration: 1, tools: ['a.b'] },
      { kind: 'halt', at: 'c', runId: 'r1', reason: 'spend cap ($5.12 of $5.00)', iterations: 38 },
    ]);
    expect(r?.runId).toBe('r1');
    expect(r?.goal).toBe('big mission');
    expect(r?.iterations).toBe(38);
  });

  it('returns null when the run finished (end) or was already resumed', async () => {
    const { findResumableRun } = await load();
    const halted = [
      { kind: 'start', at: 'a', runId: 'r1', goal: 'g' },
      { kind: 'halt', at: 'c', runId: 'r1', reason: 'x', iterations: 3 },
    ] as const;
    expect(findResumableRun([...halted, { kind: 'end', at: 'd', runId: 'r1', iterations: 3 }])).toBeNull();
    expect(findResumableRun([...halted, { kind: 'resumed', at: 'd', runId: 'r2', ofRunId: 'r1' }])).toBeNull();
  });

  it('returns null when nothing halted', async () => {
    const { findResumableRun } = await load();
    expect(findResumableRun([{ kind: 'start', at: 'a', runId: 'r1', goal: 'g' }])).toBeNull();
  });
});

describe('buildResumeDigest', () => {
  it('names the goal, the stop reason, and completed steps', async () => {
    const { buildResumeDigest } = await load();
    const txt = buildResumeDigest({
      runId: 'r1', goal: 'audit the runtime', reason: 'spend cap ($5.12 of $5.00)', iterations: 38,
      steps: [
        { kind: 'step', at: 'a', runId: 'r1', iteration: 1, tools: ['system.exec'], note: 'read vitals' },
        { kind: 'step', at: 'b', runId: 'r1', iteration: 2, tools: ['coder.read-file'] },
      ],
    });
    expect(txt).toContain('audit the runtime');
    expect(txt).toContain('spend cap ($5.12 of $5.00)');
    expect(txt).toContain('iteration 1: system.exec — read vitals');
    expect(txt).toContain('Do NOT restart from scratch');
  });

  it('elides beyond the step cap and reports the elision', async () => {
    const { buildResumeDigest } = await load();
    const steps = Array.from({ length: 30 }, (_, i) => ({
      kind: 'step' as const, at: 'a', runId: 'r1', iteration: i + 1, tools: ['t'],
    }));
    const txt = buildResumeDigest({ runId: 'r1', goal: 'g', reason: 'r', iterations: 30, steps });
    expect(txt).toContain('10 earlier steps elided');
  });

  it('returns empty string for nothing to resume', async () => {
    const { buildResumeDigest } = await load();
    expect(buildResumeDigest(null)).toBe('');
  });
});

describe('consumeResumeDigest', () => {
  it('returns the digest once, then marks it resumed', async () => {
    const j = await load();
    j.appendEntry('s4', { kind: 'start', at: 'a', runId: 'r1', goal: 'the mission' });
    j.appendEntry('s4', { kind: 'step', at: 'b', runId: 'r1', iteration: 1, tools: ['x.y'] });
    j.appendEntry('s4', { kind: 'halt', at: 'c', runId: 'r1', reason: 'spend cap', iterations: 1 });

    const first = j.consumeResumeDigest('s4');
    expect(first).toContain('the mission');
    expect(j.consumeResumeDigest('s4')).toBe('');
  });
});

// --- end-to-end through AgentLoop ------------------------------------------

import { AgentLoop } from '../../src/core/agent/loop.js';
// Static import: shares the module instance (and therefore the load-time
// DATA_DIR) with loop.ts, unlike the per-test dynamic load() above.
import { readEntries as readEntriesLive } from '../../src/core/agent/run-journal.js';
import { DATA_DIR as LIVE_DATA_DIR } from '../../src/core/shared/paths.js';
import {
  createMockBrain,
  createMockToolRegistry,
  createMockSessionManager,
} from '../helpers/mocks.js';
import type { BrainResponse } from '../../src/core/brain/types.js';

const sandboxManager = () => ({
  getWorkspaceDir: vi.fn().mockReturnValue('/mock/workspace'),
  getPolicyFor: vi.fn().mockReturnValue({}),
});

function costly(i: number): BrainResponse {
  return {
    content: `working step ${i}`,
    toolCalls: [{ id: `tc-${i}`, name: `system.step${i}`, arguments: {} }],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 1 },
    model: 'xai/grok-3-fast',
    finishReason: 'tool-calls',
  };
}

describe('AgentLoop e2e: halt writes a journal, next run resumes', () => {
  afterEach(() => { delete process.env['SUDO_AGENT_RUN_MAX_USD']; });

  it('records a halt and injects the resume digest on the following run', async () => {
    process.env['SUDO_AGENT_RUN_MAX_USD'] = '0.5';
    // Own session id: other suites drive AgentLoop with the shared
    // 'test-session-id' and write to the same journal dir, so a shared id
    // makes this test order-dependent under vitest's parallel workers.
    const sessions = createMockSessionManager();
    const own = await sessions.getOrCreate('test-journal', 'e2e');
    const sid = own.id;
    // The loop writes to the load-time DATA_DIR, not this test's tmp override.
    const liveFile = path.join(LIVE_DATA_DIR, 'run-journal', `${sid}.jsonl`);
    rmSync(liveFile, { force: true });

    const brain1 = createMockBrain();
    brain1.call.mockResolvedValue(costly(1));
    const loop1 = new AgentLoop(brain1, createMockToolRegistry(), sessions,
      undefined, undefined, undefined, undefined, undefined, sandboxManager());
    await loop1.run(sid, 'audit the runtime');

    const entries = readEntriesLive(sid);
    expect(entries.some(e => e.kind === 'halt')).toBe(true);
    expect(entries.some(e => e.kind === 'step')).toBe(true);
    expect(entries.some(e => e.kind === 'end')).toBe(false); // halted runs are not 'end'

    // Next run: the digest must reach the model.
    delete process.env['SUDO_AGENT_RUN_MAX_USD'];
    const brain2 = createMockBrain();
    brain2.call.mockResolvedValue({
      content: 'continuing', toolCalls: [],
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10, estimatedCost: 0 },
      model: 'xai/grok-3-fast', finishReason: 'stop',
    } as BrainResponse);
    const loop2 = new AgentLoop(brain2, createMockToolRegistry(), sessions,
      undefined, undefined, undefined, undefined, undefined, sandboxManager());
    await loop2.run(sid, 'continue');

    const sent = (brain2.call.mock.calls[0]?.[0] as { messages?: Array<{ content: unknown }> })?.messages ?? [];
    const blob = sent.map(m => String(m.content)).join('\n');
    expect(blob).toContain('Resuming an interrupted run');
    expect(blob).toContain('audit the runtime');
    rmSync(liveFile, { force: true });
  });
});

describe('AgentLoop seam (beginRun / journalStep / journalHalt / journalEnd)', () => {
  it('beginRun records a start and returns no digest on a fresh session', async () => {
    const j = await load();
    expect(j.beginRun('seam1', 'r1', 'the goal')).toBe('');
    expect(j.readEntries('seam1').map(e => e.kind)).toEqual(['start']);
  });

  it('a halted run is offered to the NEXT beginRun, exactly once', async () => {
    const j = await load();
    j.beginRun('seam2', 'r1', 'the mission');
    j.journalStep('seam2', 'r1', 1, ['system.exec'], '  checked vitals  ');
    j.journalHalt('seam2', 'r1', 'spend cap ($5.12 of $5.00)', 38);

    const digest = j.beginRun('seam2', 'r2', 'continue');
    expect(digest).toContain('the mission');
    expect(digest).toContain('checked vitals');   // note trimmed, not dropped
    expect(digest).toContain('spend cap ($5.12 of $5.00)');
    expect(j.beginRun('seam2', 'r3', 'continue')).toBe(''); // consumed
  });

  it('journalEnd settles a run so it is never offered for resume', async () => {
    const j = await load();
    j.beginRun('seam3', 'r1', 'g');
    j.journalHalt('seam3', 'r1', 'iteration limit (150)', 150);
    j.journalEnd('seam3', 'r1', 150);
    expect(j.beginRun('seam3', 'r2', 'next')).toBe('');
  });

  it('journalStep omits an empty note', async () => {
    const j = await load();
    j.journalStep('seam4', 'r1', 1, ['t'], '   ');
    const step = j.readEntries('seam4')[0]!;
    expect(step.kind).toBe('step');
    expect((step as { note?: string }).note).toBeUndefined();
  });
});
