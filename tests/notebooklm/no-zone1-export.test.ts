import { describe, it, expect, beforeAll } from 'vitest';

/**
 * Invariant 1 guard: zone-1 self-knowledge (F62 operator model) is SEALED and
 * must NEVER be broadcast. The only export path is the shape registry, so no
 * registered shape may carry a zone-1-only feature id. If someone later adds an
 * F62 export shape, this fails.
 */
const ZONE1_ONLY_FEATURES = ['F62'];

describe('no zone-1 feature is ever an export shape', () => {
  let shapes: typeof import('../../src/core/notebooklm/shapes.js');

  beforeAll(async () => {
    shapes = await import('../../src/core/notebooklm/shapes.js');
    (await import('../../src/core/notebooklm/shapes-n1.js')).registerN1Shapes();
    (await import('../../src/core/notebooklm/shapes-n3.js')).registerN3Shapes();
  });

  it('the shape registry contains no zone-1-only feature', () => {
    const exported = shapes.allShapes().flatMap((s) => s.featureIds);
    for (const f of ZONE1_ONLY_FEATURES) {
      expect(exported).not.toContain(f);
    }
  });
});
