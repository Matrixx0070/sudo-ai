/**
 * Webhook config loader (Spec 4) — load/normalize, defaults, enabled flag.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWebhooks, getHook, hookSecret, webhooksEnabled, __resetWebhooksForTests } from '../../src/core/gateway/webhook-config.js';

function cfg(body: string): string {
  const p = join(mkdtempSync(join(tmpdir(), 'wh-')), 'webhooks.json5');
  writeFileSync(p, body, 'utf-8');
  return p;
}

beforeEach(() => __resetWebhooksForTests());
afterEach(() => { delete process.env['WEBHOOKS_ENABLED']; delete process.env['MY_SECRET']; });

describe('webhook-config', () => {
  it('missing file → no hooks', () => {
    expect(loadWebhooks('/nonexistent/webhooks.json5').hooks).toEqual({});
  });

  it('loads + normalizes; bad signature → none; defaults applied', () => {
    const p = cfg(`{ hooks: {
      a: { signature: 'github', secretEnv: 'MY_SECRET', prompt: 'x {{body}}', tools: ['github.*'], mode: 'async', rateLimitPerMin: 30 },
      b: { signature: 'bogus', prompt: 'y' },
      c: { prompt: '' },
    }}`);
    const w = loadWebhooks(p, true);
    expect(w.hooks['a']).toMatchObject({ signature: 'github', secretEnv: 'MY_SECRET', mode: 'async', rateLimitPerMin: 30, tools: ['github.*'] });
    expect(w.hooks['b']?.signature).toBe('none');
    expect(w.hooks['b']?.mode).toBe('sync');      // default
    expect(w.hooks['b']?.rateLimitPerMin).toBe(60); // default
    expect(w.hooks['c']).toBeUndefined();           // no prompt → skipped
  });

  it('hookSecret resolves from env at call time', () => {
    const p = cfg(`{ hooks: { a: { signature: 'bearer', secretEnv: 'MY_SECRET', prompt: 'p' } } }`);
    loadWebhooks(p, true);
    const h = getHook('a')!;
    expect(hookSecret(h)).toBeNull();
    process.env['MY_SECRET'] = 's3cr3t';
    expect(hookSecret(h)).toBe('s3cr3t');
  });

  it('webhooksEnabled reflects the env kill-switch', () => {
    expect(webhooksEnabled()).toBe(false);
    process.env['WEBHOOKS_ENABLED'] = '1';
    expect(webhooksEnabled()).toBe(true);
  });
});

describe('webhook egress opt-in (Spec 8 network allowlist)', () => {
  it("network: 'allowlist' + egressHosts parse through", () => {
    const p = cfg(`{ hooks: { a: {
      signature: 'hmac', secretEnv: 'MY_SECRET', prompt: 'p', tools: ['system.exec'],
      network: 'allowlist', egressHosts: ['api.example.com', '*.trusted.io', ' ', 42],
    } } }`);
    const w = loadWebhooks(p, true);
    expect(w.hooks['a']?.network).toBe('allowlist');
    expect(w.hooks['a']?.egressHosts).toEqual(['api.example.com', '*.trusted.io']);
  });

  it("network: 'host' (or anything else) is refused — field dropped", () => {
    const p = cfg(`{ hooks: {
      a: { prompt: 'p', network: 'host' },
      b: { prompt: 'p', network: true },
    } }`);
    const w = loadWebhooks(p, true);
    expect(w.hooks['a']?.network).toBeUndefined();
    expect(w.hooks['b']?.network).toBeUndefined();
  });

  it('egressHosts without network: allowlist is dropped (no dormant grants)', () => {
    const p = cfg(`{ hooks: { a: { prompt: 'p', egressHosts: ['api.example.com'] } } }`);
    const w = loadWebhooks(p, true);
    expect(w.hooks['a']?.egressHosts).toBeUndefined();
  });

  it('default: no network field → undefined (turns stay network-less)', () => {
    const p = cfg(`{ hooks: { a: { prompt: 'p' } } }`);
    expect(loadWebhooks(p, true).hooks['a']?.network).toBeUndefined();
  });
});
