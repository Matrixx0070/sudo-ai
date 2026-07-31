/** Run journal write + read roundtrip (ADR-0007). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RunJournal,
  readJournal,
  sha256Hex,
  truncateForJournal,
  JOURNAL_TRUNCATE_BYTES,
} from '../../../src/core/eval/sandbox/run-journal.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-journal-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('RunJournal', () => {
  it('round-trips events through JSONL', () => {
    const p = path.join(dir, 'runs', 'r1', 'journal.jsonl');
    const j = new RunJournal(p);
    j.append({ type: 'run.start', runId: 'r1' });
    j.append({ type: 'prompt', text: 'hello' });
    j.append({ type: 'tool.call', name: 'fs.write', paramsSha256: sha256Hex('{}'), params: '{}' });
    j.append({ type: 'run.end', ok: true, output: 'done' });

    const events = readJournal(p);
    expect(events.map((e) => e.type)).toEqual(['run.start', 'prompt', 'tool.call', 'run.end']);
    expect(events[1]!['text']).toBe('hello');
    expect(events.every((e) => typeof e.ts === 'string' && e.ts.length > 0)).toBe(true);
  });

  it('skips a torn tail line instead of throwing', () => {
    const p = path.join(dir, 'journal.jsonl');
    const j = new RunJournal(p);
    j.append({ type: 'run.start' });
    fs.appendFileSync(p, '{"type":"tool.call","na'); // simulated crash mid-write
    const events = readJournal(p);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('run.start');
  });

  it('readJournal on a missing file returns []', () => {
    expect(readJournal(path.join(dir, 'nope.jsonl'))).toEqual([]);
  });

  it('truncateForJournal caps at 4KB', () => {
    expect(truncateForJournal('x'.repeat(10_000))).toHaveLength(JOURNAL_TRUNCATE_BYTES);
    expect(truncateForJournal('short')).toBe('short');
  });
});
