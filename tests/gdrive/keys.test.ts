import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadHmacKey, loadEncKey } from '../../src/core/gdrive/keys.js';
import { GdriveConfigError } from '../../src/core/gdrive/config.js';

const tmp = mkdtempSync(join(tmpdir(), 'gdrive-keys-'));

function keyFile(name: string, content: string, mode = 0o600): string {
  const p = join(tmp, name);
  writeFileSync(p, content, { mode });
  chmodSync(p, mode);
  return p;
}

describe('brain keys (F17/F29 fail-fast)', () => {
  it('loads a hex key file and decodes it', () => {
    const hex = randomBytes(32).toString('hex');
    const p = keyFile('good.key', hex);
    const key = loadHmacKey({ BRAIN_HMAC_KEY_PATH: p });
    expect(key.length).toBe(32);
    expect(key.toString('hex')).toBe(hex);
  });

  it('fails fast when the env var or file is missing', () => {
    expect(() => loadHmacKey({})).toThrow(GdriveConfigError);
    expect(() => loadHmacKey({ BRAIN_HMAC_KEY_PATH: '/nope/missing.key' })).toThrow(/openssl rand/);
    expect(() => loadEncKey({})).toThrow(/BRAIN_ENC_KEY_PATH/);
  });

  it('rejects short keys', () => {
    const p = keyFile('short.key', 'abcd');
    expect(() => loadHmacKey({ BRAIN_HMAC_KEY_PATH: p })).toThrow(/32/);
  });

  it('rejects group/world-readable key files', () => {
    const p = keyFile('lax.key', randomBytes(32).toString('hex'), 0o644);
    expect(() => loadHmacKey({ BRAIN_HMAC_KEY_PATH: p })).toThrow(/0600/);
  });
});
