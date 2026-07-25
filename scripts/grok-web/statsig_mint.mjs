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
  'M 10,30 C 76,147 184,172 140,213 h 188 s 166,187 15,37 C 163,80 232,230 229,25 h 64 s 161,245 246,195 C 163,60 33,103 254,44 h 113 s 219,248 162,44 C 165,249 146,63 250,24 h 61 s 241,244 226,114 C 122,87 199,67 217,116 h 254 s 66,104 248,201 C 224,43 128,251 193,215 h 54 s 167,129 30,100 C 161,68 102,31 63,136 h 183 s 120,219 238,96 C 87,51 249,140 143,120 h 231 s 252,138 205,13 C 28,63 5,236 157,183 h 121 s 183,221 138,190 C 116,191 169,238 34,110 h 84 s 199,50 185,121 C 225,184 85,87 25,99 h 240 s 110,139 244,166 C 196,186 63,83 123,117 h 224 s 223,179 160,227 C 65,138 213,86 163,165 h 26 s 216,252 102,136 C 45,47 24,132 230,155 h 248 s 28,124 170,164 C 71,103 113,4 9,135 h 139 s 118,248 167,35 C 235,199 76,228 240,138 h 14 s 143,78 144,249',
  'M 10,30 C 130,148 174,222 35,84 h 94 s 148,35 19,174 C 209,30 22,11 70,211 h 140 s 225,254 136,68 C 244,121 143,87 169,255 h 30 s 101,194 82,38 C 74,22 221,139 103,183 h 82 s 58,61 240,197 C 185,81 129,156 65,24 h 85 s 184,9 202,172 C 180,241 204,59 135,253 h 10 s 90,125 140,136 C 253,203 132,195 181,208 h 165 s 34,77 123,46 C 124,40 190,111 232,213 h 69 s 76,3 70,235 C 23,136 86,80 222,211 h 79 s 165,118 49,201 C 124,233 143,155 68,38 h 235 s 202,83 238,213 C 254,67 150,66 120,108 h 99 s 114,163 66,113 C 210,81 221,82 152,230 h 211 s 136,145 59,86 C 171,45 215,186 211,105 h 213 s 184,61 104,110 C 154,60 73,38 192,175 h 40 s 11,214 182,10 C 226,197 142,75 54,157 h 137 s 177,25 19,47 C 7,135 168,9 173,2 h 11 s 53,199 251,117',
  'M 10,30 C 140,81 143,140 103,166 h 196 s 69,160 18,172 C 255,204 30,168 233,19 h 88 s 213,3 113,156 C 188,48 11,116 159,162 h 155 s 54,58 122,178 C 104,232 76,88 139,36 h 128 s 75,112 216,93 C 122,163 166,56 189,188 h 199 s 176,239 7,214 C 207,120 215,74 142,216 h 141 s 219,116 211,208 C 76,250 228,242 84,61 h 191 s 21,96 40,130 C 13,144 0,190 13,93 h 252 s 226,152 239,91 C 127,141 172,185 176,151 h 106 s 58,155 32,220 C 190,123 73,232 15,196 h 122 s 154,45 193,156 C 58,119 147,154 16,16 h 188 s 237,123 208,247 C 47,141 53,61 176,220 h 65 s 227,85 185,243 C 247,120 211,100 255,126 h 165 s 171,69 10,117 C 251,115 111,213 245,134 h 253 s 128,213 223,168 C 153,200 85,175 228,85 h 125 s 111,158 183,182 C 219,134 235,198 174,212 h 19 s 245,84 249,131',
  'M 10,30 C 233,47 231,163 8,12 h 217 s 238,211 222,219 C 29,230 42,97 103,30 h 235 s 226,63 39,2 C 21,174 201,100 139,229 h 43 s 209,119 75,50 C 157,156 155,159 107,96 h 34 s 177,209 14,228 C 90,156 198,40 100,82 h 71 s 49,210 224,101 C 254,62 186,94 13,19 h 139 s 52,0 26,185 C 211,125 47,192 139,145 h 176 s 87,70 77,208 C 46,108 252,114 184,40 h 17 s 50,219 109,119 C 22,104 165,217 11,249 h 226 s 45,127 117,248 C 18,184 252,129 213,130 h 17 s 112,163 31,45 C 231,80 159,237 215,153 h 170 s 126,182 50,159 C 150,54 81,99 166,167 h 249 s 248,5 228,2 C 189,35 214,207 18,141 h 200 s 3,92 107,228 C 131,203 164,95 76,161 h 101 s 41,188 172,20 C 23,198 134,130 148,67 h 156 s 91,207 48,252 C 162,7 188,37 47,23 h 137 s 12,197 6,118',
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
  const g = segs[seed[21] % 16];

  const color0 = [g[0], g[1], g[2]];
  const color1 = [g[3], g[4], g[5]];
  const rot1 = Math.floor((g[6] * 300) / 255 + 60);
  const ease = cubicBezier(
    round2(g[7] / 255), round2((g[8] * 2) / 255 - 1),
    round2(g[9] / 255), round2((g[10] * 2) / 255 - 1),
  );

  const S = (seed[4] % 16) * (seed[14] % 16) * (seed[7] % 16);
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
