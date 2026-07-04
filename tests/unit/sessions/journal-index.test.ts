/**
 * journal-index — corruption must not destroy the session index.
 *
 * Bug: readIndex reset a corrupt sessions.json to empty, and writeIndex then
 * overwrote the corrupt file with `{entries:[]}`, permanently losing every
 * session. Now writeIndex is atomic (temp+rename) and readIndex backs up a
 * corrupt file before resetting.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readIndex, writeIndex } from '../../../src/core/sessions/journal-index.js';
import type { SessionIndex } from '../../../src/core/sessions/journal-types.js';

let dir: string;
let idx: string;
const sample: SessionIndex = { version: 1, entries: [{ id: 's1' } as never, { id: 's2' } as never] };

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'journal-idx-')); idx = join(dir, 'sessions.json'); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('journal-index corruption safety', () => {
  it('round-trips and leaves no temp file (atomic write)', () => {
    writeIndex(idx, sample);
    expect(readIndex(idx).entries).toHaveLength(2);
    expect(existsSync(`${idx}.tmp`)).toBe(false); // temp renamed away
  });

  it('returns an absent index as empty', () => {
    expect(readIndex(idx)).toEqual({ version: 1, entries: [] });
  });

  it('backs up a corrupt (unparseable) sessions.json before resetting', () => {
    writeFileSync(idx, '{ this is NOT valid json ', 'utf8');
    const result = readIndex(idx);
    expect(result.entries).toEqual([]);
    const backups = readdirSync(dir).filter((f) => f.startsWith('sessions.json.corrupt.'));
    expect(backups).toHaveLength(1);
    // The original bytes are preserved in the backup (recoverable), not lost.
    expect(readFileSync(join(dir, backups[0]!), 'utf8')).toContain('NOT valid json');
  });

  it('backs up a structurally-corrupt (entries not array) index', () => {
    writeFileSync(idx, JSON.stringify({ version: 1, entries: 'oops' }), 'utf8');
    expect(readIndex(idx).entries).toEqual([]);
    expect(readdirSync(dir).some((f) => f.startsWith('sessions.json.corrupt.'))).toBe(true);
  });

  it('a corrupt read then a fresh write does NOT clobber the backup (data recoverable)', () => {
    writeFileSync(idx, 'corrupt!!', 'utf8');
    readIndex(idx);                 // backs up + returns empty
    writeIndex(idx, sample);        // fresh write
    const backups = readdirSync(dir).filter((f) => f.startsWith('sessions.json.corrupt.'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dir, backups[0]!), 'utf8')).toBe('corrupt!!');
    expect(readIndex(idx).entries).toHaveLength(2); // new index is intact
  });
});
