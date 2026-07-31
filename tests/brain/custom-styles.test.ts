/**
 * @file tests/brain/custom-styles.test.ts
 * @description Disk-defined output styles (workspace/styles/*.md).
 *
 * sudo-ai already had swappable styles via the persona registry; what was
 * missing was defining one WITHOUT editing TypeScript. These tests pin the
 * parsing contract, the safety rules (built-ins win, junk is ignored, prompt
 * assembly never breaks) and the fact that a dropped file becomes selectable
 * through the existing persona surface.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

import { parseStyleFile, loadCustomStyles, getCustomStyle, customStylesEnabled } from '../../src/core/brain/custom-styles.js';
import { listPersonas, getPersona } from '../../src/core/brain/personas.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(os.tmpdir(), 'styles-test-'));
  process.env['SUDO_STYLES_DIR'] = dir;
  delete process.env['SUDO_CUSTOM_STYLES'];
});

afterEach(() => {
  delete process.env['SUDO_STYLES_DIR'];
  delete process.env['SUDO_CUSTOM_STYLES'];
  rmSync(dir, { recursive: true, force: true });
});

describe('parseStyleFile', () => {
  it('reads frontmatter label/temperature and the body as the system block', () => {
    const s = parseStyleFile('explanatory', '---\nlabel: Explanatory\ntemperature: 0.6\n---\nExplain your reasoning.');
    expect(s).not.toBeNull();
    expect(s!.label).toBe('Explanatory');
    expect(s!.temperature).toBe(0.6);
    expect(s!.systemBlock).toBe('Explain your reasoning.');
  });

  it('works with no frontmatter and defaults sensibly', () => {
    const s = parseStyleFile('terse', 'Be extremely brief.');
    expect(s!.label).toBe('terse');
    expect(s!.temperature).toBe(0.7);
    expect(s!.systemBlock).toBe('Be extremely brief.');
  });

  it('rejects empty bodies and unsafe names', () => {
    expect(parseStyleFile('ok', '---\nlabel: X\n---\n   ')).toBeNull();
    expect(parseStyleFile('../escape', 'body')).toBeNull();
    expect(parseStyleFile('Bad Name', 'body')).toBeNull();
  });

  it('ignores an out-of-range temperature rather than passing it to the model', () => {
    expect(parseStyleFile('t', '---\ntemperature: 99\n---\nbody')!.temperature).toBe(0.7);
    expect(parseStyleFile('t', '---\ntemperature: -1\n---\nbody')!.temperature).toBe(0.7);
  });
});

describe('loadCustomStyles', () => {
  it('loads .md files, sorted, and skips non-markdown', () => {
    writeFileSync(join(dir, 'zulu.md'), 'Z body');
    writeFileSync(join(dir, 'alpha.md'), 'A body');
    writeFileSync(join(dir, 'notes.txt'), 'ignored');
    const styles = loadCustomStyles();
    expect(styles.map((s) => s.name)).toEqual(['alpha', 'zulu']);
  });

  it('returns [] when the directory is absent or the flag is off', () => {
    process.env['SUDO_STYLES_DIR'] = join(dir, 'does-not-exist');
    expect(loadCustomStyles()).toEqual([]);
    process.env['SUDO_STYLES_DIR'] = dir;
    writeFileSync(join(dir, 'x.md'), 'body');
    process.env['SUDO_CUSTOM_STYLES'] = '0';
    expect(customStylesEnabled()).toBe(false);
    expect(loadCustomStyles()).toEqual([]);
  });

  it('getCustomStyle is case-insensitive', () => {
    writeFileSync(join(dir, 'mystyle.md'), 'body');
    expect(getCustomStyle('MyStyle')?.name).toBe('mystyle');
    expect(getCustomStyle('missing')).toBeNull();
  });
});

describe('integration with the existing persona surface', () => {
  it('a dropped file becomes a selectable persona', () => {
    writeFileSync(join(dir, 'explanatory.md'), '---\nlabel: Explanatory\n---\nExplain as you go.');
    const names = listPersonas().map((p) => p.type as string);
    expect(names).toContain('explanatory');
    expect(names).toContain('coder'); // built-ins still there
    const p = getPersona('explanatory' as never);
    expect(p.systemBlock).toBe('Explain as you go.');
  });

  it('a custom file can NEVER shadow a built-in persona', () => {
    writeFileSync(join(dir, 'coder.md'), 'HIJACKED');
    const coder = getPersona('coder' as never);
    expect(coder.systemBlock).not.toBe('HIJACKED');
    // and it appears only once in the list
    expect(listPersonas().filter((p) => p.type === 'coder')).toHaveLength(1);
  });

  it('unknown names still throw (contract unchanged)', () => {
    expect(() => getPersona('nope-not-real' as never)).toThrow(/Unknown persona/);
  });
});
