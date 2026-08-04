/**
 * @file grok-statsig-oracle-locator.ts
 * @description Pure signing-site locator for the Grok statsig oracle, split out
 * of grok-statsig-oracle.ts (max-lines ratchet). Given a loaded app-chunk
 * source, finds the request-signing site by keying on the stable `x-statsig-id`
 * string and the nearest preceding `await <minter>(` call — robust to
 * minification because it depends on those two tokens, not chunk names or byte
 * offsets. Unit-tested against a chunk fixture; the oracle re-exports these.
 */

/** Stable string present at the request-signing site across redeploys. */
export const STATSIG_MARKER = 'x-statsig-id';
/** How far back from the marker to look for the `await <minter>(` call. */
export const BACKSCAN_WINDOW = 600;

export interface SigningSite {
  /** 0-based line of the `await <minter>(` call (for Debugger.setBreakpointByUrl). */
  lineNumber: number;
  /** 0-based column of the `await` keyword within its line. */
  columnNumber: number;
  /** The in-scope minter identifier (e.g. `d0`) to hoist onto globalThis. */
  minterName: string;
}

function offsetToLineCol(src: string, offset: number): { lineNumber: number; columnNumber: number } {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (src.charCodeAt(i) === 10 /* \n */) {
      line++;
      lineStart = i + 1;
    }
  }
  return { lineNumber: line, columnNumber: offset - lineStart };
}

/**
 * Locate the request-signing site in a loaded app-chunk source by searching for
 * the stable `x-statsig-id` string and the nearest preceding `await <minter>(`
 * call. Returns null if the pattern is absent (caller escalates Q-GWV).
 *
 * Robust to minification (single-line chunks, arbitrary identifiers) because it
 * keys on the two stable tokens, not on chunk names or byte offsets.
 */
export function locateSigningSite(source: string): SigningSite | null {
  const awaitRe = /await\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let markerIdx = source.indexOf(STATSIG_MARKER);
  while (markerIdx !== -1) {
    const windowStart = Math.max(0, markerIdx - BACKSCAN_WINDOW);
    const back = source.slice(windowStart, markerIdx);
    awaitRe.lastIndex = 0;
    let last: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    while ((m = awaitRe.exec(back)) !== null) last = m;
    if (last) {
      const offset = windowStart + last.index;
      const { lineNumber, columnNumber } = offsetToLineCol(source, offset);
      return { lineNumber, columnNumber, minterName: last[1]! };
    }
    markerIdx = source.indexOf(STATSIG_MARKER, markerIdx + STATSIG_MARKER.length);
  }
  return null;
}
