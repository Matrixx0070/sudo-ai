/**
 * Tests for tool-translator.ts — canonical ↔ SUDO-AI name mapping.
 */

import { describe, it, expect } from 'vitest';
import {
  translate,
  translateAll,
  translateMany,
  isKnownCanonical,
} from '../../src/core/skills/tool-translator.js';

describe('translate()', () => {
  it('translates Bash to system.shell', () => {
    const entry = translate('Bash');
    expect(entry).not.toBeNull();
    expect(entry!.sudoName).toBe('system.shell');
  });

  it('translates Read to coder.read-file', () => {
    const entry = translate('Read');
    expect(entry).not.toBeNull();
    expect(entry!.sudoName).toBe('coder.read-file');
  });

  it('translates Write to coder.write-file', () => {
    const entry = translate('Write');
    expect(entry).not.toBeNull();
    expect(entry!.sudoName).toBe('coder.write-file');
  });

  it('translates Edit to coder.edit-file', () => {
    const entry = translate('Edit');
    expect(entry).not.toBeNull();
    expect(entry!.sudoName).toBe('coder.edit-file');
  });

  it('translates Grep to coder.grep', () => {
    const entry = translate('Grep');
    expect(entry).not.toBeNull();
    expect(entry!.sudoName).toBe('coder.grep');
  });

  it('translates Glob to coder.glob', () => {
    const entry = translate('Glob');
    expect(entry).not.toBeNull();
    expect(entry!.sudoName).toBe('coder.glob');
  });

  it('translates WebFetch to system.web-fetch', () => {
    const entry = translate('WebFetch');
    expect(entry).not.toBeNull();
    expect(entry!.sudoName).toBe('system.web-fetch');
  });

  it('returns null for unknown canonical', () => {
    expect(translate('UnknownTool')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(translate('')).toBeNull();
  });

  it('is case-sensitive (bash lowercase returns null)', () => {
    expect(translate('bash')).toBeNull();
  });
});

describe('translate() paramMap', () => {
  it('Bash has command → cmd mapping', () => {
    const entry = translate('Bash');
    expect(entry!.paramMap).toMatchObject({ command: 'cmd' });
  });

  it('Read has file_path → path mapping', () => {
    const entry = translate('Read');
    expect(entry!.paramMap).toMatchObject({ file_path: 'path' });
  });

  it('Edit has old_string → old and new_string → new', () => {
    const entry = translate('Edit');
    expect(entry!.paramMap).toMatchObject({ old_string: 'old', new_string: 'new' });
  });

  it('WebFetch has url → url mapping', () => {
    const entry = translate('WebFetch');
    expect(entry!.paramMap).toMatchObject({ url: 'url' });
  });
});

describe('translateAll()', () => {
  it('returns exactly 7 entries', () => {
    const table = translateAll();
    expect(table).toHaveLength(7);
  });

  it('contains all 7 canonical names', () => {
    const table = translateAll();
    const canonicals = table.map((e) => e.canonical);
    expect(canonicals).toContain('Bash');
    expect(canonicals).toContain('Read');
    expect(canonicals).toContain('Write');
    expect(canonicals).toContain('Edit');
    expect(canonicals).toContain('Grep');
    expect(canonicals).toContain('Glob');
    expect(canonicals).toContain('WebFetch');
  });

  it('returns a copy (mutation does not affect internal table)', () => {
    const table = translateAll();
    const originalLength = table.length;
    table.push({ canonical: 'injected', sudoName: 'evil' });
    expect(translateAll()).toHaveLength(originalLength);
  });
});

describe('translateMany()', () => {
  it('translates multiple known canonicals', () => {
    const entries = translateMany(['Bash', 'Read', 'Write']);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.sudoName)).toContain('system.shell');
  });

  it('silently drops unknown canonicals', () => {
    const entries = translateMany(['Bash', 'Unknown', 'Read']);
    expect(entries).toHaveLength(2);
  });

  it('returns empty array for all unknown', () => {
    const entries = translateMany(['X', 'Y', 'Z']);
    expect(entries).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    expect(translateMany([])).toHaveLength(0);
  });
});

describe('isKnownCanonical()', () => {
  it('returns true for Bash', () => {
    expect(isKnownCanonical('Bash')).toBe(true);
  });

  it('returns false for unknown tool', () => {
    expect(isKnownCanonical('NotATool')).toBe(false);
  });

  it('returns false for lowercase bash', () => {
    expect(isKnownCanonical('bash')).toBe(false);
  });
});
