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

  // -------------------------------------------------------------------------
  // Slice 2: journal + parallel + SHA-256 mismatch on resume
  // -------------------------------------------------------------------------
  describe('on-disk resume journal', () => {
    it('writes <DATA_DIR>/workflow-runs/<runId>.json with sourceSha256 by default', async () => {
      const { registry } = stubRegistry(async () => ({ success: true, output: 'OK' }));
      setWorkflowRegistry(registry);

      const file = writeWorkflow(
        'with-journal.yaml',
        'name: with-journal\nsteps:\n  - id: a\n    command: ok-tool\n    type: tool\n',
      );

      const res = await runWorkflowTool.execute({ file }, ctx);

      expect(res.success).toBe(true);
      expect(res.data?.['runId']).toMatch(/^[0-9a-f-]+$/);
      const journalPath = res.data?.['journalPath'] as string;
      expect(journalPath).toMatch(/workflow-runs[/\\][0-9a-f-]+\.json$/);

      const { readFileSync, existsSync } = await import('fs');
      expect(existsSync(journalPath)).toBe(true);
      const j = JSON.parse(readFileSync(journalPath, 'utf8')) as Record<string, unknown>;
      expect(j['version']).toBe(1);
      expect(j['runId']).toBe(res.data?.['runId']);
      // Full SHA-256 is persisted to disk, but only a 12-char prefix is echoed
      // back in the tool response (the response would otherwise act as a hash
      // oracle for partial-file edits without filesystem access).
      const prefix = res.data?.['sourceSha256Prefix'];
      expect(typeof prefix).toBe('string');
      expect(prefix).toMatch(/^[0-9a-f]{12}$/);
      expect((j['sourceSha256'] as string).startsWith(prefix as string)).toBe(true);
      expect(res.data?.['sourceSha256']).toBeUndefined();
    });

    it('rejects an absolute journal_dir outside DATA_DIR / WORKSPACE_DIR', async () => {
      const { registry } = stubRegistry(async () => ({ success: true, output: 'OK' }));
      setWorkflowRegistry(registry);

      const file = writeWorkflow(
        'oob-jrnl.yaml',
        'name: oob-jrnl\nsteps:\n  - id: a\n    command: ok-tool\n    type: tool\n',
      );

      // /etc is the canonical "obviously not yours" root. The guard refuses
      // before any journal file would be written.
      const res = await runWorkflowTool.execute(
        { file, journal_dir: '/etc' },
        ctx,
      );

      expect(res.success).toBe(false);
      expect(res.output).toContain('must be inside DATA_DIR');
    });

    it('disables the journal when journal_dir is an empty string', async () => {
      const { registry } = stubRegistry(async () => ({ success: true, output: 'OK' }));
      setWorkflowRegistry(registry);

      const file = writeWorkflow(
        'no-journal.yaml',
        'name: no-journal\nsteps:\n  - id: a\n    command: ok-tool\n    type: tool\n',
      );

      const res = await runWorkflowTool.execute({ file, journal_dir: '' }, ctx);
      expect(res.success).toBe(true);
      expect(res.data?.['journalPath']).toBeUndefined();
    });

    it('rejects a relative journal_dir', async () => {
      const { registry } = stubRegistry(async () => ({ success: true, output: 'OK' }));
      setWorkflowRegistry(registry);

      const file = writeWorkflow('rel-jrnl.yaml', 'name: rel-jrnl\nsteps:\n  - id: a\n    command: ok-tool\n    type: tool\n');

      const res = await runWorkflowTool.execute({ file, journal_dir: 'rel/path' }, ctx);
      expect(res.success).toBe(false);
      expect(res.output).toContain('journal_dir must be an absolute path');
    });

    it('refuses resume_run_id when the workflow source SHA changed since pause', async () => {
      const calls: string[] = [];
      const { registry } = stubRegistry(async (name) => {
        calls.push(name);
        return { success: true, output: 'ok' };
      });
      setWorkflowRegistry(registry);

      const sourceA =
        'name: sha-check\nsteps:\n  - id: g1\n    command: ok-tool\n    type: tool\n    approval: true\n  - id: g2\n    command: ok-tool\n    type: tool\n';
      const file = writeWorkflow('sha-check.yaml', sourceA);

      // First call: pauses on the approval gate, writes the journal.
      const first = await runWorkflowTool.execute({ file }, ctx);
      expect(first.data?.['paused']).toBe(true);
      const runId = first.data?.['runId'] as string;
      expect(runId).toBeDefined();
      const journalPath = first.data?.['journalPath'] as string;
      expect(journalPath).toBeDefined();

      // Edit the workflow file — even a benign whitespace change flips the SHA.
      writeFileSync(path.join(workflowsBase, 'sha-check.yaml'), sourceA + '# edited\n', 'utf8');

      // Resume by run id — must refuse.
      const second = await runWorkflowTool.execute(
        { file, resume_run_id: runId, auto_approve: true },
        ctx,
      );
      expect(second.success).toBe(false);
      expect(second.output).toContain('source SHA-256 changed');

      // The edit didn't trigger any new tool dispatches.
      expect(calls.length).toBe(0);
    });

    it('resumes from disk via resume_run_id when the file is unchanged', async () => {
      let calls = 0;
      const { registry } = stubRegistry(async () => {
        calls++;
        return { success: true, output: 'tool-out' };
      });
      setWorkflowRegistry(registry);

      const src =
        'name: resume-ok\nsteps:\n  - id: g\n    command: ok-tool\n    type: tool\n    approval: true\n  - id: after\n    command: ok-tool\n    type: tool\n';
      const file = writeWorkflow('resume-ok.yaml', src);

      const first = await runWorkflowTool.execute({ file }, ctx);
      expect(first.data?.['paused']).toBe(true);
      expect(calls).toBe(0);
      const runId = first.data?.['runId'] as string;

      const second = await runWorkflowTool.execute(
        { file, resume_run_id: runId, auto_approve: true },
        ctx,
      );
      expect(second.success).toBe(true);
      expect(second.data?.['completed']).toBe(true);
      expect(calls).toBe(2);
    });

    it('rejects a malformed resume_run_id', async () => {
      const { registry } = stubRegistry(async () => ({ success: true, output: 'ok' }));
      setWorkflowRegistry(registry);

      const file = writeWorkflow('id-mal.yaml', 'name: id-mal\nsteps:\n  - id: a\n    command: ok-tool\n    type: tool\n');

      const res = await runWorkflowTool.execute(
        { file, resume_run_id: '../escape' },
        ctx,
      );
      expect(res.success).toBe(false);
      expect(res.output).toContain('resume_run_id is malformed');
    });

    it('returns an honest error when resume_run_id has no journal on disk', async () => {
      const { registry } = stubRegistry(async () => ({ success: true, output: 'ok' }));
      setWorkflowRegistry(registry);

      const file = writeWorkflow('miss.yaml', 'name: miss\nsteps:\n  - id: a\n    command: ok-tool\n    type: tool\n');

      const res = await runWorkflowTool.execute(
        { file, resume_run_id: 'never-existed-id' },
        ctx,
      );
      expect(res.success).toBe(false);
      expect(res.output).toContain('no journal at');
    });
  });

  describe('parallel groups (tool-level)', () => {
    it('runs consecutive parallel_group tool steps concurrently', async () => {
      let inFlight = 0;
      let peakInFlight = 0;
      const { registry } = stubRegistry(async (name) => {
        inFlight++;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 25));
        inFlight--;
        return { success: true, output: `out:${name}` };
      });
      setWorkflowRegistry(registry);

      const file = writeWorkflow(
        'parallel-tools.yaml',
        `name: parallel-tools
steps:
  - id: a
    command: alpha
    type: tool
    parallel_group: g
  - id: b
    command: beta
    type: tool
    parallel_group: g
  - id: c
    command: gamma
    type: tool
    parallel_group: g
`,
      );

      const res = await runWorkflowTool.execute({ file }, ctx);

      expect(res.success).toBe(true);
      expect(peakInFlight).toBe(3);
    });

    it('SUDO_WORKFLOWS_MAX_PARALLEL=1 collapses fan-out to sequential', async () => {
      const prev = process.env['SUDO_WORKFLOWS_MAX_PARALLEL'];
      process.env['SUDO_WORKFLOWS_MAX_PARALLEL'] = '1';
      try {
        let inFlight = 0;
        let peakInFlight = 0;
        const { registry } = stubRegistry(async () => {
          inFlight++;
          peakInFlight = Math.max(peakInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 10));
          inFlight--;
          return { success: true, output: 'x' };
        });
        setWorkflowRegistry(registry);

        const file = writeWorkflow(
          'cap-1.yaml',
          `name: cap-1
steps:
  - id: a
    command: t
    type: tool
    parallel_group: g
  - id: b
    command: t
    type: tool
    parallel_group: g
`,
        );

        const res = await runWorkflowTool.execute({ file }, ctx);
        expect(res.success).toBe(true);
        expect(peakInFlight).toBe(1);
      } finally {
        if (prev === undefined) delete process.env['SUDO_WORKFLOWS_MAX_PARALLEL'];
        else process.env['SUDO_WORKFLOWS_MAX_PARALLEL'] = prev;
      }
    });
  });
});
