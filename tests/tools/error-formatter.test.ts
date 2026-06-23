/**
 * @file error-formatter.test.ts
 * @description Locks in the structured tool-error hints. Each rule is keyed to a
 * REAL error string SUDO's tools emit, so these tests double as a guard that the
 * rules keep matching production errors. The biggest win is the wrong-tool-target
 * case (coder/sandbox vs the real repo) — the #1 way weaker models get stuck.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  classifyToolError,
  formatToolErrorHint,
  enrichToolError,
  isToolErrorHintsEnabled,
} from '../../src/core/tools/error-formatter.js';

afterEach(() => {
  delete process.env['SUDO_TOOL_ERROR_HINTS'];
});

describe('classifyToolError — real error strings → actionable hints', () => {
  it('path traversal → point to meta.self-modify for repo files', () => {
    const h = classifyToolError('coder.read-file', 'Path traversal blocked: src/core/agent/loop.ts');
    expect(h.fix).toContain('meta.self-modify');
    expect(h.example).toContain('meta.self-modify');
  });

  it('"resolves outside working directory" → same wrong-target rule', () => {
    const h = classifyToolError('coder.write-file', 'Path traversal blocked: /x resolves outside working directory');
    expect(h.why.toLowerCase()).toContain('workspace');
  });

  it('shell metacharacters → repo-exec plain-command guidance', () => {
    const h = classifyToolError('system.exec', 'shell metacharacters are not allowed in repo-exec');
    expect(h.fix.toLowerCase()).toContain('single plain command');
  });

  it('not repo-allowlisted → lists allowlisted commands', () => {
    const h = classifyToolError('system.exec', "'curl' is not a repo-allowlisted command");
    expect(h.fix).toMatch(/pnpm|git|rg/);
  });

  it('edit mismatch → re-read and copy verbatim', () => {
    const h = classifyToolError('meta.self-modify', 'Text not found in src/x.ts:\n  foo()');
    expect(h.fix.toLowerCase()).toContain('verbatim');
  });

  it('file not found → search/confirm path', () => {
    const h = classifyToolError('meta.self-modify', 'File not found: /root/sudo-ai-v4/src/x.ts');
    expect(h.what.toLowerCase()).toContain('does not exist');
  });

  it('tool_not_found → use tool.search', () => {
    const h = classifyToolError('frobnicate', 'tool_not_found: frobnicate');
    expect(h.fix).toContain('tool.search');
  });

  it('approval/veto → state intent, do not repeat', () => {
    const h = classifyToolError('system.exec', 'Command requires approval');
    expect(h.why.toLowerCase()).toContain('gated');
  });

  it('bad arguments → check schema', () => {
    const h = classifyToolError('browser.navigate', 'missing required parameter: url');
    expect(h.what.toLowerCase()).toContain('argument');
  });

  it('unknown error → generic recovery nudge', () => {
    const h = classifyToolError('whatever', 'ETIMEDOUT after 30000ms');
    expect(h.fix).toContain('change ONE thing');
  });

  it('never throws on degenerate input', () => {
    expect(() => classifyToolError('', '')).not.toThrow();
    // @ts-expect-error — deliberately wrong type at the boundary
    expect(() => classifyToolError(undefined, undefined)).not.toThrow();
  });
});

describe('rendering', () => {
  it('formatToolErrorHint emits What/Why/Fix and Example when present', () => {
    const block = formatToolErrorHint({ what: 'W', why: 'Y', fix: 'F', example: 'E' });
    expect(block).toContain('What: W');
    expect(block).toContain('Why: Y');
    expect(block).toContain('Fix: F');
    expect(block).toContain('Example: E');
    expect(block).toContain('How to fix this');
  });

  it('omits the Example line when absent', () => {
    const block = formatToolErrorHint({ what: 'W', why: 'Y', fix: 'F' });
    expect(block).not.toContain('Example:');
  });

  it('enrichToolError returns a ready-to-append block', () => {
    const block = enrichToolError('coder.read-file', 'Path traversal blocked: x');
    expect(block).toContain('How to fix this');
    expect(block).toContain('meta.self-modify');
  });
});

describe('isToolErrorHintsEnabled — default on, kill-switch off', () => {
  it('is on by default', () => {
    expect(isToolErrorHintsEnabled()).toBe(true);
  });
  it('is off when SUDO_TOOL_ERROR_HINTS=0', () => {
    process.env['SUDO_TOOL_ERROR_HINTS'] = '0';
    expect(isToolErrorHintsEnabled()).toBe(false);
  });
});
