/**
 * @file paths-env.test.ts
 * @description paths.ts env resolution: DATA_DIR honors the same env override
 * that ecosystem.config.cjs sets for prod/staging isolation, falling back to
 * `<PROJECT_ROOT>/data`. Constants capture env at module load, so each test
 * resets modules and dynamically imports.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';

const ENV = ['DATA_DIR', 'SUDO_AI_HOME'];
const saved: Record<string, string | undefined> = {};

async function importPaths() {
  vi.resetModules();
  return import('../../src/core/shared/paths.js');
}

describe('paths.ts DATA_DIR env resolution', () => {
  beforeEach(() => {
    for (const k of ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.resetModules();
  });

  it('PATHS-1: unset DATA_DIR falls back to <PROJECT_ROOT>/data (SUDO_AI_HOME-aware)', async () => {
    process.env['SUDO_AI_HOME'] = '/tmp/sudo-home';
    const p = await importPaths();

    expect(p.PROJECT_ROOT).toBe(path.resolve('/tmp/sudo-home'));
    expect(p.DATA_DIR).toBe(path.join('/tmp/sudo-home', 'data'));
    expect(p.MIND_DB).toBe(path.join('/tmp/sudo-home', 'data', 'mind.db'));
  });

  it('PATHS-2: absolute DATA_DIR override moves DATA_DIR, MIND_DB and dataPath, not WORKSPACE_DIR', async () => {
    process.env['SUDO_AI_HOME'] = '/tmp/sudo-home';
    process.env['DATA_DIR'] = '/tmp/staging-data';
    const p = await importPaths();

    expect(p.DATA_DIR).toBe('/tmp/staging-data');
    expect(p.MIND_DB).toBe(path.join('/tmp/staging-data', 'mind.db'));
    expect(p.dataPath('traces.db')).toBe(path.join('/tmp/staging-data', 'traces.db'));
    // Only the data dir is overridden; the rest of the tree stays on PROJECT_ROOT.
    expect(p.WORKSPACE_DIR).toBe(path.join('/tmp/sudo-home', 'workspace'));
    expect(p.projectPath('x')).toBe(path.join('/tmp/sudo-home', 'x'));
  });

  it('PATHS-3: relative DATA_DIR override resolves against cwd, matching call-time readers', async () => {
    process.env['DATA_DIR'] = 'data-staging';
    const p = await importPaths();

    expect(p.DATA_DIR).toBe(path.resolve('data-staging'));
    expect(path.isAbsolute(p.DATA_DIR)).toBe(true);
    expect(p.MIND_DB).toBe(path.join(path.resolve('data-staging'), 'mind.db'));
    expect(p.dataPath('cache')).toBe(path.join(path.resolve('data-staging'), 'cache'));
  });

  it('PATHS-4: constants.ts PATHS.DATA follows the DATA_DIR override', async () => {
    process.env['DATA_DIR'] = '/tmp/staging-data';
    vi.resetModules();
    const [p, c] = await Promise.all([
      import('../../src/core/shared/paths.js'),
      import('../../src/core/shared/constants.js'),
    ]);

    expect(c.PATHS.DATA).toBe(p.DATA_DIR);
    expect(c.PATHS.DATA).toBe('/tmp/staging-data');
    expect(c.PATHS.MIND_DB).toBe(path.join('/tmp/staging-data', 'mind.db'));
  });

  it('PATHS-5: testing/checks.ts re-exports the shared DATA_DIR and anchors src paths on PROJECT_ROOT', async () => {
    process.env['SUDO_AI_HOME'] = '/tmp/sudo-home';
    process.env['DATA_DIR'] = '/tmp/staging-data';
    vi.resetModules();
    // Both imports share the same resetModules epoch, so they resolve the
    // same freshly-loaded DATA_DIR singleton.
    const [p, checks] = await Promise.all([
      import('../../src/core/shared/paths.js'),
      import('../../src/core/testing/checks.js'),
    ]);

    expect(checks.DATA_DIR).toBe(p.DATA_DIR);
    expect(checks.DB_PATHS['mind']).toBe(path.join('/tmp/staging-data', 'mind.db'));
    expect(checks.SKILLS_DIR).toBe(path.join('/tmp/sudo-home', 'src/core/tools/builtin/custom'));
    expect(checks.TOOLS_DIR).toBe(path.join('/tmp/sudo-home', 'src/core/tools/builtin'));
  });
});
