/** Eval-sandbox tool gate (ADR-0007): inactive no-op, deny/allow-list, fail-open. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  activateEvalGate,
  deactivateEvalGate,
  evalGateBeforeTool,
  evalGateAfterTool,
  type EvalRunContext,
} from '../../../src/core/eval/sandbox/eval-gate.js';
import { RunJournal, readJournal } from '../../../src/core/eval/sandbox/run-journal.js';
import { ToolRegistry } from '../../../src/core/tools/registry.js';
import type { ToolContext, ToolDefinition } from '../../../src/core/tools/types.js';

let dir: string;
let journalPath: string;

function ctx(policy: EvalRunContext['policy']): EvalRunContext {
  return { runId: 'test-run', policy, journal: new RunJournal(journalPath) };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-gate-sbx-'));
  journalPath = path.join(dir, 'journal.jsonl');
  process.env['SUDO_EVAL'] = '1';
});

afterEach(() => {
  deactivateEvalGate();
  delete process.env['SUDO_EVAL'];
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('evalGateBeforeTool', () => {
  it('no active run → allow, zero journal writes', () => {
    deactivateEvalGate();
    expect(evalGateBeforeTool('system.exec', { command: 'ls' })).toEqual({ action: 'allow' });
    evalGateAfterTool('system.exec', { success: true, output: 'x' });
    expect(fs.existsSync(journalPath)).toBe(false);
  });

  it('SUDO_EVAL unset → allow even with an active run, zero journal writes', () => {
    delete process.env['SUDO_EVAL'];
    activateEvalGate(ctx({ tools: { deny: ['system.exec'] } }));
    expect(evalGateBeforeTool('system.exec', {})).toEqual({ action: 'allow' });
    expect(fs.existsSync(journalPath)).toBe(false);
  });

  it('deny rule matches exact name and journals the decision', () => {
    activateEvalGate(ctx({ tools: { deny: ['system.exec'] } }));
    const d = evalGateBeforeTool('system.exec', { command: 'rm -rf /' });
    expect(d.action).toBe('deny');

    const events = readJournal(journalPath);
    expect(events.map((e) => e.type)).toEqual(['tool.call', 'policy.decision']);
    expect(events[1]!['action']).toBe('deny');
    expect(events[1]!['rule']).toBe('deny:system.exec');
  });

  it('deny rule supports namespace globs', () => {
    activateEvalGate(ctx({ tools: { deny: ['system.*'] } }));
    expect(evalGateBeforeTool('system.api-call', {}).action).toBe('deny');
    expect(evalGateBeforeTool('coder.write-file', {}).action).toBe('allow');
  });

  it('allow list present → anything not on it is denied', () => {
    activateEvalGate(ctx({ tools: { allow: ['coder.*', 'fs.stat'] } }));
    expect(evalGateBeforeTool('coder.read-file', {}).action).toBe('allow');
    expect(evalGateBeforeTool('fs.stat', {}).action).toBe('allow');
    expect(evalGateBeforeTool('system.exec', {}).action).toBe('deny');
  });

  it('deny list wins over allow list', () => {
    activateEvalGate(ctx({ tools: { allow: ['system.*'], deny: ['system.exec'] } }));
    expect(evalGateBeforeTool('system.exec', {}).action).toBe('deny');
  });

  it('internal error → fail-open allow', () => {
    const throwingPolicy = {
      get tools(): never { throw new Error('boom'); },
    } as unknown as EvalRunContext['policy'];
    activateEvalGate(ctx(throwingPolicy));
    expect(evalGateBeforeTool('system.exec', {})).toEqual({ action: 'allow' });
  });

  it('journal failure never changes the decision', () => {
    const brokenJournal = { append(): never { throw new Error('disk full'); } } as unknown as RunJournal;
    activateEvalGate({ runId: 'r', policy: { tools: { deny: ['system.exec'] } }, journal: brokenJournal });
    expect(evalGateBeforeTool('system.exec', {}).action).toBe('deny');
    expect(evalGateBeforeTool('coder.read-file', {}).action).toBe('allow');
  });

  it('journals tool.call with params sha + truncation', () => {
    activateEvalGate(ctx({}));
    const big = 'y'.repeat(10_000);
    evalGateBeforeTool('coder.write-file', { content: big });
    const events = readJournal(journalPath);
    const call = events.find((e) => e.type === 'tool.call')!;
    expect(String(call['paramsSha256'])).toMatch(/^[0-9a-f]{64}$/);
    expect(String(call['params']).length).toBeLessThanOrEqual(4096);
  });
});

describe('evalGateAfterTool', () => {
  it('journals tool.result when active', () => {
    activateEvalGate(ctx({}));
    evalGateAfterTool('coder.read-file', { success: true, output: 'file body' });
    const events = readJournal(journalPath);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('tool.result');
    expect(events[0]!['ok']).toBe(true);
    expect(events[0]!['output']).toBe('file body');
  });
});

describe('ToolRegistry integration', () => {
  const toolCtx: ToolContext = {
    sessionId: 'test-session',
    workingDir: '/tmp',
    config: null,
    logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
  } as unknown as ToolContext;

  function echoTool(): ToolDefinition {
    return {
      name: 'demo.echo',
      description: 'echo',
      category: 'coder',
      parameters: { input: { type: 'string', description: 'in', required: true } },
      execute: async (p) => ({ success: true, output: String(p['input']) }),
    } as ToolDefinition;
  }

  it('denied tool returns a normal error ToolResult (no throw)', async () => {
    const registry = new ToolRegistry();
    registry.register(echoTool());
    activateEvalGate(ctx({ tools: { deny: ['demo.echo'] } }));

    const result = await registry.execute('demo.echo', { input: 'hi' }, toolCtx);
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/^eval-policy: /);
  });

  it('allowed tool runs and its result is journalled', async () => {
    const registry = new ToolRegistry();
    registry.register(echoTool());
    activateEvalGate(ctx({}));

    const result = await registry.execute('demo.echo', { input: 'hi' }, toolCtx);
    expect(result.success).toBe(true);
    const types = readJournal(journalPath).map((e) => e.type);
    expect(types).toEqual(['tool.call', 'policy.decision', 'tool.result']);
  });
});
