/**
 * @file grok-statsig-mint.test.ts
 * @description Deterministic tests for the pure-Node grok x-statsig-id minter.
 * No net/browser/disk. The FP_CASES fixtures are captured from independent live
 * grok loads and are kept IDENTICAL to scripts/grok-web/statsig_mint.test.mjs — a
 * divergence between the TS production copy and the .mjs reference fails both.
 * The live anti-bot gate is proven separately (never in CI).
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  computeR,
  computeDhex,
  deriveFingerprint,
  mintStatsig,
  mintStatsigFromSeed,
  STATSIG_SALT,
  R_EPOCH,
} from '../../src/llm/grok-statsig-mint.js';

// seed (base64 <meta name^=gr> content) -> the exact dHex the live browser minter
// produced. Covers all 4 spinner buckets, a currentTime==0 (identity) case, and
// an easing-overshoot (color-clamp) case.
// Re-captured 2026-07-25 after grok's spinner+algorithm drift (docs/STATSIG_RERE_2026-07-25.md):
// segment seed[21]%16, currentTime (seed[4]%16)*(seed[14]%16)*(seed[7]%16). dHex verified 16/16
// vs the live minter source + a pure-Node token that PASSED the live anti-bot gate (HTTP 200).
const FP_CASES: Array<[string, string]> = [
  ['k3Ucu7ukq81Pp04oTpUp+fTX1bAGrl92mRX3XU5yG6ZALnPOPphBzKPU4oj+B2Fm', '324a780570a3d70a3d70c0f0a3d70a3d70a0f0a3d70a3d70a0570a3d70a3d70c00'],
  ['VTmxqAQ0Mdmluk0f2U4sCTmlueDZBfYd4rDlL+QSiVj3lgiX2LiopFpEH/qbKM65', 'e02b80100100'],
  ['mzAunRQlIMVINBGTN7uIbFwsZnHJubVZLBvf9cIvfdpi81gSW+qBPfPCRoDxo3iZ', '7bec91101999999999999a01999999999999a100'],
  ['d/cVvW5s3BEWeawTXqxL/c2toHu20hC0FYbmgDe1fvOepoaVUpgiKrGdSRM7S5ck', 'a144210fd70a3d70a3d702147ae147ae14802147ae147ae1480fd70a3d70a3d700'],
  ['BE+kI8bFeXGQXVQyF1xG4Ym8VEmPJyO1jWNTc9edGGzEEXIPACF+l5+Hrc+w3Lnp', '7c22bd10147ae147ae147b0147ae147ae147b100'],
  ['4LPnNuQu9nLnjlf8lReNAJdJ9gHdxW+ytJlgu8zMuSJfly98TrTpaGy3xIe2qjyh', 'cf78d710028f5c28f5c28f60028f5c28f5c28f6100'],
];

describe('deriveFingerprint (pure seed -> dHex, byte-exact vs live minter)', () => {
  for (const [seed, exp] of FP_CASES) {
    it(`derives ${exp.slice(0, 8)}...`, () => {
      expect(deriveFingerprint(seed).dHex).toBe(exp);
    });
  }
  it('rejects a seed of the wrong length', () => {
    expect(() => deriveFingerprint('AAAA')).toThrow(/seed not 48 bytes/);
  });
});

describe('computeDhex / computeR (verified transforms)', () => {
  it('computeDhex identity rotation', () => {
    expect(computeDhex('rgb(58, 139, 186)', 'matrix(1, 0, 0, 1, 0, 0)')).toBe('3a8bba100100');
  });
  it('computeR pinned epoch', () => {
    expect(computeR((R_EPOCH + 101_649_780) * 1000)).toBe(101_649_780);
  });
});

describe('token assembly', () => {
  it('mintStatsig produces the documented payload structure', () => {
    const seed = 'h/gCZsFhr73jktGEBFM3rgH38P5Ty3xclf3mmYAGSQ5yVtR1bZakQV0zVdqQqIXK';
    const reqPath = '/rest/app-chat/conversations/new';
    const dHex = '7a816509eb851eb851eb80c7ae147ae147b0c7ae147ae147b09eb851eb851eb800';
    const r = 101_649_780;
    const nowMs = (r + R_EPOCH) * 1000;
    const msg = `POST!${reqPath}!${r}${STATSIG_SALT}${dHex}`;

    const token = mintStatsig(seed, reqPath, 'POST', nowMs, dHex, 0x42);
    const b = Buffer.from(token, 'base64');
    expect(b[0]).toBe(0x42);
    const payload = Buffer.from(b.subarray(1).map((x) => x ^ b[0]!));
    expect(payload.length).toBe(69);
    expect(payload.subarray(0, 48).toString('base64')).toBe(Buffer.from(seed, 'base64').toString('base64'));
    expect(payload.readUInt32LE(48)).toBe(r);
    const sha16 = crypto.createHash('sha256').update(Buffer.from(msg, 'utf8')).digest().subarray(0, 16);
    expect(payload.subarray(52, 68).toString('hex')).toBe(sha16.toString('hex'));
    expect(payload[68]).toBe(0x03);
  });

  it('mintStatsigFromSeed embeds the derived dHex end-to-end', () => {
    const seed = FP_CASES[1]![0];
    const r = 101_649_780;
    const nowMs = (r + R_EPOCH) * 1000;
    const token = mintStatsigFromSeed(seed, '/rest/app-chat/conversations/new', 'POST', nowMs, 0x42);
    const b = Buffer.from(token, 'base64');
    const payload = Buffer.from(b.subarray(1).map((x) => x ^ b[0]!));
    const msg = `POST!/rest/app-chat/conversations/new!${r}${STATSIG_SALT}${deriveFingerprint(seed).dHex}`;
    const sha16 = crypto.createHash('sha256').update(Buffer.from(msg, 'utf8')).digest().subarray(0, 16);
    expect(payload.subarray(52, 68).toString('hex')).toBe(sha16.toString('hex'));
  });
});
