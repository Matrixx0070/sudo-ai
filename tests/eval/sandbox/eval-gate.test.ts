/** Eval-sandbox tool gate (ADR-0007): inactive no-op, deny/allow-list, fault injection, fail-open. */
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

function ctx(policy: EvalRunContext['policy'], faults?: EvalRunContext['faults']): EvalRunContext {
  return {
    runId: 'test-run',
    policy,
    journal: new RunJournal(journalPath),
    ...(faults !== undefined ? { faults } : {}),
  };
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
  it('no active run → allow, zero journal writes', async () => {
    deactivateEvalGate();
    expect(await evalGateBeforeTool('system.exec', { command: 'ls' })).toEqual({ action: 'allow' });
    evalGateAfterTool('system.exec', { success: true, output: 'x' });
    expect(fs.existsSync(journalPath)).toBe(false);
  });

  it('SUDO_EVAL unset → allow even with an active run, zero journal writes', async () => {
    delete process.env['SUDO_EVAL'];
    activateEvalGate(ctx({ tools: { deny: ['system.exec'] } }));
    expect(await evalGateBeforeTool('system.exec', {})).toEqual({ action: 'allow' });
    expect(fs.existsSync(journalPath)).toBe(false);
  });

  it('deny rule matches exact name and journals the decision', async () => {
    activateEvalGate(ctx({ tools: { deny: ['system.exec'] } }));
    const d = await evalGateBeforeTool('system.exec', { command: 'rm -rf /' });
    expect(d.action).toBe('deny');

    const events = readJournal(journalPath);
    expect(events.map((e) => e.type)).toEqual(['tool.call', 'policy.decision']);
    expect(events[1]!['action']).toBe('deny');
    expect(events[1]!['rule']).toBe('deny:system.exec');
  });

  it('deny rule supports namespace globs', async () => {
    activateEvalGate(ctx({ tools: { deny: ['system.*'] } }));
    expect((await evalGateBeforeTool('system.api-call', {})).action).toBe('deny');
    expect((await evalGateBeforeTool('coder.write-file', {})).action).toBe('allow');
  });

  it('allow list present → anything not on it is denied', async () => {
    activateEvalGate(ctx({ tools: { allow: ['coder.*', 'fs.stat'] } }));
    expect((await evalGateBeforeTool('coder.read-file', {})).action).toBe('allow');
    expect((await evalGateBeforeTool('fs.stat', {})).action).toBe('allow');
    expect((await evalGateBeforeTool('system.exec', {})).action).toBe('deny');
  });

  it('deny list wins over allow list', async () => {
    activateEvalGate(ctx({ tools: { allow: ['system.*'], deny: ['system.exec'] } }));
    expect((await evalGateBeforeTool('system.exec', {})).action).toBe('deny');
  });

  it('internal error → fail-open allow', async () => {
    const throwingPolicy = {
      get tools(): never { throw new Error('boom'); },
    } as unknown as EvalRunContext['policy'];
    activateEvalGate(ctx(throwingPolicy));
    expect(await evalGateBeforeTool('system.exec', {})).toEqual({ action: 'allow' });
  });

  it('journal failure never changes the decision', async () => {
    const brokenJournal = { append(): never { throw new Error('disk full'); } } as unknown as RunJournal;
    activateEvalGate({ runId: 'r', policy: { tools: { deny: ['system.exec'] } }, journal: brokenJournal });
    expect((await evalGateBeforeTool('system.exec', {})).action).toBe('deny');
    expect((await evalGateBeforeTool('coder.read-file', {})).action).toBe('allow');
  });

  it('journals tool.call with params sha + truncation', async () => {
    activateEvalGate(ctx({}));
    const big = 'y'.repeat(10_000);
    await evalGateBeforeTool('coder.write-file', { content: big });
    const events = readJournal(journalPath);
    const call = events.find((e) => e.type === 'tool.call')!;
    expect(String(call['paramsSha256'])).toMatch(/^[0-9a-f]{64}$/);
    expect(String(call['params']).length).toBeLessThanOrEqual(4096);
  });
});

describe('deny-rule DSL — { tool, whenParamsMatch }', () => {
  it('denies only when the JSON-serialized params match the regex', async () => {
    activateEvalGate(ctx({
      tools: { deny: [{ tool: 'system.exec', whenParamsMatch: 'rm\\s+-rf' }] },
    }));
    expect((await evalGateBeforeTool('system.exec', { command: 'rm -rf /' })).action).toBe('deny');
    expect((await evalGateBeforeTool('system.exec', { command: 'ls -la' })).action).toBe('allow');
  });

  it('conditional rule still honours tool-name globs', async () => {
    activateEvalGate(ctx({
      tools: { deny: [{ tool: 'system.*', whenParamsMatch: 'secret' }] },
    }));
    expect((await evalGateBeforeTool('system.api-call', { url: 'https://x/secret' })).action).toBe('deny');
    expect((await evalGateBeforeTool('coder.read-file', { path: 'secret.txt' })).action).toBe('allow');
  });

  it('malformed regex never denies (fail-open)', async () => {
    activateEvalGate(ctx({
      tools: { deny: [{ tool: 'system.exec', whenParamsMatch: '(' }] },
    }));
    expect((await evalGateBeforeTool('system.exec', { command: 'ls' })).action).toBe('allow');
  });

  it('plain strings and conditional rules mix (backward compat)', async () => {
    activateEvalGate(ctx({
      tools: { deny: ['fs.delete', { tool: 'system.exec', whenParamsMatch: 'curl' }] },
    }));
    expect((await evalGateBeforeTool('fs.delete', { path: 'x' })).action).toBe('deny');
    expect((await evalGateBeforeTool('system.exec', { command: 'curl http://x' })).action).toBe('deny');
    expect((await evalGateBeforeTool('system.exec', { command: 'echo hi' })).action).toBe('allow');
    const denies = readJournal(journalPath).filter(
      (e) => e.type === 'policy.decision' && e['action'] === 'deny',
    );
    expect(denies.map((e) => e['rule'])).toEqual(['deny:fs.delete', 'deny:system.exec~/curl/']);
  });
});

describe('fault injection', () => {
  it('deny fault blocks the call and journals fault.injected', async () => {
    activateEvalGate(ctx({}, [{ tool: 'system.api-call', kind: 'deny' }]));
    const d = await evalGateBeforeTool('system.api-call', { url: 'http://x' });
    expect(d.action).toBe('deny');
    if (d.action === 'deny') expect(d.reason).toContain('injected fault');

    const events = readJournal(journalPath);
    const fault = events.find((e) => e.type === 'fault.injected')!;
    expect(fault['kind']).toBe('deny');
    expect(fault['name']).toBe('system.api-call');
    // the policy decision itself stays allow — an injected fault is not a
    // policy violation by the agent (deniedToolAttempts must not count it)
    expect(events.find((e) => e.type === 'policy.decision')!['action']).toBe('allow');
  });

  it('error fault returns an error decision with the configured message', async () => {
    activateEvalGate(ctx({}, [{ tool: 'system.api-call', kind: 'error', errorMessage: 'HTTP 503 from upstream' }]));
    const d = await evalGateBeforeTool('system.api-call', {});
    expect(d).toEqual({ action: 'error', message: 'HTTP 503 from upstream' });
  });

  it('delay fault sleeps then allows', async () => {
    activateEvalGate(ctx({}, [{ tool: 'coder.read-file', kind: 'delay', delayMs: 120 }]));
    const t0 = Date.now();
    const d = await evalGateBeforeTool('coder.read-file', {});
    expect(d.action).toBe('allow');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    expect(readJournal(journalPath).some((e) => e.type === 'fault.injected' && e['kind'] === 'delay')).toBe(true);
  });

  it('afterNCalls skips the first N matching calls', async () => {
    activateEvalGate(ctx({}, [{ tool: 'system.api-call', kind: 'deny', afterNCalls: 2 }]));
    expect((await evalGateBeforeTool('system.api-call', {})).action).toBe('allow');
    expect((await evalGateBeforeTool('system.api-call', {})).action).toBe('allow');
    expect((await evalGateBeforeTool('system.api-call', {})).action).toBe('deny');
  });

  it('count caps total injections', async () => {
    activateEvalGate(ctx({}, [{ tool: 'system.api-call', kind: 'error', count: 2 }]));
    expect((await evalGateBeforeTool('system.api-call', {})).action).toBe('error');
    expect((await evalGateBeforeTool('system.api-call', {})).action).toBe('error');
    expect((await evalGateBeforeTool('system.api-call', {})).action).toBe('allow');
    expect(readJournal(journalPath).filter((e) => e.type === 'fault.injected')).toHaveLength(2);
  });

  it('counters are per-tool: a non-matching tool is untouched', async () => {
    activateEvalGate(ctx({}, [{ tool: 'system.api-call', kind: 'deny' }]));
    expect((await evalGateBeforeTool('coder.read-file', {})).action).toBe('allow');
    expect((await evalGateBeforeTool('system.api-call', {})).action).toBe('deny');
  });

  it('activateEvalGate resets fault counters for a new run', async () => {
    activateEvalGate(ctx({}, [{ tool: 'system.api-call', kind: 'deny', count: 1 }]));
    expect((await evalGateBeforeTool('system.api-call', {})).action).toBe('deny');
    expect((await evalGateBeforeTool('system.api-call', {})).action).toBe('allow');
    activateEvalGate(ctx({}, [{ tool: 'system.api-call', kind: 'deny', count: 1 }]));
    expect((await evalGateBeforeTool('system.api-call', {})).action).toBe('deny');
  });

  it('corrupt fault replaces a successful result output (afterNCalls honoured)', () => {
    activateEvalGate(ctx({}, [{ tool: 'system.api-call', kind: 'corrupt', afterNCalls: 1, corruptWith: 'GARBAGE' }]));
    const first = evalGateAfterTool('system.api-call', { success: true, output: 'real-1' });
    expect(first.output).toBe('real-1');
    const second = evalGateAfterTool('system.api-call', { success: true, output: 'real-2' });
    expect(second.output).toBe('GARBAGE');
    expect(second.success).toBe(true);
    // the journal records what the agent actually saw
    const results = readJournal(journalPath).filter((e) => e.type === 'tool.result');
    expect(results.map((e) => e['output'])).toEqual(['real-1', 'GARBAGE']);
  });

  it('corrupt fault leaves failed results alone', () => {
    activateEvalGate(ctx({}, [{ tool: 'system.api-call', kind: 'corrupt', corruptWith: 'GARBAGE' }]));
    const r = evalGateAfterTool('system.api-call', { success: false, output: 'boom' });
    expect(r.output).toBe('boom');
    expect(readJournal(journalPath).some((e) => e.type === 'fault.injected')).toBe(false);
  });
});

describe('evalGateAfterTool', () => {
  it('journals tool.result when active and returns the result unchanged', () => {
    activateEvalGate(ctx({}));
    const r = evalGateAfterTool('coder.read-file', { success: true, output: 'file body' });
    expect(r).toEqual({ success: true, output: 'file body' });
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

  it('error fault surfaces as a failed ToolResult without running the tool', async () => {
    let ran = false;
    const registry = new ToolRegistry();
    registry.register({
      ...echoTool(),
      execute: async () => { ran = true; return { success: true, output: 'x' }; },
    } as ToolDefinition);
    activateEvalGate(ctx({}, [{ tool: 'demo.echo', kind: 'error', errorMessage: 'fault: upstream down' }]));

    const result = await registry.execute('demo.echo', { input: 'hi' }, toolCtx);
    expect(result.success).toBe(false);
    expect(result.output).toBe('fault: upstream down');
    expect(ran).toBe(false);
  });

  it('corrupt fault replaces the output the caller receives', async () => {
    const registry = new ToolRegistry();
    registry.register(echoTool());
    activateEvalGate(ctx({}, [{ tool: 'demo.echo', kind: 'corrupt', corruptWith: '<<corrupted>>' }]));

    const result = await registry.execute('demo.echo', { input: 'hi' }, toolCtx);
    expect(result.success).toBe(true);
    expect(result.output).toBe('<<corrupted>>');
  });
});
