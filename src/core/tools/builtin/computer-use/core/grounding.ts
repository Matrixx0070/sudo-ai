/**
 * @file core/grounding.ts
 * @description GroundingResolver — turn a {@link Target} into screen coordinates.
 *
 * Resolution order (research: AX/DOM first, vision fallback):
 *   1. elementIndex  — a direct index into the snapshot's AX list (highest).
 *   2. ax-text       — match an AX element by name (+ optional role), best-scored.
 *   3. coords        — explicit x/y supplied by the caller.
 *   4. vision        — Phase 3 hook (a grounder model over the screenshot/zoom).
 *
 * The click point is the element's center. Scoring prefers exact/starts-with
 * name matches, visible+enabled state, and interactable roles.
 */

import { createLogger } from '../../../../shared/logger.js';
import type { Grounded, Snapshot, Target, UIElement } from './types.js';

const log = createLogger('computer:grounding');

const INTERACTABLE = new Set([
  'push button',
  'button',
  'toggle button',
  'check box',
  'radio button',
  'menu item',
  'text',
  'entry',
  'password text',
  'combo box',
  'list item',
  'link',
  'tab',
  'page tab',
  'slider',
  'spin button',
  'check menu item',
  'radio menu item',
  'icon',
]);

/** Optional vision fallback: given a snapshot + description, return a point. */
export type VisionGrounder = (
  snapshot: Snapshot,
  target: Target,
) => Promise<{ x: number; y: number; confidence: number } | null>;

function center(e: UIElement): { x: number; y: number } {
  return { x: Math.round(e.x + e.w / 2), y: Math.round(e.y + e.h / 2) };
}

function scoreMatch(e: UIElement, text: string, role?: string): number {
  const name = e.name.toLowerCase();
  const q = text.toLowerCase();
  if (!name) return -1;
  let score = 0;
  if (name === q) score += 100;
  else if (name.startsWith(q)) score += 70;
  else if (name.includes(q)) score += 40;
  else return -1; // no textual match at all
  if (role && e.role === role) score += 20;
  if (INTERACTABLE.has(e.role)) score += 15;
  if (e.states.includes('showing') || e.states.includes('visible')) score += 8;
  if (e.states.includes('enabled')) score += 5;
  if (e.states.includes('focusable')) score += 3;
  // Prefer smaller, more specific targets over huge containers.
  const area = Math.max(1, e.w * e.h);
  score += Math.max(0, 10 - Math.log10(area));
  return score;
}

export class GroundingResolver {
  constructor(private readonly vision?: VisionGrounder) {}

  async resolve(target: Target, snapshot: Snapshot): Promise<Grounded> {
    // 1. Direct element index.
    if (typeof target.elementIndex === 'number') {
      const e = snapshot.elements.find((el) => el.i === target.elementIndex);
      if (e && e.w > 0 && e.h > 0) {
        const c = center(e);
        return { ...c, confidence: 0.98, source: 'element-index', element: e };
      }
      return { x: -1, y: -1, confidence: 0, source: 'none', error: `elementIndex ${target.elementIndex} not found` };
    }

    // 2. AX text (+ role) match.
    if (target.text) {
      let best: { e: UIElement; s: number } | undefined;
      for (const e of snapshot.elements) {
        const s = scoreMatch(e, target.text, target.role);
        if (s >= 0 && (!best || s > best.s)) best = { e, s };
      }
      if (best) {
        const c = center(best.e);
        // Map score → confidence in a stable band.
        const confidence = Math.min(0.97, 0.5 + best.s / 200);
        return { ...c, confidence, source: 'ax-text', element: best.e };
      }
      // fall through to coords/vision if provided
    }

    // 3. Explicit coordinates.
    if (typeof target.x === 'number' && typeof target.y === 'number') {
      return { x: target.x, y: target.y, confidence: 0.6, source: 'coords' };
    }

    // 4. Vision fallback (Phase 3 wires a real grounder).
    if (this.vision) {
      try {
        const v = await this.vision(snapshot, target);
        if (v) return { x: v.x, y: v.y, confidence: v.confidence, source: 'vision' };
      } catch (e) {
        log.debug({ err: String(e) }, 'vision grounder threw');
      }
    }

    return {
      x: -1,
      y: -1,
      confidence: 0,
      source: 'none',
      error: `could not ground target ${JSON.stringify(target)}`,
    };
  }
}
