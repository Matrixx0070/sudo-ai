/**
 * Project path resolution.
 *
 * Verifies the portable-root invariants: PROJECT_ROOT honours SUDO_AI_HOME (else
 * cwd), DATA_DIR honours DATA_DIR (else <root>/data), the derived constants
 * (WORKSPACE_DIR, MIND_DB) hang off those roots, and the projectPath/dataPath
 * join helpers compose correctly.
 *
 * Assertions are computed from the same env the module read at load time, so the
 * suite is independent of whatever SUDO_AI_HOME / DATA_DIR the runner sets and
 * cannot collide with DATA_DIR-bound DB suites.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  PROJECT_ROOT,
  DATA_DIR,
  WORKSPACE_DIR,
  MIND_DB,
  projectPath,
  dataPath,
} from '../../../src/core/shared/paths.js';

// Recompute the expected roots from the same inputs the module captured at load.
const expectedRoot = process.env['SUDO_AI_HOME']
  ? path.resolve(process.env['SUDO_AI_HOME'])
  : process.cwd();
const expectedData = process.env['DATA_DIR']
  ? path.resolve(process.env['DATA_DIR'])
  : path.join(expectedRoot, 'data');

describe('paths constants', () => {
  it('PROJECT_ROOT resolves from SUDO_AI_HOME or cwd and is absolute', () => {
    expect(PROJECT_ROOT).toBe(expectedRoot);
    expect(path.isAbsolute(PROJECT_ROOT)).toBe(true);
  });

  it('DATA_DIR resolves from DATA_DIR env or <root>/data and is absolute', () => {
    expect(DATA_DIR).toBe(expectedData);
    expect(path.isAbsolute(DATA_DIR)).toBe(true);
  });

  it('WORKSPACE_DIR hangs off the project root', () => {
    expect(WORKSPACE_DIR).toBe(path.join(PROJECT_ROOT, 'workspace'));
  });

  it('MIND_DB hangs off the data dir', () => {
    expect(MIND_DB).toBe(path.join(DATA_DIR, 'mind.db'));
    expect(path.basename(MIND_DB)).toBe('mind.db');
  });
});

describe('projectPath', () => {
  it('returns the root itself when called with no segments', () => {
    expect(projectPath()).toBe(PROJECT_ROOT);
  });

  it('joins a single segment onto the root', () => {
    expect(projectPath('src')).toBe(path.join(PROJECT_ROOT, 'src'));
  });

  it('joins multiple segments onto the root', () => {
    expect(projectPath('src', 'core', 'shared')).toBe(
      path.join(PROJECT_ROOT, 'src', 'core', 'shared'),
    );
  });

  it('normalises traversal segments via path.join', () => {
    expect(projectPath('a', '..', 'b')).toBe(path.join(PROJECT_ROOT, 'b'));
  });
});

describe('dataPath', () => {
  it('returns the data dir itself when called with no segments', () => {
    expect(dataPath()).toBe(DATA_DIR);
  });

  it('joins a single segment onto the data dir', () => {
    expect(dataPath('mind.db')).toBe(path.join(DATA_DIR, 'mind.db'));
  });

  it('joins multiple segments onto the data dir', () => {
    expect(dataPath('cache', 'prompt.json')).toBe(
      path.join(DATA_DIR, 'cache', 'prompt.json'),
    );
  });

  it('agrees with the MIND_DB constant', () => {
    expect(dataPath('mind.db')).toBe(MIND_DB);
  });
});
