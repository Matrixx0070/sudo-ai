/**
 * @file tests/gateway/webhook-i90.test.ts
 * @description Invariant I90 — a hook secret must never reuse the gateway token.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWebhooks, __resetWebhooksForTests } from '../../src/core/gateway/webhook-config.js';

const KEYS = ['GATEWAY_TOKEN', 'GATEWAY_SECRET', 'HOOK_A_SECRET', 'HOOK_B_SECRET', 'SUDO_SECRETS_REF'];

function writeCfg(dir: string): string {
  const p = join(dir, 'webhooks.json5');
  writeFileSync(p, JSON.stringify({
    hooks: {
      a: { signature: 'bearer', secretEnv: 'HOOK_A_SECRET', prompt: 'A', tools: [], mode: 'sync', rateLimitPerMin: 60 },
      b: { signature: 'bearer', secretEnv: 'HOOK_B_SECRET', prompt: 'B', tools: [], mode: 'sync', rateLimitPerMin: 60 },
    },
  }));
  return p;
}

describe('Webhook I90: hook secret must not reuse the gateway token', () => {
  let saved: Record<string, string | undefined>;
  let dir: string;
  beforeEach(() => {
    saved = {}; for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    dir = mkdtempSync(join(tmpdir(), 'i90-'));
    __resetWebhooksForTests();
  });
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    rmSync(dir, { recursive: true, force: true });
    __resetWebhooksForTests();
  });

  it('I90-1: a hook reusing GATEWAY_TOKEN is dropped; a distinct hook survives', () => {
    process.env['GATEWAY_TOKEN'] = 'shared-operator-token';
    process.env['HOOK_A_SECRET'] = 'shared-operator-token'; // collides → dropped
    process.env['HOOK_B_SECRET'] = 'hook-b-unique-secret';   // fine → kept
    const cfg = loadWebhooks(writeCfg(dir), true);
    expect(cfg.hooks['a']).toBeUndefined();
    expect(cfg.hooks['b']).toBeDefined();
  });

  it('I90-2: a hook reusing GATEWAY_SECRET is also dropped', () => {
    process.env['GATEWAY_SECRET'] = 'ws-control-secret';
    process.env['HOOK_A_SECRET'] = 'ws-control-secret';
    process.env['HOOK_B_SECRET'] = 'distinct';
    const cfg = loadWebhooks(writeCfg(dir), true);
    expect(cfg.hooks['a']).toBeUndefined();
    expect(cfg.hooks['b']).toBeDefined();
  });

  it('I90-3: with distinct secrets, both hooks load', () => {
    process.env['GATEWAY_TOKEN'] = 'operator';
    process.env['HOOK_A_SECRET'] = 'a-secret';
    process.env['HOOK_B_SECRET'] = 'b-secret';
    const cfg = loadWebhooks(writeCfg(dir), true);
    expect(cfg.hooks['a']).toBeDefined();
    expect(cfg.hooks['b']).toBeDefined();
  });

  it('I90-4: kill-switch SUDO_SECRETS_REF=0 restores legacy loading (no drop)', () => {
    process.env['SUDO_SECRETS_REF'] = '0';
    process.env['GATEWAY_TOKEN'] = 'shared';
    process.env['HOOK_A_SECRET'] = 'shared'; // would collide, but check is disabled
    process.env['HOOK_B_SECRET'] = 'b';
    const cfg = loadWebhooks(writeCfg(dir), true);
    expect(cfg.hooks['a']).toBeDefined();
    expect(cfg.hooks['b']).toBeDefined();
  });
});
