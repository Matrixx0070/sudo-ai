/**
 * @file core/perception.ts
 * @description PerceptionService — captures a fused {@link Snapshot} (screenshot
 * + windows + AX elements) for a display, plus zoom-crop and snapshot-diff.
 *
 * Hybrid perception, per the research: the AX tree (cheap, structured) is the
 * primary channel; the screenshot is always present as the universal fallback
 * and for vision grounding. Window geometry (wmctrl) both feeds grounding and
 * lets us intersect the session-global AX tree down to THIS display.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createLogger } from '../../../../shared/logger.js';
import type { Snapshot, UIElement, WindowInfo } from './types.js';
import { dumpAxTree } from './atspi.js';

const execFileAsync = promisify(execFile);
const log = createLogger('computer:perception');

export interface PerceptionOptions {
  /** Include the AX channel. Default true. */
  accessibility?: boolean;
  /** Restrict AX elements to those intersecting this display's windows. Default true. */
  intersectWindows?: boolean;
  maxAxElements?: number;
  axTimeoutMs?: number;
}

function pngDimensions(buf: Buffer): { width: number; height: number } {
  // PNG: 8-byte sig, then IHDR chunk; width/height are big-endian u32 at 16/20.
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  return { width: 0, height: 0 };
}

function rectsIntersect(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export class PerceptionService {
  private seq = 0;
  private cache = new Map<string, { snap: Snapshot; at: number }>();

  constructor(private readonly opts: PerceptionOptions = {}) {}

  /**
   * Return a recent snapshot for the display if one was captured within `ttlMs`,
   * else capture fresh. Speeds up read-only perception when the screen has not
   * been mutated since the last look. Invalidate after any action.
   */
  async captureCached(display: string, ttlMs = 400): Promise<Snapshot> {
    const hit = this.cache.get(display);
    if (hit && Date.now() - hit.at <= ttlMs) return hit.snap;
    const snap = await this.capture(display);
    this.cache.set(display, { snap, at: Date.now() });
    return snap;
  }

  /** Drop any cached snapshot for a display (call after a mutating action). */
  invalidate(display: string): void {
    this.cache.delete(display);
  }

  /** Capture a fused snapshot of the given display. */
  async capture(display: string): Promise<Snapshot> {
    const ts = Date.now();
    const seq = this.seq++;

    const [png, windows] = await Promise.all([this.screenshot(display), this.windows(display)]);
    const { width, height } = pngDimensions(png);
    const hash = createHash('sha256').update(png).digest('hex');

    let elements: UIElement[] = [];
    let axAvailable = false;
    if (this.opts.accessibility !== false) {
      elements = await dumpAxTree({
        display,
        maxElements: this.opts.maxAxElements ?? 400,
        timeoutMs: this.opts.axTimeoutMs ?? 8000,
      });
      axAvailable = elements.length > 0;
      if (axAvailable && this.opts.intersectWindows !== false && windows.length > 0) {
        elements = this.filterToWindows(elements, windows);
      }
    }

    return {
      seq,
      ts,
      display,
      screenshot: png.toString('base64'),
      width,
      height,
      hash,
      elements,
      windows,
      axAvailable,
    };
  }

  /** Crop a region [x,y,w,h] out of a snapshot's screenshot, upscaled 2x for legibility. */
  async zoom(snapshot: Snapshot, x: number, y: number, w: number, h: number): Promise<string> {
    const png = Buffer.from(snapshot.screenshot, 'base64');
    const dir = await mkdtemp(join(tmpdir(), 'cu-zoom-'));
    const src = join(dir, 'src.png');
    const out = join(dir, 'zoom.png');
    await writeFile(src, png);
    const cw = Math.max(1, Math.round(w));
    const ch = Math.max(1, Math.round(h));
    const cx = Math.max(0, Math.round(x));
    const cy = Math.max(0, Math.round(y));
    // ImageMagick: crop then 2x resize (sharper reading of small UI regions).
    await execFileAsync('convert', [
      src,
      '-crop',
      `${cw}x${ch}+${cx}+${cy}`,
      '+repage',
      '-resize',
      '200%',
      out,
    ]);
    const zoomed = await readFile(out);
    return zoomed.toString('base64');
  }

  /** Cheap change test: do two snapshots differ visually? */
  static changed(before: Snapshot, after: Snapshot): boolean {
    return before.hash !== after.hash;
  }

  private async screenshot(display: string): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), 'cu-shot-'));
    const out = join(dir, 'shot.png');
    await execFileAsync('scrot', ['-o', out], { env: { ...process.env, DISPLAY: display }, timeout: 10000 });
    return readFile(out);
  }

  private async windows(display: string): Promise<WindowInfo[]> {
    const env = { ...process.env, DISPLAY: display };
    let activeId = '';
    try {
      const { stdout } = await execFileAsync('xdotool', ['getactivewindow'], { env, timeout: 2000 });
      activeId = stdout.trim();
    } catch {
      /* no active window / no WM */
    }
    try {
      // -lG adds geometry: id desktop x y w h host title
      const { stdout } = await execFileAsync('wmctrl', ['-lG'], { env, timeout: 3000 });
      const wins: WindowInfo[] = [];
      for (const line of stdout.split('\n')) {
        const m = line.match(/^(0x[0-9a-fA-F]+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+\S+\s+(.*)$/);
        if (!m) continue;
        const id = m[1];
        const idDec = String(parseInt(id, 16));
        wins.push({
          id,
          x: parseInt(m[3], 10),
          y: parseInt(m[4], 10),
          w: parseInt(m[5], 10),
          h: parseInt(m[6], 10),
          title: m[7],
          active: activeId !== '' && (activeId === idDec || activeId === id),
        });
      }
      return wins;
    } catch {
      return [];
    }
  }

  private filterToWindows(elements: UIElement[], windows: WindowInfo[]): UIElement[] {
    const rects = windows
      .filter((w) => w.w && w.h)
      .map((w) => ({ x: w.x ?? 0, y: w.y ?? 0, w: w.w ?? 0, h: w.h ?? 0 }));
    if (rects.length === 0) return elements;
    return elements.filter((e) => e.w > 0 && e.h > 0 && rects.some((r) => rectsIntersect(e, r)));
  }
}
