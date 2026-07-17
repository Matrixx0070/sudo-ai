import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'error-atlas-'));
process.env['DATA_DIR'] = tmp;

type Datasets = typeof import('../../src/core/gdrive/datasets.js');
type Atlas = typeof import('../../src/core/gdrive/error-atlas.js');
type Seam = typeof import('../../src/core/agent/bias-priors-seam.js');
type ShapesN3 = typeof import('../../src/core/notebooklm/shapes-n3.js');
let datasets: Datasets, atlas: Atlas, seam: Seam, shapesN3: ShapesN3;

beforeAll(async () => {
  datasets = await import('../../src/core/gdrive/datasets.js');
  atlas = await import('../../src/core/gdrive/error-atlas.js');
  seam = await import('../../src/core/agent/bias-priors-seam.js');
  shapesN3 = await import('../../src/core/notebooklm/shapes-n3.js');
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(join(tmp, 'gdrive'), { recursive: true, force: true });
  atlas._resetAtlasMemo();
  seam.setBiasPriorsProvider(null);
});

function seed() {
  // "verification" recurs 3×, "timezone" 2×, "colour" 1× (below minCount).
  datasets.appendDatasetRow('corrections', { doc: 'd1', correction: 'always run verification before claiming done', directive: true, marker: 'F69' });
  datasets.appendDatasetRow('corrections', { doc: 'd2', correction: 'you skipped verification again, verify first', directive: true, marker: null });
  datasets.appendDatasetRow('corrections', { doc: 'd3', correction: 'verification of output is mandatory', directive: false, marker: 'F61' });
  datasets.appendDatasetRow('corrections', { doc: 'd4', correction: 'the timezone handling was wrong', directive: false, marker: null });
  datasets.appendDatasetRow('corrections', { doc: 'd5', correction: 'timezone offsets need care', directive: false, marker: null });
  datasets.appendDatasetRow('corrections', { doc: 'd6', correction: 'colour mismatch', directive: false, marker: null });
}

describe('F69 characteristic-error atlas', () => {
  it('clusters recurring themes ranked by distinct-correction count', () => {
    seed();
    const a = atlas.buildErrorAtlas({ minCount: 2 });
    expect(a.total).toBe(6);
    const keys = a.categories.map((c) => c.key);
    expect(keys).toContain('verification');
    expect(keys).toContain('timezone');
    expect(keys).not.toContain('colour'); // count 1 < minCount
    const verif = a.categories.find((c) => c.key === 'verification')!;
    expect(verif.count).toBe(3);
    expect(verif.markers).toEqual(['F61', 'F69']);
    // verification (3) ranks above timezone (2)
    expect(keys.indexOf('verification')).toBeLessThan(keys.indexOf('timezone'));
  });

  it('directiveShare reflects how many were explicit directives', () => {
    seed();
    const verif = atlas.buildErrorAtlas({ minCount: 2 }).categories.find((c) => c.key === 'verification')!;
    expect(verif.directiveShare).toBeCloseTo(2 / 3, 5);
  });

  it('preamble lists the top themes; empty when no signal', () => {
    expect(atlas.atlasPreamble()).toBe(''); // no corrections seeded yet
    atlas._resetAtlasMemo();
    seed();
    const p = atlas.atlasPreamble();
    expect(p).toContain('CHARACTERISTIC-ERROR PRIORS');
    expect(p).toContain('verification');
  });

  it('TTL memo returns the cached atlas until the window elapses', () => {
    seed();
    let clock = 1_000_000;
    const first = atlas.getErrorAtlas(() => clock);
    // add a new theme; within TTL the memo should NOT reflect it
    datasets.appendDatasetRow('corrections', { doc: 'd7', correction: 'latency latency latency budget', directive: false, marker: null });
    clock += 60_000; // < 5min TTL
    expect(atlas.getErrorAtlas(() => clock)).toBe(first);
    clock += 5 * 60_000; // now past TTL
    const refreshed = atlas.getErrorAtlas(() => clock);
    expect(refreshed).not.toBe(first);
  });
});

describe('F69 bias-priors seam', () => {
  it('is a no-op until wired, then returns the provider preamble; fail-open', () => {
    expect(seam.getBiasPriorsPreamble()).toBe('');
    seam.setBiasPriorsProvider(() => 'PRIORS');
    expect(seam.getBiasPriorsPreamble()).toBe('PRIORS');
    seam.setBiasPriorsProvider(() => { throw new Error('boom'); });
    expect(seam.getBiasPriorsPreamble()).toBe('');
  });
});

describe('F69 export shape (zone-2)', () => {
  it('screens a zone-1 correction example out of the broadcast atlas', async () => {
    // A correction carrying a secret-looking token must be withheld by the screen.
    datasets.appendDatasetRow('corrections', { doc: 'd1', correction: 'stop pasting the AKIAIOSFODNN7EXAMPLE key into logs', directive: true, marker: null });
    datasets.appendDatasetRow('corrections', { doc: 'd2', correction: 'the AKIAIOSFODNN7EXAMPLE key belongs in a secret ref', directive: true, marker: null });
    const [doc] = await shapesN3.errorAtlasShape.compile({ now: () => new Date() } as never);
    // The secret example must not appear verbatim in the shape body.
    expect(doc!.body).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });
});
