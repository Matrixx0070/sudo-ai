/**
 * Tests for the github connector's zero-risk safety layer (protected paths,
 * protected branches). Pure, no git/gh.
 */
import { describe, it, expect } from 'vitest';
import {
  isProtectedPath,
  protectedHits,
  isProtectedBranch,
} from '../../src/core/tools/builtin/github/safety.js';

describe('github safety — protected paths', () => {
  it('matches CI / config / secrets / manifests / connector / router', () => {
    for (const p of [
      '.github/workflows/ci.yml',
      '.githooks/pre-commit',
      'ecosystem.config.cjs',
      'config/.env',
      'config/prod/settings.json',
      '.env', '.env.local', 'apps/web/.env', 'apps/web/.env.production',
      'package.json', 'pnpm-lock.yaml', 'yarn.lock',
      'tsconfig.json', 'tsconfig.build.json',
      'Dockerfile', 'docker-compose.yml', 'docker-compose.prod.yml',
      'src/core/tools/builtin/github/github.ts',
      'src/core/tools/builtin/github/safety.ts',
      'src/core/agent/tool-router.ts',
    ]) {
      expect(isProtectedPath(p), p).toBe(true);
    }
  });

  it('allows ordinary source / docs / test paths', () => {
    for (const p of [
      'src/core/agent/loop.ts',
      'src/core/tools/builtin/coder/git.ts',
      'docs/readme.md',
      'README.md',
      'tests/tools/github.test.ts',
      'src/index.ts',
    ]) {
      expect(isProtectedPath(p), p).toBe(false);
    }
  });

  it('normalises leading ./ and backslashes', () => {
    expect(isProtectedPath('./ecosystem.config.cjs')).toBe(true);
    expect(isProtectedPath('.github\\workflows\\ci.yml')).toBe(true);
  });

  it('protectedHits returns only the protected subset', () => {
    expect(protectedHits(['docs/a.md', '.github/workflows/ci.yml', 'src/x.ts', 'config/.env']))
      .toEqual(['.github/workflows/ci.yml', 'config/.env']);
  });

  it('isProtectedBranch flags default/reserved branches, not feature branches', () => {
    for (const b of ['main', 'master', 'MAIN', 'develop', 'production', 'prod', 'gh-pages']) {
      expect(isProtectedBranch(b), b).toBe(true);
    }
    for (const b of ['feature/x', 'test/agent-e2e', 'fix/bug-123']) {
      expect(isProtectedBranch(b), b).toBe(false);
    }
  });
});
