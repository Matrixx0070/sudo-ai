import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  encryptZone1,
  decryptZone1,
  classifyZone,
  ZoneCryptoError,
} from '../../src/core/gdrive/zones.js';

const key = randomBytes(32);

describe('zone-1 crypto (F29)', () => {
  it('round-trips arbitrary binary content', () => {
    const plain = randomBytes(10_000);
    const wire = encryptZone1(plain, key);
    expect(decryptZone1(wire, key).equals(plain)).toBe(true);
  });

  it('uses a fresh IV per blob — same plaintext, different ciphertext', () => {
    const plain = Buffer.from('same content');
    const a = encryptZone1(plain, key);
    const b = encryptZone1(plain, key);
    expect(a.equals(b)).toBe(false);
  });

  it('rejects tampered ciphertext and wrong keys', () => {
    const wire = encryptZone1(Buffer.from('secret'), key);
    const tampered = Buffer.from(wire);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => decryptZone1(tampered, key)).toThrow(ZoneCryptoError);
    expect(() => decryptZone1(wire, randomBytes(32))).toThrow(ZoneCryptoError);
  });

  it('rejects truncated/garbage payloads', () => {
    expect(() => decryptZone1(Buffer.from([1, 2, 3]), key)).toThrow(/too short/);
    const badVersion = encryptZone1(Buffer.from('x'), key);
    badVersion[0] = 99;
    expect(() => decryptZone1(badVersion, key)).toThrow(/wire version/);
  });
});

describe('classifyZone', () => {
  it('explicit override always wins', () => {
    expect(classifyZone('password: hunter2', 2)).toBe(2);
    expect(classifyZone('plain note', 0)).toBe(0);
  });

  it('never-sync markers force zone 0', () => {
    expect(classifyZone('this is never-sync material')).toBe(0);
    expect(classifyZone('marked zone: 0 deliberately')).toBe(0);
  });

  it('credential/financial/personal content defaults to zone 1', () => {
    expect(classifyZone('the API_KEY for prod is xyz')).toBe(1);
    expect(classifyZone('-----BEGIN RSA PRIVATE KEY-----')).toBe(1);
    expect(classifyZone('credit card ending 4242')).toBe(1);
    expect(classifyZone('salary discussion notes')).toBe(1);
  });

  it('ordinary knowledge defaults to zone 2', () => {
    expect(classifyZone('sqlite WAL mode allows concurrent readers')).toBe(2);
  });
});
