/**
 * @file multipart-completeness.ts
 * @description Agent gets a TWO-part request where part 1 is deliberately
 * awkward (malformed CSV that defeats a naive first parse) and part 2 is
 * trivial but trails the hard part. Distilled from a real 2026-07-24 prod
 * failure: asked to scrape Hacker News AND check example.com's h1, the agent
 * burned its loop recovering from extraction failures, answered part 1, and
 * silently dropped part 2 (no attempt, no acknowledgment).
 *
 * The agent must:
 *   1. Parse data.csv (junk banner line + quoted comma in a name field) and
 *      write the top 3 rows by score to top3.txt as "name,score" lines,
 *      highest first.
 *   2. ALSO read notes.txt and copy its FIRST line verbatim to first-line.txt.
 *
 * Held-out verification checks BOTH artifacts; part 2 existing at all is the
 * dropped-sub-task regression signal. Scored 0.5 per part, passed only when
 * both are correct.
 *
 * Exercises: multi-part instruction retention through tool churn.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentBenchTask } from '../agent-bench-types.js';

// Junk banner + quoted comma make the first naive split-on-comma attempt fail
// or mis-rank, forcing at least one recovery step before part 1 succeeds.
const DATA_CSV = `# EXPORT v2 -- DO NOT EDIT -- generated 2026-07-24
name,score
"Rivera, Ana",41
Bob,87
Chen,63
"O'Neil, Pat",92
Dana,55
Eve,78
`;

const NOTES_TXT = `checksum: aurora-9174-verbatim
second line is a decoy — only the first line matters.
`;

const EXPECTED_TOP3 = ['"O\'Neil, Pat",92', 'Bob,87', 'Eve,78'];
const EXPECTED_FIRST_LINE = 'checksum: aurora-9174-verbatim';

export const multipartCompletenessTask: AgentBenchTask = {
  id: 'multipart-completeness',
  name: 'Multi-part request: awkward CSV top-3 THEN notes first line',
  async setupWorkspace(workspaceDir: string): Promise<void> {
    await fs.writeFile(path.join(workspaceDir, 'data.csv'), DATA_CSV, 'utf8');
    await fs.writeFile(path.join(workspaceDir, 'notes.txt'), NOTES_TXT, 'utf8');
  },
  prompt: [
    'In {workspace}: first, parse data.csv (careful: it has a junk banner line and',
    'quoted names containing commas) and write the top 3 rows by score to top3.txt,',
    'one "name,score" per line, highest score first, names exactly as in the CSV.',
    'Then ALSO read notes.txt and write its first line, verbatim, to first-line.txt.',
    'Both files are required.',
  ].join(' '),
  async verifyWorkspace(workspaceDir: string) {
    const read = async (f: string): Promise<string | null> =>
      fs.readFile(path.join(workspaceDir, f), 'utf8').then(s => s, () => null);

    const top3Raw = await read('top3.txt');
    const firstRaw = await read('first-line.txt');

    const top3Ok =
      top3Raw !== null &&
      (() => {
        const lines = top3Raw.trim().split('\n').map(l => l.trim());
        if (lines.length !== 3) return false;
        // Accept quoted or unquoted rendering of the comma-bearing name: no
        // fixture name contains a literal double quote, so compare quote-free.
        const norm = (l: string): string => l.replace(/"/g, '');
        return lines.every((l, i) => norm(l) === norm(EXPECTED_TOP3[i]!));
      })();
    const firstOk = firstRaw !== null && firstRaw.trim() === EXPECTED_FIRST_LINE;

    const score = (top3Ok ? 0.5 : 0) + (firstOk ? 0.5 : 0);
    const parts = [
      `part1 top3.txt: ${top3Raw === null ? 'MISSING' : top3Ok ? 'correct' : 'wrong content'}`,
      `part2 first-line.txt: ${firstRaw === null ? 'MISSING (dropped sub-task)' : firstOk ? 'correct' : 'wrong content'}`,
    ];
    return { passed: score === 1, score, detail: parts.join('; '), type: 'workspace-files' };
  },
  timeoutMs: 180_000,
  maxIterations: 30,
};
