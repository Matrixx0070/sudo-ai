/**
 * Package-root resolver tests.
 *
 * PACKAGE_ROOT/packagePath must anchor on the MODULE's own location (where the
 * shipped dist/ lives), never on process.cwd() — the installed-daemon cwd is
 * the user's HOME, which broke /chat SPA serving in npm installs.
 * PROJECT_ROOT/projectPath (user-data paths) must stay cwd-based.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

describe('package-root resolver', () => {
  const originalCwd = process.cwd();
  let scratchDir: string;

  beforeEach(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-root-test-'));
    vi.resetModules();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(scratchDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('resolves PACKAGE_ROOT to the dir containing package.json + dist, ignoring cwd', async () => {
    // Move cwd somewhere unrelated BEFORE the module loads — an installed
    // daemon runs with cwd == user HOME, not the package dir.
    process.chdir(scratchDir);
    delete process.env['SUDO_AI_HOME'];
    const paths = await import('../../src/core/shared/paths.js');

    expect(paths.PACKAGE_ROOT).toBe(REPO_ROOT);
    const pkg = JSON.parse(
      fs.readFileSync(path.join(paths.PACKAGE_ROOT, 'package.json'), 'utf-8'),
    ) as { name?: string };
    expect(pkg.name).toBe('@matrixx0070/sudo-ai');
    // The resolver must NOT have picked up the unrelated cwd.
    expect(paths.PACKAGE_ROOT).not.toBe(fs.realpathSync(scratchDir));
  });

  it('packagePath joins onto the package root, not cwd', async () => {
    process.chdir(scratchDir);
    const paths = await import('../../src/core/shared/paths.js');
    expect(paths.packagePath('dist', 'renderer')).toBe(
      path.join(REPO_ROOT, 'dist', 'renderer'),
    );
  });

  it('PROJECT_ROOT / projectPath stay cwd-based (user data untouched)', async () => {
    process.chdir(scratchDir);
    delete process.env['SUDO_AI_HOME'];
    const paths = await import('../../src/core/shared/paths.js');
    expect(paths.PROJECT_ROOT).toBe(process.cwd());
    expect(paths.projectPath('workspace')).toBe(path.join(process.cwd(), 'workspace'));
    // In a scratch cwd, package root and project root genuinely diverge —
    // the exact situation of an npm install.
    expect(paths.PACKAGE_ROOT).not.toBe(paths.PROJECT_ROOT);
  });
});
