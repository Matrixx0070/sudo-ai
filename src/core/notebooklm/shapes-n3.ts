/**
 * @file notebooklm/shapes-n3.ts
 * @description N3 broadcast shapes. F69 — the characteristic-error atlas as a
 * zone-2 self-knowledge Doc (the same clustering that feeds the live planner's
 * bias-priors preamble). Every correction example is screened to zone-2 before
 * it can be broadcast — the atlas is derived from principal corrections, which
 * may contain zone-1 material, so the hard screen applies example-by-example.
 */

import { screenRecords } from './zone-screen.js';
import { registerShape, type ShapeSpec } from './shapes.js';
import type { ErrorAtlas } from '../gdrive/error-atlas.js';

export const errorAtlasShape: ShapeSpec = {
  id: 'error-atlas',
  featureIds: ['F69'],
  mode: 'rolling',
  folder: 'notebooklm/architecture',
  cadence: 'weekly',
  async compile() {
    const { buildErrorAtlas, renderAtlasReport } = await import('../gdrive/error-atlas.js');
    const atlas = buildErrorAtlas();
    // Screen the theme key AND each example to zone-2; drop what fails.
    const categories = atlas.categories
      .map((c) => {
        const keyKept = screenRecords([c.key], (k) => k).kept.length > 0;
        if (!keyKept) return null;
        const { kept } = screenRecords(c.examples, (e) => e);
        return { ...c, examples: kept };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);
    const screened: ErrorAtlas = { total: atlas.total, categories };
    return [{ name: 'error-atlas', body: renderAtlasReport(screened) }];
  },
};

let registered = false;
export function registerN3Shapes(): void {
  if (registered) return;
  registerShape(errorAtlasShape);
  registered = true;
}
