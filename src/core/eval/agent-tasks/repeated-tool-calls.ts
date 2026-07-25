/**
 * @file repeated-tool-calls.ts
 * @description Doom-loop false-positive regression guard (the #438 class).
 * The task REQUIRES many consecutive calls of the same tool with DIFFERENT
 * arguments (read six part files, then combine). The doom-loop detector keys
 * on tool+argsSignature, so legitimate different-args repetition must never
 * trip it; a regression that loosens the signature to tool-name-only would
 * abort this run and fail the task.
 *
 * Exercises: same-tool different-args repetition staying below the doom-loop.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentBenchTask } from '../agent-bench-types.js';

const PARTS: ReadonlyArray<readonly [string, string]> = [
  ['part-a.txt', 'the'],
  ['part-b.txt', 'quick'],
  ['part-c.txt', 'brown'],
  ['part-d.txt', 'fox'],
  ['part-e.txt', 'jumps'],
  ['part-f.txt', 'high'],
];

const EXPECTED = PARTS.map(([, word]) => word).join(' ');

export const repeatedToolCallsTask: AgentBenchTask = {
  id: 'repeated-tool-calls',
  name: 'Six same-tool different-args reads must not trip the doom-loop',
  async setupWorkspace(workspaceDir: string): Promise<void> {
    for (const [file, word] of PARTS) {
      await fs.writeFile(path.join(workspaceDir, file), `${word}\n`, 'utf8');
    }
  },
  prompt: [
    'In {workspace}: read part-a.txt through part-f.txt ONE FILE AT A TIME',
    '(do not glob or batch them), then write the six words joined by single',
    'spaces, in alphabetical file order, to sentence.txt as one line.',
  ].join(' '),
  async verifyWorkspace(workspaceDir: string) {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(workspaceDir, 'sentence.txt'), 'utf8');
    } catch {
      return {
        passed: false,
        score: 0,
        detail: 'sentence.txt missing — run likely aborted mid-repetition (doom-loop FP class)',
        type: 'workspace-files',
      };
    }
    const got = raw.trim();
    return got === EXPECTED
      ? { passed: true, score: 1, detail: 'all six parts read and combined', type: 'workspace-files' }
      : { passed: false, score: 0, detail: `expected "${EXPECTED}", got "${got.slice(0, 80)}"`, type: 'workspace-files' };
  },
};
