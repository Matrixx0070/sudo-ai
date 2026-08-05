# grok.com `x-statsig-id` — the actual minter algorithm (SOURCE-level RE)

Recovered from grok.com's own shipped JavaScript on 2026-08-01, not inferred from
traffic. Tooling: `webcrack` (unpack Turbopack + unminify) → `restringer` (peel the
proxy-function obfuscation). This is the first time this repo has the *algorithm* rather
than a black-box "the oracle mints it" description.

## Why this matters

Every prior doc treated the minter as opaque and the browser oracle as an empirical
necessity ("pure-Node 403s, so we need a browser"). This proves **from source** why:
the token folds in outputs that only a real rendering engine can produce. The oracle
architecture in `grok-statsig-oracle.ts` is now validated by the code, and the
long-dead "path B / pure-Node minter" is confirmed *impossible in principle*, not just
unlucky.

## The module chain (how it's hidden)

The signing site sets the header from a lazily-loaded module, three hops deep — which is
why traffic capture never sees the algorithm and the runtime-locator in the oracle exists:

```
ud(request)                         // adds x-statsig-id + x-xai-request-id
  └─ us(path, method) → module 4629918
       └─ chunk static/chunks/002cl82xplrx4.js → module 1645000  ← the minter
```

On any error the code falls back to `btoa("x0:"+err)` — that's the `x0:` token prefix
seen on failures.

## The algorithm (module 1645000, `.default()`)

```js
async (path, method) => {
  const ts   = floor((Date.now() - 1682924400_000) / 1000);   // epoch base 1682924400
  const tsLE = new Uint8Array(new Uint32Array([ts]).buffer);   // little-endian u32
  const seed = cachedSeed || readSeed();                       // <meta name^=gr> content, base64-decoded
  const fp   = animationFingerprint(seed);                     // see below — BROWSER ONLY

  const hash = await crypto.subtle.digest('sha-256',
      utf8( `${method}!${path}!${ts}` + "obfiowerehiring" + fp ));

  const body = [ Math.random()*256,          // 1 random byte
                 ...seed,
                 ...tsLE,
                 ...first16(hash).concat(j),  // j = extra collected state
                 3 ];                         // version byte
  return base64url( body.map(xorMask) );      // '=' stripped
}
```

- **Hardcoded salt: `"obfiowerehiring"`** — literally "obfi… we're hiring", an xAI
  recruiting Easter egg baked into the signature. It is a constant; it does not rotate.
- **Epoch base `1682924400`** (≈ 2023-05-01). The timestamp is seconds since then, so the
  server's accept-window is checked against this offset, not Unix epoch directly.
- `first16(hash)` — only the first 16 bytes of the SHA-256 are used.

## The fingerprint (`Y`)

`animationFingerprint(seed)`:

1. `document.createElement('div')` and appends it to `body`;
2. derives CSS keyframes (color / transform / cubic-bezier easing) from seed bytes;
3. runs `el.animate(keyframes, 4096)`, **pauses** it, and sets `currentTime` to a
   seed-derived phase;
4. reads it back with `getComputedStyle(el)` and extracts the numbers from
   `computed.color + computed.transform` → hex (`dHex`).

## CORRECTION — a browser is NOT mandatory; I overclaimed

An earlier revision of this file said this fingerprint makes pure-Node minting "impossible
in principle." **That is wrong, and the proof is already in this repo.**

Because the animation is *paused at a fixed, seed-derived `currentTime` with seed-derived
keyframes*, its `getComputedStyle` output is a **pure function of the seed** — no wall-clock,
no live rendering needed to know what a browser *would* compute. `grok-seat`'s
`src/grok-statsig-mint.ts` reimplements exactly that in pure math (`computeDhex(color,
transform)`) and its tests assert it **byte-exact against 16 live browser loads**
(`computeDhex('rgb(58,139,186)','matrix(1,0,0,1,0,0)') === '3a8bba100100'`). A working
byte-exact Node minter refutes "impossible."

So the accurate statement:

- The **oracle is the ROBUST path**, not a hard necessity. Its value is that it never has to
  *track* the algorithm — the real browser recomputes it after every grok deploy for free.
  The pure-Node minter is faster and browserless but must be kept in exact lockstep with this
  module or it drifts.
- Two elements in the current source are NOT (yet) shown to gate anything, and I should not
  claim they do: the **`Math.random()*256` first body byte** (line 281) is a per-mint nonce —
  random every call, so the server cannot be checking it — and the **`RTCPeerConnection.sdp`**
  reads (lines 99, 221 of the restringed module) sit in `_0x`-named blocks restringer could
  not clean, i.e. **possibly decoy/dead code** planted to mislead this exact analysis.
  Whether either is folded into the verified hash is **UNVERIFIED**; the byte-exact Node
  minter succeeding without them is evidence they are not.

## The 08-01 statsig drift, explained

This is the real payoff. `project-statsig-algorithm-drift-2026-08-01` records that the
pure-Node minter began producing correctly-shaped tokens the gate 403s. This RE gives the
mechanism: the Node reimplementation fell **out of lockstep** with a changed shipped
algorithm — the seed→keyframe derivation, the seed byte indices, or the `currentTime` phase
changed in a grok deploy, so `dHex` no longer matches. It was NEVER that browser-only
state got added. The fix is not "abandon pure-Node"; it is **re-derive `computeDhex` from the
current module 1645000** (webcrack+restringer, as here) and update the fixtures.

## Consequences for this repo

- **`grok-statsig-oracle.ts` remains the right default** — robustness without tracking.
  `grok-statsig-mint.ts` (browserless) is the fast path and is viable, but only while its
  fixtures match the live module.
- **Drift is now diffable, not mysterious.** Compare module 1645000: seed `<meta>` selector,
  the byte indices feeding keyframe/currentTime, the salt. Update the shared
  `seed → dHex` fixtures.
- **The runtime signing-site locator stays necessary** — chunk hashes (`002cl82xplrx4` etc.)
  rotate every deploy; only the `x-statsig-id` string + `await <minter>(` shape are stable.

## Reproduce

```bash
# 1. pull the app HTML + the 93 eager chunks (cookie session, curl_cffi)
# 2. the signing site lives in the chunk containing "x-statsig-id":
npx webcrack <that-chunk>.js -o unpacked        # → module 4629918 → chunk 002cl82xplrx4.js
# 3. fetch that lazy chunk, then:
npx webcrack 002cl82xplrx4.js -o u3
npx restringer u3/deobfuscated.js -o minter_clean.js   # module 1645000 = the minter
```

Everything here is read-only static analysis of client code the browser already downloads.
No token was replayed; no endpoint was exercised to obtain it.
