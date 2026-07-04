/**
 * writeFileAtomic — a torn write must never leave a truncated target. Verifies
 * round-trip, secret-file mode preservation, no leftover temp, and that an
 * overwrite replaces atomically (previous content fully gone, no partial state).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '../../../src/core/shared/atomic-write.js';

let dir: string;
let file: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'atomic-')); file = join(dir, 'store.json'); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('writeFileAtomic', () => {
  it('writes the data and leaves no temp file behind', () => {
    writeFileAtomic(file, '{"a":1}');
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}');
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it('creates a secret file with the requested restrictive mode', () => {
    writeFileAtomic(file, 'secret-token', { mode: 0o600 });
    // Low 9 permission bits should be rw------- (0o600).
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('overwrites atomically — the new content fully replaces the old', () => {
    writeFileAtomic(file, 'old-value-that-is-longer');
    writeFileAtomic(file, 'new');
    expect(readFileSync(file, 'utf8')).toBe('new'); // no trailing bytes from the old
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
});
