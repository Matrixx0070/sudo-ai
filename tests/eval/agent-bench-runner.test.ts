/**
 * Tests for AgentBenchRunner — Phase 2 (BenchRunner-invokes-agent).
 *
 * Uses a mock AgentLoop that simulates editing the workspace, then verifies the
 * runner orchestrates setupWorkspace → agent loop → verifyWorkspace correctly
 * and records the right fields on the result.
 *
 * The real-LLM end-to-end run lives in scripts/, not in this test (it costs
 * tokens and depends on a live OAuth token).
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  AgentBenchRunner,
  type AgentLoopLike,
  type SessionManagerLike,
} from '../../src/core/eval/agent-bench-runner.js';
import type { AgentBenchTask } from '../../src/core/eval/agent-bench-types.js';

const dummySessionManager: SessionManagerLike = {
  getOrCreate: vi.fn(async () => ({ id: 'mock-session-id' })),
};

function makeTask(opts: {
  initialFile: string;
  initialContent: string;
  agentEdit: (workspaceDir: string) => Promise<void>;
  verifierPasses: boolean;
}): { task: AgentBenchTask; agentLoop: AgentLoopLike } {
  const task: AgentBenchTask = {
    id: 'mock-task',
    name: 'Mock task',
    prompt: 'Edit {workspace}/file.txt.',
    async setupWorkspace(dir) {
      await fs.writeFile(path.join(dir, opts.initialFile), opts.initialContent, 'utf8');
    },
    async verifyWorkspace(dir) {
      const content = await fs.readFile(path.join(dir, opts.initialFile), 'utf8');
      const passed = opts.verifierPasses && content !== opts.initialContent;
      return {
        passed,
        score: passed ? 1 : 0,
        detail: passed ? 'agent edited the file as expected' : `content unchanged: "${content}"`,
        type: 'mock',
      };
    },
  };
  const agentLoop: AgentLoopLike = {
    run: vi.fn(async (sessionId, message, onEvent) => {
      // Simulate the agent receiving its expanded prompt and calling tools.
      expect(sessionId).toBe('mock-session-id');
      expect(message).toContain('Edit ');
      expect(message).not.toContain('{workspace}'); // template was expanded
      // Find the workspace dir from the expanded prompt (between "Edit " and "/file.txt")
      const wsMatch = message.match(/Edit (.+?)\/file\.txt/);
      const workspaceDir = wsMatch ? wsMatch[1]! : '';
      onEvent?.({ type: 'tool-call' });
      onEvent?.({ type: 'tool-call' });
      await opts.agentEdit(workspaceDir);
      return { text: 'I edited the file.', attachments: [] };
    }),
  };
  return { task, agentLoop };
}

describe('AgentBenchRunner — with mock agent loop', () => {
  it('orchestrates setupWorkspace → agent loop → verifyWorkspace and records result fields', async () => {
    const { task, agentLoop } = makeTask({
      initialFile: 'file.txt',
      initialContent: 'before',
      agentEdit: async (dir) => fs.writeFile(path.join(dir, 'file.txt'), 'after', 'utf8'),
      verifierPasses: true,
    });
    const runner = new AgentBenchRunner({
      agentLoop,
      sessionManager: dummySessionManager,
      modelLabel: 'mock-model',
    });

    const result = await runner.run(task);

    expect(result.taskId).toBe('mock-task');
    expect(result.model).toBe('mock-model');
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
    expect(result.detail).toContain('edited');
    expect(result.agentText).toBe('I edited the file.');
    expect(typeof result.wallTimeMs).toBe('number');
    expect(result.wallTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.toolCallCount).toBe(2);
    expect(result.transcriptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(agentLoop.run).toHaveBeenCalledOnce();
  });

  it('records passed=false when verifier rejects the agent\'s edit', async () => {
    const { task, agentLoop } = makeTask({
      initialFile: 'file.txt',
      initialContent: 'before',
      agentEdit: async () => { /* agent does nothing */ },
      verifierPasses: false,
    });
    const runner = new AgentBenchRunner({
      agentLoop,
      sessionManager: dummySessionManager,
      modelLabel: 'mock-model',
    });

    const result = await runner.run(task);
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    expect(result.detail).toContain('unchanged');
  });

  it('cleans up the workspace by default; keeps it when keepWorkspace=true', async () => {
    const { task, agentLoop } = makeTask({
      initialFile: 'file.txt',
      initialContent: 'before',
      agentEdit: async (dir) => fs.writeFile(path.join(dir, 'file.txt'), 'after', 'utf8'),
      verifierPasses: true,
    });
    // Capture the workspace path via a probe verifier
    let capturedDir = '';
    const probe: AgentBenchTask = {
      ...task,
      verifyWorkspace: async (dir) => {
        capturedDir = dir;
        return task.verifyWorkspace(dir);
      },
    };
    const runner = new AgentBenchRunner({
      agentLoop,
      sessionManager: dummySessionManager,
    });

    await runner.run(probe);
    expect(capturedDir).not.toBe('');
    await expect(fs.access(capturedDir)).rejects.toThrow(); // dir was removed

    await runner.run(probe, { keepWorkspace: true });
    await expect(fs.access(capturedDir)).resolves.toBeUndefined(); // still there
    // cleanup the kept dir
    await fs.rm(capturedDir, { recursive: true, force: true });
  });
});
