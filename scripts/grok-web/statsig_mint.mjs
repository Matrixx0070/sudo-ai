// grok.com x-statsig-id minter — pure Node (node:crypto + math only).
//
// STATUS (2026-07-22): FULLY reverse-engineered and byte-verified against the live
// minter (webpack module 4629918, function `o(path,method)`). Token assembly, the
// dHex transform, AND the seed->fingerprint derivation are all closed. `mintStatsigFromSeed`
// mints a browser-identical token from the raw seed alone (pure Node, no browser).
// deriveFingerprint was verified byte-exact (pure seed->dHex) against 24 live loads.
//
// Verified facts (all reproduced live via CDP oracle on http://127.0.0.1:9223):
//   message = `${METHOD}!${PATH}!${r}obfiowerehiring${dHex}`   (salt = obfiowerehiring)
//   payload = seed48 ++ rLE32 ++ sha256(utf8(message))[0..16] ++ [0x03]   // 69 bytes
//   token   = base64([k0] ++ payload.map(b => b ^ k0)).replace(/=+$/,'')  // k0 = self-describing XOR mask
//   r       = Math.floor(nowMs/1000 - 1682924400)
//   dHex    = Array.from((colorStr+transformStr).matchAll(/([\d.-]+)/g),
//                        m => Number(Number(m[0]).toFixed(2)).toString(16))
//                  .join('').replace(/[.-]/g,'')
// The minter reads colorStr = getComputedStyle(el).color  ("rgb(R, G, B)")
//                   transformStr = getComputedStyle(el).transform ("matrix(a,b,c,d,0,0)" or "none")
// where `el` is a DIV the minter creates and animates with seed-derived color+rotate.

import crypto from 'node:crypto';

export const STATSIG_SALT = 'obfiowerehiring';
export const R_EPOCH = 1682924400; // seconds; VERIFIED (floor(nowMs/1000 - R_EPOCH))

export function computeR(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000 - R_EPOCH);
}

// dHex = fingerprint tail of the hashed message. Pure function of the two
// getComputedStyle strings. VERIFIED byte-exact against 3 independent live pairs
// (identity, rotate ~9.39deg, rotate ~15.12deg). See statsig_mint.test.mjs.
export function computeDhex(colorStr, transformStr) {
  const s = String(colorStr || '') + String(transformStr || '');
  const nums = [...s.matchAll(/([\d.-]+)/g)].map(m => m[0]);
  return nums
    .map(v => Number(Number(v).toFixed(2)).toString(16))
    .join('')
    .replace(/[.-]/g, '');
}

// Convenience: build color/transform strings from raw fingerprint numbers, then dHex.
// rgb = [R,G,B] (0-255 ints); angleDeg = rotation in degrees (0 -> identity/"none").
export function dhexFromFingerprint({ rgb, angleDeg }) {
  const colorStr = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  let transformStr;
  if (!angleDeg) {
    transformStr = 'matrix(1, 0, 0, 1, 0, 0)';
  } else {
    const rad = (angleDeg * Math.PI) / 180;
    const c = Math.cos(rad), s = Math.sin(rad);
    const f = x => (Object.is(x, -0) ? 0 : x);
    transformStr = `matrix(${f(c)}, ${f(s)}, ${f(-s)}, ${f(c)}, 0, 0)`;
  }
  return computeDhex(colorStr, transformStr);
}

// Assemble the token. `fingerprint` is one of:
//   { dHex: '<hex>' }                                  (precomputed fingerprint)
//   { color: 'rgb(R, G, B)', transform: 'matrix(...)' } (raw getComputedStyle strings)
//   { rgb: [R,G,B], angleDeg: N }                       (raw fingerprint numbers)
// VERIFIED: given the correct fingerprint, the token is byte-identical to the browser.
export function mintStatsig(seedContent, path, method, nowMs = Date.now(), fingerprint = {}, k0 = null) {
  const seed48 = Buffer.from(seedContent, 'base64');
  if (seed48.length !== 48) throw new Error(`seed not 48 bytes: got ${seed48.length}`);

  let dHex;
  if (fingerprint.dHex != null) dHex = fingerprint.dHex;
  else if (fingerprint.color != null) dHex = computeDhex(fingerprint.color, fingerprint.transform);
  else if (fingerprint.rgb != null) dHex = dhexFromFingerprint(fingerprint);
  else throw new Error('mintStatsig: fingerprint required (dHex | color+transform | rgb+angleDeg) — see deriveFingerprint');

  const r = computeR(nowMs);
  const rLE = Buffer.alloc(4);
  rLE.writeUInt32LE(r >>> 0, 0);

  const message = `${method}!${path}!${r}${STATSIG_SALT}${dHex}`;
  const sha16 = crypto.createHash('sha256').update(Buffer.from(message, 'utf8')).digest().subarray(0, 16);
  const payload = Buffer.concat([seed48, rLE, sha16, Buffer.from([0x03])]);

  const kk = k0 == null ? crypto.randomBytes(1)[0] : k0;
  const masked = Buffer.from([kk, ...payload.map(b => b ^ kk)]);
  return masked.toString('base64').replace(/=+$/, '');
}

// ── deriveFingerprint: seed -> {color, transform} (RESOLVED 2026-07-22) ──────────
// Reversed by RC4-deobfuscating module 4629918 (functions y/M/F/_/Wn) and verified
// byte-exact against 24 independent live loads (pure seed -> dHex, zero captured
// values). The live minter, decoded:
//   bucket = seed[5] % 4                       -> one of 4 fixed .r-gswh7 spinner paths
//   segs   = d.substring(9).split('C').map(parseNums)          // y()
//   g      = segs[ seed[41] % 16 ]             // the chosen bezier segment
//   color0 = rgb(g[0..2]),  color1 = rgb(g[3..5])              // M()
//   rot1   = floor(g[6]*300/255 + 60) deg                      // F(g[6],60,360,true)
//   easing = cubic-bezier( round2(g[7]/255), round2(g[8]*2/255-1),
//                          round2(g[9]/255), round2(g[10]*2/255-1) )   // F(..).toFixed(2)
//   el.animate(M(g), 4096); pause(); currentTime = round(S/10)*10      // _(), B=2**(4*3)
//     where S = (seed[19]%16) * (seed[29]%16) * (seed[36]%16)
//   eased  = cubicBezierY(easing, currentTime/4096)
//   color  = clamp0..255(round(lerp(color0, color1, eased)))   // getComputedStyle .color
//   angle  = rot1 * eased    -> matrix(cos, sin, -sin, cos, 0, 0)   // .transform
// dHex is then computeDhex(color, transform) — the existing verified transform.

const ANIM_DURATION_MS = 4096; // B = 2 ** (4 * 3), decoded from the minter

// SCAFFOLD: the 4 .r-gswh7 loading-spinner `d` paths are grok static assets, byte-stable
// across the redeploys observed but not guaranteed forever. If grok reskins the spinner
// these change and minting breaks (403). EARLY WARNING: scripts/grok-web/statsig_canary.mjs
// diffs these against the live spinner on a schedule and exits non-zero on drift — run it
// to pre-empt the 403 rather than discover it in prod. Re-capture via
// scripts/grok-web/statsig_capture.mjs and re-derive (group by seed[5] % 4). Selected by seed[5] % 4.
export const R_GSWH7_PATHS = [
  'M 10,30 C 181,84 148,129 230,60 h 158 s 192,156 131,59 C 252,117 198,145 56,148 h 244 s 113,78 68,169 C 184,234 11,152 12,127 h 3 s 180,18 45,212 C 29,87 106,99 125,136 h 163 s 102,55 67,38 C 36,143 211,14 131,45 h 200 s 242,119 168,120 C 128,11 11,114 163,84 h 128 s 31,223 195,215 C 217,90 202,150 183,84 h 83 s 39,154 62,172 C 177,53 50,22 46,168 h 17 s 104,56 203,78 C 55,240 239,169 172,188 h 59 s 47,89 7,70 C 158,186 69,14 197,240 h 204 s 143,189 224,128 C 106,12 37,82 239,114 h 232 s 251,177 230,92 C 0,94 80,136 7,23 h 242 s 250,144 144,139 C 193,171 243,244 44,138 h 188 s 168,94 3,97 C 208,164 52,7 119,59 h 33 s 14,124 143,7 C 164,91 37,194 68,253 h 255 s 107,50 230,78 C 235,242 192,5 72,127 h 66 s 69,25 28,18',
  'M 10,30 C 161,86 79,1 250,46 h 236 s 71,57 202,104 C 73,243 73,48 134,82 h 215 s 199,238 185,182 C 177,217 161,61 103,88 h 185 s 173,144 130,84 C 73,252 134,237 10,129 h 2 s 82,141 37,84 C 151,20 181,120 139,41 h 175 s 170,97 177,39 C 54,40 160,0 194,193 h 105 s 59,200 254,61 C 250,12 106,44 63,104 h 129 s 116,211 161,169 C 252,122 158,137 179,173 h 80 s 167,84 20,0 C 223,158 93,245 243,16 h 21 s 29,169 205,220 C 52,16 150,231 177,255 h 33 s 87,38 210,175 C 161,90 193,221 81,78 h 155 s 54,75 209,116 C 131,112 234,201 203,2 h 224 s 247,213 96,236 C 55,243 71,56 227,251 h 251 s 57,44 193,13 C 158,39 121,208 35,48 h 126 s 235,230 207,141 C 88,168 147,67 78,9 h 26 s 107,180 165,16 C 79,113 70,135 237,167 h 204 s 155,204 34,174',
  'M 10,30 C 165,231 172,236 16,233 h 187 s 10,46 9,37 C 31,55 150,14 136,209 h 128 s 35,114 121,171 C 30,206 65,93 183,0 h 188 s 6,185 205,62 C 152,16 55,136 193,135 h 168 s 170,102 145,74 C 21,48 65,152 15,179 h 176 s 225,176 40,15 C 39,77 20,170 244,53 h 48 s 70,165 162,202 C 107,242 178,221 217,166 h 175 s 115,14 120,44 C 249,108 211,25 56,69 h 23 s 245,109 218,71 C 163,196 119,116 182,77 h 124 s 57,101 56,192 C 67,100 138,29 171,225 h 253 s 71,230 141,171 C 188,12 48,131 210,149 h 134 s 59,174 10,144 C 67,188 135,41 96,104 h 213 s 26,163 214,50 C 19,208 87,3 146,190 h 12 s 97,227 19,130 C 138,61 140,54 109,155 h 203 s 105,244 5,70 C 123,180 46,37 92,68 h 53 s 174,114 171,65 C 97,81 240,36 8,159 h 136 s 42,6 79,10',
  'M 10,30 C 130,153 240,10 217,62 h 201 s 52,100 76,202 C 140,176 110,131 92,37 h 90 s 222,128 205,170 C 1,75 6,24 188,1 h 105 s 243,143 203,140 C 236,180 106,92 83,98 h 198 s 45,238 238,230 C 95,37 66,236 249,99 h 254 s 210,223 214,82 C 126,185 62,70 132,27 h 29 s 20,212 245,138 C 221,9 206,119 38,29 h 106 s 238,183 12,176 C 14,147 200,14 77,162 h 183 s 186,216 72,94 C 186,9 76,127 20,113 h 183 s 116,39 92,190 C 114,1 7,209 28,22 h 116 s 190,138 4,128 C 92,186 112,116 131,251 h 111 s 215,39 96,231 C 175,230 16,224 95,110 h 146 s 177,180 1,128 C 85,71 191,99 123,66 h 51 s 206,150 119,84 C 233,115 152,250 198,21 h 23 s 140,89 54,216 C 38,47 106,241 56,59 h 39 s 242,251 200,215 C 126,153 144,101 59,175 h 20 s 203,109 136,54',
];

// All 4 spinner paths share this exact prefix — a low-false-positive signature that
// separates a live `.r-gswh7` spinner `d` from unrelated SVG icon paths on the page.
export const SPINNER_PATH_PREFIX = 'M 10,30';

/**
 * Canary comparator: given the raw `d` strings observed on live grok loads, decide
 * whether the spinner still matches our shipped R_GSWH7_PATHS. Pure + deterministic
 * (no browser, no network) so it is unit-testable. Only spinner-shaped reads (prefix
 * SPINNER_PATH_PREFIX) are considered, so page icons never cause false positives.
 * @param {string[]} livePaths raw `d` attribute strings observed live
 * @param {readonly string[]} knownPaths shipped paths (defaults to R_GSWH7_PATHS)
 * @returns {{ok:boolean, sampled:number, spinnerSeen:number, unknownLive:string[], matchedBuckets:number[], missingBuckets:number[]}}
 *   ok is false only when a spinner-shaped live path is NOT one of knownPaths (a reskin).
 *   spinnerSeen===0 is NOT drift (nothing observed) — the caller treats that as inconclusive.
 */
export function compareSpinnerPaths(livePaths, knownPaths = R_GSWH7_PATHS) {
  const spinnerLive = [...new Set(
    (livePaths || []).filter(p => typeof p === 'string' && p.startsWith(SPINNER_PATH_PREFIX)),
  )];
  const known = new Map(knownPaths.map((p, i) => [p, i]));
  const unknownLive = spinnerLive.filter(p => !known.has(p));
  const matchedBuckets = [...new Set(
    spinnerLive.filter(p => known.has(p)).map(p => known.get(p)),
  )].sort((a, b) => a - b);
  const missingBuckets = knownPaths.map((_, i) => i).filter(i => !matchedBuckets.includes(i));
  return {
    ok: unknownLive.length === 0,
    sampled: (livePaths || []).length,
    spinnerSeen: spinnerLive.length,
    unknownLive,
    matchedBuckets,
    missingBuckets,
  };
}

const round2 = v => Number(v.toFixed(2));
const clamp255 = v => Math.max(0, Math.min(255, v));

// CSS cubic-bezier timing function: solve X(t)=p (Newton) then return Y(t). Matches
// the browser to within the 2-decimal rounding computeDhex applies (verified 24/24).
function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sampX = t => ((ax * t + bx) * t + cx) * t;
  const sampXd = t => (3 * ax * t + 2 * bx) * t + cx;
  const sampY = t => ((ay * t + by) * t + cy) * t;
  return p => {
    let t = p;
    for (let i = 0; i < 60; i++) {
      const x = sampX(t) - p;
      if (Math.abs(x) < 1e-10) break;
      const d = sampXd(t);
      if (Math.abs(d) < 1e-10) break;
      t -= x / d;
    }
    return sampY(Math.max(0, Math.min(1, t)));
  };
}

// Derive the fingerprint {color, transform, rgb, angleDeg, dHex} from the raw seed
// (base64 <meta name^=gr> content, 48 bytes). Pure Node, no browser.
export function deriveFingerprint(seedContent) {
  const seed = Buffer.from(seedContent, 'base64');
  if (seed.length !== 48) throw new Error(`seed not 48 bytes: got ${seed.length}`);

  const path = R_GSWH7_PATHS[seed[5] % 4];
  const segs = path.slice(9).split('C')
    .map(s => s.replace(/[^\d]+/g, ' ').trim().split(' ').filter(Boolean).map(Number));
  const g = segs[seed[41] % 16];

  const color0 = [g[0], g[1], g[2]];
  const color1 = [g[3], g[4], g[5]];
  const rot1 = Math.floor((g[6] * 300) / 255 + 60);
  const ease = cubicBezier(
    round2(g[7] / 255), round2((g[8] * 2) / 255 - 1),
    round2(g[9] / 255), round2((g[10] * 2) / 255 - 1),
  );

  const S = (seed[19] % 16) * (seed[29] % 16) * (seed[36] % 16);
  const currentTime = Math.round(S / 10) * 10;
  const eased = ease(currentTime / ANIM_DURATION_MS);

  const rgb = [0, 1, 2].map(i => clamp255(Math.round(color0[i] + (color1[i] - color0[i]) * eased)));
  const angleDeg = rot1 * eased;

  const color = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  let transform;
  if (currentTime === 0) {
    transform = 'matrix(1, 0, 0, 1, 0, 0)';
  } else {
    const rad = (angleDeg * Math.PI) / 180;
    const c = Math.cos(rad), s = Math.sin(rad);
    const f = x => (Object.is(x, -0) ? 0 : x);
    transform = `matrix(${f(c)}, ${f(s)}, ${f(-s)}, ${f(c)}, 0, 0)`;
  }
  return { color, transform, rgb, angleDeg, dHex: computeDhex(color, transform) };
}

// Convenience: full pure-Node mint straight from the seed content (no fingerprint arg).
export function mintStatsigFromSeed(seedContent, path, method, nowMs = Date.now(), k0 = null) {
  return mintStatsig(seedContent, path, method, nowMs, deriveFingerprint(seedContent), k0);
}

export default { mintStatsig, mintStatsigFromSeed, computeDhex, dhexFromFingerprint, computeR, deriveFingerprint, STATSIG_SALT, R_EPOCH };
