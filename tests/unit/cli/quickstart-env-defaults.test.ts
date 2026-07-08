/**
 * @file tests/unit/cli/quickstart-env-defaults.test.ts
 * @description ensureEnvDefaults() — quickstart must leave a fresh install with
 * a working turn pipeline: WEB_CHAT_ENABLED=true (else POST /api/message has no
 * handler) and a generated WEB_CHAT_TOKEN. Never clobbers user-set values.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureEnvDefaults } from '../../../src/cli/commands/quickstart.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quickstart-env-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ensureEnvDefaults', () => {
  it('creates config/.env with WEB_CHAT_ENABLED=true and a WEB_CHAT_TOKEN when missing', () => {
    const added = ensureEnvDefaults(dir);
    expect(added).toEqual(['WEB_CHAT_ENABLED', 'WEB_CHAT_TOKEN']);
    const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    expect(env).toMatch(/^WEB_CHAT_ENABLED=true$/m);
    expect(env).toMatch(/^WEB_CHAT_TOKEN=[0-9a-f]{48}$/m);
  });

  it('adds only the missing key and preserves an existing user value', () => {
    fs.writeFileSync(path.join(dir, '.env'), 'WEB_CHAT_TOKEN=user-secret', 'utf8');
    const added = ensureEnvDefaults(dir);
    expect(added).toEqual(['WEB_CHAT_ENABLED']);
    const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    expect(env).toMatch(/^WEB_CHAT_TOKEN=user-secret$/m);
    expect(env).toMatch(/^WEB_CHAT_ENABLED=true$/m);
    // Appended on a fresh line even though the file had no trailing newline.
    expect(env).not.toContain('user-secret#');
    expect(env).not.toContain('user-secretWEB');
  });

  it('is idempotent — second call adds nothing and does not modify the file', () => {
    ensureEnvDefaults(dir);
    const before = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    const added = ensureEnvDefaults(dir);
    expect(added).toEqual([]);
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toBe(before);
  });

  it('respects an explicitly disabled web chat (WEB_CHAT_ENABLED=false stays false)', () => {
    fs.writeFileSync(path.join(dir, '.env'), 'WEB_CHAT_ENABLED=false\n', 'utf8');
    const added = ensureEnvDefaults(dir);
    expect(added).toEqual(['WEB_CHAT_TOKEN']);
    const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    expect(env).toMatch(/^WEB_CHAT_ENABLED=false$/m);
    expect(env).not.toMatch(/^WEB_CHAT_ENABLED=true$/m);
  });
});
