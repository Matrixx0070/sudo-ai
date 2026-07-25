/**
 * AL7.1 eval backfill: the three 2026-07 prod-failure classes become bench
 * regressions — scrape-0-fields and doom-loop-FP as agent tasks (setup/verify
 * logic tested here without a live agent), the #751 empty-reply class as a
 * harness rule in AgentBenchRunner — plus the held-out gate's fail-closed
 * posture for autonomous draft patches.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scrapeZeroFieldsTask } from '../../src/core/eval/agent-tasks/scrape-zero-fields.js';
import { repeatedToolCallsTask } from '../../src/core/eval/agent-tasks/repeated-tool-calls.js';
import { ALL_AGENT_TASKS, AGENT_TASKS_BY_ID } from '../../src/core/eval/agent-tasks/index.js';
import { AgentBenchRunner, type AgentLoopLike, type SessionManagerLike } from '../../src/core/eval/agent-bench-runner.js';
import { evaluateDraftGate } from '../../src/core/self-improvement/engine.js';
import type { AgentBenchTask } from '../../src/core/eval/agent-bench-types.js';

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(path.join(os.tmpdir(), 'regression-class-'));
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe('registry', () => {
  it('both regression-class tasks are registered', () => {
    const ids = ALL_AGENT_TASKS.map((t) => t.id);
    expect(ids).toContain('scrape-zero-fields');
    expect(ids).toContain('repeated-tool-calls');
    expect(AGENT_TASKS_BY_ID['scrape-zero-fields']).toBe(scrapeZeroFieldsTask);
  });
});

describe('scrape-zero-fields task', () => {
  it('passes on a full correct extraction', async () => {
    await scrapeZeroFieldsTask.setupWorkspace(ws);
    await fs.writeFile(
      path.join(ws, 'out.json'),
      JSON.stringify([
        { title: 'Aurora Lamp', price: '$49.99' },
        { title: 'Basalt Mug', price: '$12.50' },
        { title: 'Cedar Shelf', price: '$89.00' },
      ]),
      'utf8',
    );
    const v = await scrapeZeroFieldsTask.verifyWorkspace(ws);
    expect(v.passed).toBe(true);
    expect(v.score).toBe(1);
  });

  it('fails the incident class: zero extracted records', async () => {
    await scrapeZeroFieldsTask.setupWorkspace(ws);
    await fs.writeFile(path.join(ws, 'out.json'), '[]', 'utf8');
    const v = await scrapeZeroFieldsTask.verifyWorkspace(ws);
    expect(v.passed).toBe(false);
    expect(v.score).toBe(0);
    expect(v.detail).toContain('zero extracted');
  });

  it('fails on an empty field in any record', async () => {
    await scrapeZeroFieldsTask.setupWorkspace(ws);
    await fs.writeFile(
      path.join(ws, 'out.json'),
      JSON.stringify([{ title: 'Aurora Lamp', price: '' }]),
      'utf8',
    );
    const v = await scrapeZeroFieldsTask.verifyWorkspace(ws);
    expect(v.passed).toBe(false);
    expect(v.detail).toContain('empty field');
  });

  it('fails when out.json is missing or invalid', async () => {
    await scrapeZeroFieldsTask.setupWorkspace(ws);
    expect((await scrapeZeroFieldsTask.verifyWorkspace(ws)).passed).toBe(false);
    await fs.writeFile(path.join(ws, 'out.json'), 'not json', 'utf8');
    expect((await scrapeZeroFieldsTask.verifyWorkspace(ws)).passed).toBe(false);
  });
});

describe('repeated-tool-calls task (doom-loop FP guard)', () => {
  it('passes when all six parts were read and combined', async () => {
    await repeatedToolCallsTask.setupWorkspace(ws);
    await fs.writeFile(path.join(ws, 'sentence.txt'), 'the quick brown fox jumps high\n', 'utf8');
    const v = await repeatedToolCallsTask.verifyWorkspace(ws);
    expect(v.passed).toBe(true);
  });

  it('fails with the doom-loop-FP signal when the output is missing (aborted run)', async () => {
    await repeatedToolCallsTask.setupWorkspace(ws);
    const v = await repeatedToolCallsTask.verifyWorkspace(ws);
    expect(v.passed).toBe(false);
    expect(v.detail).toContain('doom-loop');
  });

  it('fails on wrong content', async () => {
    await repeatedToolCallsTask.setupWorkspace(ws);
    await fs.writeFile(path.join(ws, 'sentence.txt'), 'the quick brown\n', 'utf8');
    expect((await repeatedToolCallsTask.verifyWorkspace(ws)).passed).toBe(false);
  });
});

describe('runner empty-reply rule (#751 class)', () => {
  const sessionManager: SessionManagerLike = {
    getOrCreate: vi.fn(async () => ({ id: 's' })),
  };

  function passingTask(): AgentBenchTask {
    return {
      id: 'always-pass',
      name: 'workspace verifier passes regardless',
      prompt: 'Do the thing in {workspace}.',
      async setupWorkspace() { /* nothing */ },
      async verifyWorkspace() {
        return { passed: true, score: 1, detail: 'workspace fine', type: 'mock' };
      },
    };
  }

  it('an empty final reply fails the run even when the workspace verifier passes', async () => {
    const agentLoop: AgentLoopLike = {
      run: vi.fn(async () => ({ text: '   ', attachments: [] })),
    };
    const runner = new AgentBenchRunner({ agentLoop, sessionManager, modelLabel: 'mock' });
    const result = await runner.run(passingTask());
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    expect(result.detail).toContain('#751');
  });

  it('a non-empty reply leaves the verdict untouched', async () => {
    const agentLoop: AgentLoopLike = {
      run: vi.fn(async () => ({ text: 'done', attachments: [] })),
    };
    const runner = new AgentBenchRunner({ agentLoop, sessionManager, modelLabel: 'mock' });
    const result = await runner.run(passingTask());
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });
});

describe('evaluateDraftGate fail-closed (AL7.1)', () => {
  const action = { params: { description: 'x' } };

  it('passes through a passing gate', async () => {
    const gate = { evaluate: vi.fn(async () => ({ passed: true, passRate: 1 })) };
    await expect(evaluateDraftGate(gate as never, 'p1', action as never, 't')).resolves.toBe(true);
  });

  it('blocks on a rejecting gate', async () => {
    const gate = { evaluate: vi.fn(async () => ({ passed: false, passRate: 0.4 })) };
    await expect(evaluateDraftGate(gate as never, 'p1', action as never, 't')).resolves.toBe(false);
  });

  it('blocks when the gate THROWS — fail-closed, never allow-by-default', async () => {
    const gate = { evaluate: vi.fn(async () => { throw new Error('gate infra down'); }) };
    await expect(evaluateDraftGate(gate as never, 'p1', action as never, 't')).resolves.toBe(false);
  });
});
