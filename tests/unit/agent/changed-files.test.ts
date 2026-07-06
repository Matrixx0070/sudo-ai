/**
 * @file tests/unit/agent/changed-files.test.ts
 * @description Tests for extractChangedFiles — the change-set feed for
 *   post-run self-verification.
 */

import { describe, it, expect } from 'vitest';
import { extractChangedFiles, FILE_MUTATING_TOOLS } from '../../../src/core/agent/changed-files.js';

describe('extractChangedFiles', () => {
  it('extracts path from write-file and edit-file', () => {
    expect(extractChangedFiles('coder.write-file', { path: '/w/a.ts', content: 'x' })).toEqual(['/w/a.ts']);
    expect(extractChangedFiles('coder.edit-file', { path: 'src/b.ts', oldText: 'a', newText: 'b' })).toEqual(['src/b.ts']);
  });

  it('extracts file from notebook-edit', () => {
    expect(extractChangedFiles('coder.notebook-edit', { file: 'nb.ipynb' })).toEqual(['nb.ipynb']);
  });

  it('extracts file fields from apply-patch operations and multi-edit edits', () => {
    expect(extractChangedFiles('coder.apply-patch', {
      operations: [{ file: 'a.ts', search: 'x', replace: 'y' }, { file: 'b.ts', search: 'p', replace: 'q' }],
    })).toEqual(['a.ts', 'b.ts']);
    expect(extractChangedFiles('coder.multi-edit', {
      edits: [{ file: 'c.ts', old_string: 'x', new_string: 'y' }],
    })).toEqual(['c.ts']);
  });

  it('returns [] for non-mutating tools and malformed args', () => {
    expect(extractChangedFiles('coder.read-file', { path: '/w/a.ts' })).toEqual([]);
    expect(extractChangedFiles('system.exec', { command: 'rm -rf /' })).toEqual([]);
    expect(extractChangedFiles('coder.write-file', {})).toEqual([]);
    expect(extractChangedFiles('coder.write-file', { path: '   ' })).toEqual([]);
    expect(extractChangedFiles('coder.apply-patch', { operations: 'not-an-array' })).toEqual([]);
    expect(extractChangedFiles('coder.multi-edit', { edits: [{ notfile: 1 }, null] })).toEqual([]);
  });

  it('FILE_MUTATING_TOOLS covers exactly the write/edit surface', () => {
    expect([...FILE_MUTATING_TOOLS].sort()).toEqual([
      'coder.apply-patch', 'coder.edit-file', 'coder.multi-edit',
      'coder.notebook-edit', 'coder.write-file',
    ]);
  });
});
