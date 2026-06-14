/**
 * Tests for meta.run-workflow (gap #24, slice 1).
 *
 * The tool loads a .yaml workflow confined to the workspace `workflows/` dir, so
 * each test sets a fresh SUDO_AI_HOME and re-imports the module (paths.ts +
 * lobster.ts capture WORKSPACE_DIR at import time — the documented module-load
 * env-capture pattern). All steps are `type: tool` so a stub registry stands in
 * for real tool execution; no child_process is involved.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import type { ToolContext, ToolResult } from '../../src/core/tools/types.js';
import type { ToolRegistry } from '../../src/core/tools/registry.js';

// ---------------------------------------------------------------------------
// Per-test module + env isolation
// ---------------------------------------------------------------------------

let tmpHome: string;
let workflowsBase: string;
let runWorkflowTool: import('../../src/core/tools/types.js').ToolDefinition;
let setWorkflowRegistry: (r: ToolRegistry | null) => void;

/** Build a stub registry whose execute() returns a canned ToolResult. */
function stubRegistry(
  impl: (name: string, args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>,
): { registry: ToolRegistry; execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(impl);
  return { registry: { execute } as unknown as ToolRegistry, execute };
}

const ctx: ToolContext = {
  sessionId: 'test-session',
  workingDir: '/tmp',
  config: {},
  logger: console,
};

/** Write a workflow YAML under the workflows base and return its bare name. */
function writeWorkflow(name: string, body: string): string {
  writeFileSync(path.join(workflowsBase, name), body, 'utf8');
  return name;
}

beforeEach(async () => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), 'wf-home-'));
  process.env['SUDO_AI_HOME'] = tmpHome;
  vi.resetModules();

  const paths = await import('../../src/core/shared/paths.js');
  workflowsBase = path.join(paths.WORKSPACE_DIR, 'workflows');
  mkdirSync(workflowsBase, { recursive: true });

  const mod = await import('../../src/core/tools/builtin/meta/run-workflow.js');
  runWorkflowTool = mod.runWorkflowTool;
  setWorkflowRegistry = mod.setWorkflowRegistry;
});

afterEach(() => {
  delete process.env['SUDO_AI_HOME'];
  rmSync(tmpHome, { recursive: true, force: true });
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('meta.run-workflow', () => {
  it('has the expected trust posture (destructive + requiresConfirmation)', () => {
    expect(runWorkflowTool.name).toBe('meta.run-workflow');
    expect(runWorkflowTool.safety).toBe('destructive');
    expect(runWorkflowTool.requiresConfirmation).toBe(true);
  });

  it('returns an honest error when the registry is not injected', async () => {
    setWorkflowRegistry(null);
    const res = await runWorkflowTool.execute({ file: 'whatever.yaml' }, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toContain('has not been injected');
  });

  it('runs a tool-step workflow end-to-end through registry.execute', async () => {
    const { registry, execute } = stubRegistry(async () => ({ success: true, output: 'TOOL_OK' }));
    setWorkflowRegistry(registry);

    const file = writeWorkflow(
      'wf-ok.yaml',
      `
name: wf-ok
steps:
  - id: fetch
    type: tool
    command: data.fetch
    stdin: '{"q":"hi"}'
`,
    );

    const res = await runWorkflowTool.execute({ file }, ctx);

    expect(res.success).toBe(true);
    expect((res.data as { completed: boolean }).completed).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith('data.fetch', { q: 'hi' }, ctx);
  });

  it('halts and reports failure when a tool step fails', async () => {
    const { registry, execute } = stubRegistry(async () => ({ success: false, output: 'NOPE' }));
    setWorkflowRegistry(registry);

    const file = writeWorkflow(
      'wf-fail.yaml',
      `
name: wf-fail
steps:
  - id: one
    type: tool
    command: data.fetch
  - id: two
    type: tool
    command: data.again
`,
    );

    const res = await runWorkflowTool.execute({ file }, ctx);

    expect(res.success).toBe(false);
    expect((res.data as { failed: boolean }).failed).toBe(true);
    // Second step never dispatched after the first failed.
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('pauses at an approval gate and returns a resume token + run state', async () => {
    const { registry, execute } = stubRegistry(async () => ({ success: true, output: 'OK' }));
    setWorkflowRegistry(registry);

    const file = writeWorkflow(
      'wf-gate.yaml',
      `
name: wf-gate
steps:
  - id: prep
    type: tool
    command: data.prep
  - id: gated
    type: tool
    command: data.go
    approval: true
`,
    );

    const res = await runWorkflowTool.execute({ file }, ctx);

    expect(res.success).toBe(true); // a pause is not an error
    const data = res.data as { paused: boolean; resumeToken?: string; runState: unknown };
    expect(data.paused).toBe(true);
    expect(typeof data.resumeToken).toBe('string');
    expect(res.output).toContain('PAUSED');
    // Only the pre-gate step ran.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith('data.prep', {}, ctx);
  });

  it('auto_approve:true clears the gate and completes', async () => {
    const { registry, execute } = stubRegistry(async () => ({ success: true, output: 'OK' }));
    setWorkflowRegistry(registry);

    const file = writeWorkflow(
      'wf-auto.yaml',
      `
name: wf-auto
steps:
  - id: prep
    type: tool
    command: data.prep
  - id: gated
    type: tool
    command: data.go
    approval: true
`,
    );

    const res = await runWorkflowTool.execute({ file, auto_approve: true }, ctx);

    expect(res.success).toBe(true);
    expect((res.data as { completed: boolean }).completed).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('resumes a paused run via resume_state to completion', async () => {
    const { registry, execute } = stubRegistry(async () => ({ success: true, output: 'OK' }));
    setWorkflowRegistry(registry);

    const file = writeWorkflow(
      'wf-resume.yaml',
      `
name: wf-resume
steps:
  - id: prep
    type: tool
    command: data.prep
  - id: gated
    type: tool
    command: data.go
    approval: true
`,
    );

    const first = await runWorkflowTool.execute({ file }, ctx);
    const runState = (first.data as { runState: unknown }).runState;

    const second = await runWorkflowTool.execute({ file, resume_state: runState }, ctx);

    expect(second.success).toBe(true);
    expect((second.data as { completed: boolean }).completed).toBe(true);
    // prep (first call) + gated (resume) = 2 dispatches total.
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('refuses a self-recursive tool step without dispatching it', async () => {
    const { registry, execute } = stubRegistry(async () => ({ success: true, output: 'OK' }));
    setWorkflowRegistry(registry);

    const file = writeWorkflow(
      'wf-recurse.yaml',
      `
name: wf-recurse
steps:
  - id: loop
    type: tool
    command: meta.run-workflow
`,
    );

    const res = await runWorkflowTool.execute({ file }, ctx);

    expect(res.success).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails honestly on malformed JSON args in a tool step', async () => {
    const { registry, execute } = stubRegistry(async () => ({ success: true, output: 'OK' }));
    setWorkflowRegistry(registry);

    const file = writeWorkflow(
      'wf-badargs.yaml',
      `
name: wf-badargs
steps:
  - id: bad
    type: tool
    command: data.fetch
    stdin: not-json
`,
    );

    const res = await runWorkflowTool.execute({ file }, ctx);

    expect(res.success).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns an honest error for a missing workflow file', async () => {
    const { registry } = stubRegistry(async () => ({ success: true, output: 'OK' }));
    setWorkflowRegistry(registry);

    const res = await runWorkflowTool.execute({ file: 'does-not-exist.yaml' }, ctx);

    expect(res.success).toBe(false);
    expect(res.output).toContain('meta.run-workflow:');
  });

  it('rejects an absolute file outside the workflows base', async () => {
    const { registry } = stubRegistry(async () => ({ success: true, output: 'OK' }));
    setWorkflowRegistry(registry);

    const outside = path.join(tmpHome, 'evil.yaml');
    writeFileSync(outside, 'name: evil\nsteps:\n  - id: x\n    command: echo hi\n', 'utf8');

    const res = await runWorkflowTool.execute({ file: outside }, ctx);

    expect(res.success).toBe(false);
    expect(res.output).toContain('outside the allowed base directory');
  });

  it('rejects an invalid resume_state before loading the file', async () => {
    const { registry } = stubRegistry(async () => ({ success: true, output: 'OK' }));
    setWorkflowRegistry(registry);

    const res = await runWorkflowTool.execute(
      { file: 'irrelevant.yaml', resume_state: { not: 'a state' } },
      ctx,
    );

    expect(res.success).toBe(false);
    expect(res.output).toContain('not a valid workflow run state');
  });
});
