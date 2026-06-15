/**
 * @file verify-gate-grounding.test.ts
 * Tests for the slice-2 GroundingChecker.
 *
 * Covers every branch in DONE MEANS criterion 1:
 *
 *  VGG-01 no file_path / no old_string         → ok=true,  reason='no-check'
 *  VGG-02 edit-grounding, old_string present   → ok=true,  reason='edit-grounding-ok'
 *  VGG-03 edit-grounding, old_string missing   → ok=false, reason='edit-grounding-fail'
 *  VGG-04 edit-grounding, file missing (ENOENT) → ok=false, reason='file-missing'
 *  VGG-05 edit-grounding, read throws (EACCES) → ok=true,  reason='error'  (fail-open)
 *  VGG-06 file-reference, regular file         → ok=true,  reason='file-ref-ok'
 *  VGG-07 file-reference, missing (ENOENT)     → ok=false, reason='file-missing'
 *  VGG-08 file-reference, dir (not regular)    → ok=false, reason='file-ref-not-regular'
 *  VGG-09 args carry write-content fields      → file-reference skipped, ok=true 'no-check'
 *  VGG-10 alt arg keys (memoryPath / oldString / find / search)
 *  VGG-11 isGroundingBlockEnabled env parsing
 *  VGG-12 checker.check() never throws (top-level try/catch fail-open)
 *
 * All fs handles are injected — no real disk reads.
 */

import { describe, it, expect } from 'vitest';
import {
  GroundingChecker,
  isGroundingBlockEnabled,
} from '../../src/core/agent/verify-gate-grounding.js';

function makeFsStubs(opts: {
  read?: (p: string) => Promise<string>;
  stat?: (p: string) => Promise<{ isFile(): boolean }>;
} = {}): { readFile: (p: string) => Promise<string>; stat: (p: string) => Promise<{ isFile(): boolean }> } {
  return {
    readFile: opts.read ?? (async () => ''),
    stat: opts.stat ?? (async () => ({ isFile: () => true })),
  };
}

function enoent(): NodeJS.ErrnoException {
  const e = new Error('ENOENT: no such file') as NodeJS.ErrnoException;
  e.code = 'ENOENT';
  return e;
}

function eacces(): NodeJS.ErrnoException {
  const e = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
  e.code = 'EACCES';
  return e;
}

describe('GroundingChecker (slice 2: grounding check)', () => {
  it('VGG-01 no file_path / no old_string → no-check', async () => {
    const checker = new GroundingChecker(makeFsStubs());
    const result = await checker.check('meta.tool-install', { name: 'foo', version: '1.2.3' });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('no-check');
    expect(result.checked).toBeUndefined();
  });

  it('VGG-02 edit-grounding, old_string present → edit-grounding-ok', async () => {
    const checker = new GroundingChecker(makeFsStubs({
      read: async () => 'hello world\nfoo bar\n',
    }));
    const result = await checker.check('fs.edit', {
      file_path: '/tmp/x.txt',
      old_string: 'foo bar',
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('edit-grounding-ok');
    expect(result.checked).toBe('edit-grounding');
    expect(result.evidence?.['filePath']).toBe('/tmp/x.txt');
    expect(result.evidence?.['oldStringLen']).toBe(7);
  });

  it('VGG-03 edit-grounding, old_string missing → edit-grounding-fail', async () => {
    const checker = new GroundingChecker(makeFsStubs({
      read: async () => 'completely different content',
    }));
    const result = await checker.check('fs.edit', {
      file_path: '/tmp/x.txt',
      old_string: 'this is not in the file',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('edit-grounding-fail');
    expect(result.checked).toBe('edit-grounding');
  });

  it('VGG-04 edit-grounding, file missing → file-missing', async () => {
    const checker = new GroundingChecker(makeFsStubs({
      read: async () => { throw enoent(); },
    }));
    const result = await checker.check('fs.edit', {
      file_path: '/tmp/missing.txt',
      old_string: 'whatever',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('file-missing');
    expect(result.checked).toBe('edit-grounding');
  });

  it('VGG-05 edit-grounding, read throws EACCES → error (fail-open)', async () => {
    const checker = new GroundingChecker(makeFsStubs({
      read: async () => { throw eacces(); },
    }));
    const result = await checker.check('fs.edit', {
      file_path: '/tmp/locked.txt',
      old_string: 'whatever',
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('error');
  });

  it('VGG-06 file-reference, regular file → file-ref-ok', async () => {
    const checker = new GroundingChecker(makeFsStubs({
      stat: async () => ({ isFile: () => true }),
    }));
    const result = await checker.check('meta.run-workflow', { file: 'workflows/x.yaml' });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('file-ref-ok');
    expect(result.checked).toBe('file-reference-grounding');
    expect(result.evidence?.['filePath']).toBe('workflows/x.yaml');
  });

  it('VGG-07 file-reference, missing → file-missing', async () => {
    const checker = new GroundingChecker(makeFsStubs({
      stat: async () => { throw enoent(); },
    }));
    const result = await checker.check('meta.run-workflow', { file: 'workflows/missing.yaml' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('file-missing');
    expect(result.checked).toBe('file-reference-grounding');
  });

  it('VGG-08 file-reference, directory (not regular file) → file-ref-not-regular', async () => {
    const checker = new GroundingChecker(makeFsStubs({
      stat: async () => ({ isFile: () => false }),
    }));
    const result = await checker.check('meta.memory-consolidate', { memoryPath: '/tmp/some-dir' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('file-ref-not-regular');
  });

  it('VGG-09 args carry write-content (no Write false-alarm) → no-check', async () => {
    const checker = new GroundingChecker(makeFsStubs({
      stat: async () => { throw enoent(); }, // would fail if grounding ran
    }));
    const result = await checker.check('fs.write', {
      file_path: '/tmp/new-file.txt',
      content: 'hello world',
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('no-check');
  });

  it('VGG-10a alt arg key: memoryPath + oldString resolve to edit-grounding', async () => {
    const checker = new GroundingChecker(makeFsStubs({
      read: async () => 'curated text',
    }));
    const result = await checker.check('alt.edit', {
      memoryPath: '/tmp/MEMORY.md',
      oldString: 'curated',
    });
    expect(result.ok).toBe(true);
    expect(result.checked).toBe('edit-grounding');
  });

  it('VGG-10b non-edit keys like `search` do NOT route to edit-grounding', async () => {
    // Regression: an earlier draft accepted `find`/`search` as old-string aliases,
    // which would mis-route web.search/catalog-search calls into edit-grounding
    // and trigger a content-read of the path value.
    const checker = new GroundingChecker(makeFsStubs({
      stat: async () => ({ isFile: () => true }),
    }));
    const result = await checker.check('web.search', {
      path: '/tmp/y.txt',
      search: 'pattern',
    });
    expect(result.checked).toBe('file-reference-grounding');
  });

  it('VGG-11 isGroundingBlockEnabled env parsing', () => {
    expect(isGroundingBlockEnabled({})).toBe(false);
    expect(isGroundingBlockEnabled({ SUDO_VERIFY_GATE_BLOCK: '0' })).toBe(false);
    expect(isGroundingBlockEnabled({ SUDO_VERIFY_GATE_BLOCK: '1' })).toBe(true);
    expect(isGroundingBlockEnabled({ SUDO_VERIFY_GATE_BLOCK: 'true' })).toBe(false); // strict
  });

  it('VGG-12 check() never throws — synchronous fs throw caught by inner editGrounding catch (fail-open)', async () => {
    // Synchronous throws from the injected handle are caught by the inner
    // try/catch in editGrounding / fileReferenceGrounding (NOT the outer
    // catch in check()), but the net effect — ok=true, reason='error' — is
    // identical for the caller. This test pins the fail-open contract.
    const checker = new GroundingChecker({
      readFile: () => { throw new Error('synchronous throw'); },
      stat: () => { throw new Error('synchronous throw'); },
    });
    const result = await checker.check('fs.edit', {
      file_path: '/tmp/x.txt',
      old_string: 'whatever',
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('error');
  });

  it('VGG-13 empty old_string falls through to file-reference grounding', async () => {
    // Empty string is treated as "no old_string supplied" — we don't want to
    // claim "" is present in every file.
    const checker = new GroundingChecker(makeFsStubs({
      stat: async () => ({ isFile: () => true }),
    }));
    const result = await checker.check('fs.edit', {
      file_path: '/tmp/x.txt',
      old_string: '',
    });
    expect(result.ok).toBe(true);
    expect(result.checked).toBe('file-reference-grounding');
  });

  it('VGG-14 non-string old_string is ignored, falls through to file-reference', async () => {
    const checker = new GroundingChecker(makeFsStubs({
      stat: async () => ({ isFile: () => true }),
    }));
    const result = await checker.check('fs.edit', {
      file_path: '/tmp/x.txt',
      old_string: 42 as unknown as string,
    });
    expect(result.ok).toBe(true);
    expect(result.checked).toBe('file-reference-grounding');
  });
});
