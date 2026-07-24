// Deterministic tests for statsig_mint.mjs — no browser, no network.
// Run: node scripts/grok-web/statsig_mint.test.mjs
import assert from 'node:assert';
import crypto from 'node:crypto';
import { computeDhex, dhexFromFingerprint, computeR, mintStatsig, mintStatsigFromSeed, deriveFingerprint, STATSIG_SALT, R_GSWH7_PATHS, compareSpinnerPaths } from './statsig_mint.mjs';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log('PASS', name); pass++; } catch (e) { console.log('FAIL', name, '::', e.message); fail++; } };

// --- Ground-truth (color, transform -> dHex) triples captured live from the grok minter ---
const DHEX_CASES = [
  // identity rotation
  ['rgb(58, 139, 186)', 'matrix(1, 0, 0, 1, 0, 0)', '3a8bba100100'],
  // rotate ~9.39deg
  ['rgb(109, 40, 210)', 'matrix(0.986612, 0.163084, -0.163084, 0.986612, 0, 0)',
   '6d28d20fd70a3d70a3d7028f5c28f5c28f6028f5c28f5c28f60fd70a3d70a3d700'],
  // rotate ~15.12deg
  ['rgb(175, 206, 131)', 'matrix(0.965372, 0.260876, -0.260876, 0.965372, 0, 0)',
   'afce830f851eb851eb850428f5c28f5c290428f5c28f5c290f851eb851eb8500'],
];
for (const [color, transform, exp] of DHEX_CASES) {
  t(`computeDhex ${exp.slice(0, 8)}...`, () => assert.strictEqual(computeDhex(color, transform), exp));
}

// dhexFromFingerprint(identity) must equal the identity case
t('dhexFromFingerprint identity', () =>
  assert.strictEqual(dhexFromFingerprint({ rgb: [58, 139, 186], angleDeg: 0 }), '3a8bba100100'));

// --- computeR pinned epoch ---
t('computeR epoch', () => assert.strictEqual(computeR(1682924400000 + 101649780000), 101649780));

// --- Full token assembly against the task ground-truth message/dHex/r ---
// seed + message are the documented fixture; assert our assembly reproduces the
// documented payload structure (seed48 ++ rLE32 ++ sha256(msg)[0..16] ++ 0x03).
t('token assembly byte structure', () => {
  const seed = 'h/gCZsFhr73jktGEBFM3rgH38P5Ty3xclf3mmYAGSQ5yVtR1bZakQV0zVdqQqIXK';
  const path = '/rest/app-chat/conversations/new';
  const method = 'POST';
  const dHex = '7a816509eb851eb851eb80c7ae147ae147b0c7ae147ae147b09eb851eb851eb800';
  const r = 101649780;
  const nowMs = (r + 1682924400) * 1000;
  const expectMsg = `POST!/rest/app-chat/conversations/new!101649780obfiowerehiring${dHex}`;
  assert.strictEqual(`${method}!${path}!${computeR(nowMs)}${STATSIG_SALT}${dHex}`, expectMsg);

  const token = mintStatsig(seed, path, method, nowMs, { dHex }, 0x42);
  // decode and verify each field
  const b = Buffer.from(token, 'base64');
  const k0 = b[0];
  assert.strictEqual(k0, 0x42);
  const payload = Buffer.from(b.subarray(1).map(x => x ^ k0));
  assert.strictEqual(payload.length, 69);
  assert.strictEqual(payload.subarray(0, 48).toString('base64'), Buffer.from(seed, 'base64').toString('base64'));
  assert.strictEqual(payload.readUInt32LE(48), r);
  const sha16 = crypto.createHash('sha256').update(Buffer.from(expectMsg, 'utf8')).digest().subarray(0, 16);
  assert.strictEqual(payload.subarray(52, 68).toString('hex'), sha16.toString('hex'));
  assert.strictEqual(payload[68], 0x03);
});

// --- deriveFingerprint: pure seed -> dHex, byte-exact vs the live minter ---
// Fixtures captured from independent live grok loads (see pathb_hook.mjs); each is
// seed(base64 <meta name^=gr> content) -> the exact dHex the browser minter produced.
// Covers all 4 spinner buckets, a currentTime==0 (identity) case, and easing overshoot.
const FP_CASES = [
  ['zGcIAVbd8I1DldqMZQjmWCf+GbDsxzCkZMy1geYQrI0Ndy2ds9O1SHmvrQGWzpO6', '4f7146100100'],                                                             // bucket1, currentTime 0
  ['+3zO4g695EsZA3VeeESCqew2ILS3Eso2b2oPGPQ86WEqkkrAKvN4kcJFKJIx6E82', '2e3fa50e3d70a3d70a3d8075c28f5c28f5c4075c28f5c28f5c40e3d70a3d70a3d800'], // bucket1, rotated
  ['nNxvy9H8ijJ8Cvvp7HSuLo9SQRZiLIubl5Xule/rVJG4A2ya3dI0F33iMFDZiGqU', 'bfff00f851eb851eb8503ae147ae147ae203ae147ae147ae20f851eb851eb8500'],       // bucket0, color-clamp overshoot
  ['rLIbQqc65BToJN9kCzQOyfmC+qmVC0Uq1LwK4FH0XqM6+wyo8Ch98CwuP+EI9nR8', '7bb42e100100'],                                                             // bucket2, currentTime 0
];
for (const [seed, exp] of FP_CASES) {
  t(`deriveFingerprint ${exp.slice(0, 8)}...`, () => assert.strictEqual(deriveFingerprint(seed).dHex, exp));
}

// mintStatsigFromSeed must embed the derived dHex into a well-formed token.
t('mintStatsigFromSeed end-to-end', () => {
  const seed = FP_CASES[1][0];
  const r = 101649780;
  const nowMs = (r + 1682924400) * 1000;
  const token = mintStatsigFromSeed(seed, '/rest/app-chat/conversations/new', 'POST', nowMs, 0x42);
  const b = Buffer.from(token, 'base64');
  const payload = Buffer.from(b.subarray(1).map(x => x ^ b[0]));
  assert.strictEqual(payload.length, 69);
  assert.strictEqual(payload.subarray(0, 48).toString('base64'), Buffer.from(seed, 'base64').toString('base64'));
  const msg = `POST!/rest/app-chat/conversations/new!${r}${STATSIG_SALT}${deriveFingerprint(seed).dHex}`;
  const sha16 = crypto.createHash('sha256').update(Buffer.from(msg, 'utf8')).digest().subarray(0, 16);
  assert.strictEqual(payload.subarray(52, 68).toString('hex'), sha16.toString('hex'));
});

// --- compareSpinnerPaths: the spinner-drift canary comparator (pure) ---
// All 4 shipped paths present across live reads => spinner unchanged, all buckets matched.
t('compareSpinnerPaths all-known => ok, 4 buckets', () => {
  const r = compareSpinnerPaths([...R_GSWH7_PATHS]);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.matchedBuckets, [0, 1, 2, 3]);
  assert.deepStrictEqual(r.missingBuckets, []);
  assert.strictEqual(r.unknownLive.length, 0);
  assert.strictEqual(r.spinnerSeen, 4);
});
// A live spinner-shaped path we don't recognise => DRIFT (reskin), and it is named.
t('compareSpinnerPaths reskin => not ok, names the new path', () => {
  const drifted = 'M 10,30 C 1,2 3,4 5,6 h 7 s 8,9 10,11'; // spinner-prefixed but unknown
  const r = compareSpinnerPaths([R_GSWH7_PATHS[0], R_GSWH7_PATHS[1], drifted]);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.unknownLive, [drifted]);
  assert.deepStrictEqual(r.matchedBuckets, [0, 1]);
});
// Page icons / non-spinner `d` reads are ignored (never a false positive).
t('compareSpinnerPaths ignores non-spinner paths', () => {
  const r = compareSpinnerPaths(['M 5,5 h 10 v 10', 'M0 0L1 1Z', 'M 12,3 a 4 4 0 1 0 8 0']);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.spinnerSeen, 0);
  assert.strictEqual(r.unknownLive.length, 0);
});
// Duplicate reads of the same known path collapse (dedup); ok, single bucket.
t('compareSpinnerPaths dedups repeated reads', () => {
  const r = compareSpinnerPaths([R_GSWH7_PATHS[2], R_GSWH7_PATHS[2], R_GSWH7_PATHS[2]]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.spinnerSeen, 1);
  assert.deepStrictEqual(r.matchedBuckets, [2]);
  assert.deepStrictEqual(r.missingBuckets, [0, 1, 3]);
});
// Empty input is inconclusive-shaped (ok=true but nothing seen); caller handles exit 2.
t('compareSpinnerPaths empty => ok true, spinnerSeen 0', () => {
  const r = compareSpinnerPaths([]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.spinnerSeen, 0);
  assert.strictEqual(r.sampled, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
