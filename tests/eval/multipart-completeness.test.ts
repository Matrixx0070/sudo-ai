/**
 * Tests for the multipart-completeness agent bench task (distilled from the
 * 2026-07-24 dropped-sub-task prod incident) and the matching Operating
 * Principles rule in the system prompt.
 *
 * Covers:
 *   - Verifier passes only when BOTH artifacts are correct
 *   - A missing first-line.txt (the dropped sub-task) scores 0.5 / fails,
 *     with a detail string naming the drop
 *   - Quoted and unquoted top3 renderings both accepted
 *   - Task is registered in the canonical suite
 *   - System prompt carries the COVER-EVERY-PART rule in the static prefix
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { multipartCompletenessTask, ALL_AGENT_TASKS } from '../../src/core/eval/agent-tasks/index.js';

async function makeWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'multipart-'));
  await multipartCompletenessTask.setupWorkspace(dir);
  return dir;
}

const GOOD_TOP3 = '"O\'Neil, Pat",92\nBob,87\nEve,78\n';
const GOOD_FIRST = 'checksum: aurora-9174-verbatim\n';

describe('multipartCompletenessTask', () => {
  it('passes with score 1 when both artifacts are correct', async () => {
    const dir = await makeWorkspace();
    await fs.writeFile(path.join(dir, 'top3.txt'), GOOD_TOP3);
    await fs.writeFile(path.join(dir, 'first-line.txt'), GOOD_FIRST);
    const res = await multipartCompletenessTask.verifyWorkspace(dir);
    expect(res.passed).toBe(true);
    expect(res.score).toBe(1);
  });

  it('accepts the unquoted rendering of the comma-bearing name', async () => {
    const dir = await makeWorkspace();
    await fs.writeFile(path.join(dir, 'top3.txt'), "O'Neil, Pat,92\nBob,87\nEve,78\n");
    await fs.writeFile(path.join(dir, 'first-line.txt'), GOOD_FIRST);
    const res = await multipartCompletenessTask.verifyWorkspace(dir);
    expect(res.passed).toBe(true);
  });

  it('FAILS at 0.5 when part 2 is silently dropped (the incident shape)', async () => {
    const dir = await makeWorkspace();
    await fs.writeFile(path.join(dir, 'top3.txt'), GOOD_TOP3);
    const res = await multipartCompletenessTask.verifyWorkspace(dir);
    expect(res.passed).toBe(false);
    expect(res.score).toBe(0.5);
    expect(res.detail).toContain('dropped sub-task');
  });

  it('scores 0 on an untouched workspace', async () => {
    const dir = await makeWorkspace();
    const res = await multipartCompletenessTask.verifyWorkspace(dir);
    expect(res.passed).toBe(false);
    expect(res.score).toBe(0);
  });

  it('is registered in the canonical agent task suite', () => {
    expect(ALL_AGENT_TASKS.some(t => t.id === 'multipart-completeness')).toBe(true);
  });
});

describe('system prompt completeness rule', () => {
  it('Operating Principles carries the COVER EVERY PART rule', async () => {
    const src = await fs.readFile(
      path.resolve(__dirname, '../../src/core/brain/system-prompt.ts'), 'utf8',
    );
    expect(src).toContain('COVER EVERY PART');
    expect(src).toContain('never justifies silently dropping');
  });
});
