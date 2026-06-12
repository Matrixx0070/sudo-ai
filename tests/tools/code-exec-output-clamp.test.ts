/**
 * @file tests/tools/code-exec-output-clamp.test.ts
 * @description code.js-exec model-facing output must be clamped head+tail
 * (clampToolOutput, 8000-char budget) instead of returning unbounded stdout.
 * Mirrors the system.exec truncation discipline.
 *
 * python-exec's clamp path is the same clampToolOutput call but is not
 * integration-tested here: it requires a Docker daemon, which CI lacks.
 * Its budget math is covered by the clampToolOutput unit tests.
 */

import { describe, it, expect } from 'vitest';
import { jsExecTool } from '../../src/core/tools/builtin/code/tools/js-exec.js';
import type { ToolContext } from '../../src/core/tools/types.js';

function ctx(sessionId: string): ToolContext {
  return {
    sessionId,
    workingDir: process.cwd(),
    config: {},
    logger: console,
  };
}

describe('code.js-exec output clamping', () => {
  it('JX-1: clamps huge stdout to head+tail with an elision marker', async () => {
    const result = await jsExecTool.execute(
      // ~100k chars of stdout with distinct head and tail sentinels
      { code: 'console.log("HEAD_SENTINEL"); for (let i = 0; i < 1000; i++) console.log("x".repeat(100)); console.log("TAIL_SENTINEL");' },
      ctx('clamp-test-big'),
    );
    expect(result.output.length).toBeLessThan(8_200);
    expect(result.output).toContain('HEAD_SENTINEL');
    expect(result.output).toContain('TAIL_SENTINEL');
    expect(result.output).toContain('total chars');
    expect((result.data as { truncated: boolean }).truncated).toBe(true);
  }, 30_000);

  it('JX-2: small output passes through unclamped', async () => {
    const result = await jsExecTool.execute(
      { code: 'console.log("small output")' },
      ctx('clamp-test-small'),
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('small output');
    expect(result.output).not.toContain('total chars');
    expect((result.data as { truncated: boolean }).truncated).toBe(false);
  }, 30_000);
});
