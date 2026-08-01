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

## The fingerprint (`Y`) — why a browser is mandatory

`animationFingerprint(seed)` is not a hash of static data. It:

1. `document.createElement('div')` and appends it to `body`;
2. derives CSS keyframes (color / transform / cubic-bezier easing) from seed bytes;
3. runs `el.animate(keyframes, 4096)`, **pauses** it, and sets `currentTime`;
4. reads it back with `getComputedStyle(el)` and extracts the numbers from
   `computed.color + computed.transform` → hex;
5. also reads an SVG path `d` attribute off a `.r-1olo0` element, and
6. opens an `RTCPeerConnection` and folds bytes of its **`.sdp`** into the state.

So the signature depends on the **actual rendered output** of the browser's animation and
layout engine plus its WebRTC stack. `jsdom`/Node implement none of these faithfully —
`getComputedStyle` over a Web Animation returns nothing, and there is no `RTCPeerConnection`.
That is the mechanical reason pure-Node minting produces correctly-shaped tokens the server
rejects: the 16 hash bytes are computed over a fingerprint the Node environment cannot
reproduce.

## Consequences for this repo

- **`grok-statsig-oracle.ts` is the correct and only design.** A headed (or genuinely
  rendering) browser is required by construction, not by accident. Keep it.
- **Drift is now diagnosable, not mysterious.** If the token starts 403ing, diff this
  module: the failure is almost always (a) the seed `<meta>` selector changing, (b) the
  keyframe derivation changing, or (c) the salt rotating. Re-run
  `webcrack`+`restringer` on `002cl82xplrx4.js` (module 1645000) and compare.
- **The runtime signing-site locator stays necessary** — the chunk hashes
  (`002cl82xplrx4` etc.) change every deploy; only the `x-statsig-id` string + the
  `await <minter>(` shape are stable anchors.

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
