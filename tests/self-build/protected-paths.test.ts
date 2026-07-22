/**
 * @file tests/self-build/protected-paths.test.ts
 * @description Guards the PROTECTED_PATHS deny-list. The entire meta-tools
 * directory must be protected: those files ARE the agent's self-modification
 * guardrails (config-schema guard, restart kill-switch, service-control,
 * self-update, self-modify). If any of them were writable via
 * meta.self-modify, the agent could overwrite its own guards and the next
 * restart would load un-gated code.
 */
import { describe, expect, it } from 'vitest';

import { PROTECTED_PATHS, isProtectedPath } from '../../src/core/self-build/protected-paths.js';

describe('protected-paths', () => {
  describe('meta-tools directory is fully protected', () => {
    const metaFiles = [
      'src/core/tools/builtin/meta/self-modify.ts',
      'src/core/tools/builtin/meta/restart-helper.ts',
      'src/core/tools/builtin/meta/self-config.ts',
      'src/core/tools/builtin/meta/service-control.ts',
      'src/core/tools/builtin/meta/self-update.ts',
    ];

    for (const file of metaFiles) {
      it(`protects ${file}`, () => {
        expect(isProtectedPath(file)).toBe(true);
      });
    }

    it('uses a directory prefix, not a single-file entry', () => {
      expect(PROTECTED_PATHS).toContain('src/core/tools/builtin/meta/');
    });
  });

  describe('other core protections still hold', () => {
    it.each([
      'src/core/self-build/protected-paths.ts',
      'ecosystem.config.cjs',
      'config/sudo-ai.json5',
      '.githooks/pre-commit',
      'package.json',
    ])('protects %s', (file) => {
      expect(isProtectedPath(file)).toBe(true);
    });

    it('is case-insensitive (no trivial bypass via capitalization)', () => {
      expect(isProtectedPath('SRC/CORE/TOOLS/BUILTIN/META/Restart-Helper.ts')).toBe(true);
    });
  });

  describe('unprotected paths stay writable', () => {
    it.each([
      'src/core/tools/builtin/grok/index.ts',
      'src/core/channels/telegram.ts',
      'README.md',
    ])('does not protect %s', (file) => {
      expect(isProtectedPath(file)).toBe(false);
    });

    it('rejects empty/invalid input', () => {
      expect(isProtectedPath('')).toBe(false);
    });
  });
});
