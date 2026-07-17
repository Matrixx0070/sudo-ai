import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'dyad-'));
process.env['DATA_DIR'] = tmp;

type Datasets = typeof import('../../src/core/gdrive/datasets.js');
type Dyad = typeof import('../../src/core/gdrive/dyad.js');
type ShapesN3 = typeof import('../../src/core/notebooklm/shapes-n3.js');
let datasets: Datasets, dyad: Dyad, shapesN3: ShapesN3;

const NOW = Date.parse('2026-07-17T00:00:00Z');
const DAY = 24 * 3600_000;
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

beforeAll(async () => {
  datasets = await import('../../src/core/gdrive/datasets.js');
  dyad = await import('../../src/core/gdrive/dyad.js');
  shapesN3 = await import('../../src/core/notebooklm/shapes-n3.js');
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => rmSync(join(tmp, 'gdrive'), { recursive: true, force: true }));

function seed() {
  // recent (≤30d): 2 verification corrections; older (30–60d): 1 verification; old (90d): 1 timezone
  datasets.appendDatasetRow('corrections', { doc: 'a', correction: 'run verification before done', directive: true, marker: 'F69', _at: daysAgo(5) });
  datasets.appendDatasetRow('corrections', { doc: 'b', correction: 'verification skipped again', directive: true, marker: null, _at: daysAgo(20) });
  datasets.appendDatasetRow('corrections', { doc: 'a', correction: 'verification is mandatory', directive: false, marker: null, _at: daysAgo(45) });
  datasets.appendDatasetRow('corrections', { doc: 'c', correction: 'timezone offset wrong', directive: false, marker: null, _at: daysAgo(90) });
}

describe('F66 dyad health audit', () => {
  it('windows corrections and reports the trend', () => {
    seed();
    const s = dyad.buildDyadStats(() => NOW);
    expect(s.total).toBe(4);
    expect(s.last7).toBe(1);
    expect(s.last30).toBe(2);
    expect(s.prev30).toBe(1); // the 45d-old one
    expect(s.trend).toBe('worsening'); // last30 (2) > prev30 (1)
    expect(s.distinctDocs).toBe(3);
    expect(s.markers).toEqual({ F69: 1 });
    expect(s.directiveShare).toBeCloseTo(2 / 4, 5);
  });

  it('renders a stats appendix', () => {
    seed();
    const body = dyad.renderDyadHealthReport(dyad.buildDyadStats(() => NOW));
    expect(body).toContain('Dyad health audit');
    expect(body).toContain('Trend: worsening');
    expect(body).toContain('distinct documents corrected: 3');
  });
});

describe('F49 operator calibration — blind spots', () => {
  it('flags a theme corrected in both windows as persistent', () => {
    seed();
    const spots = dyad.buildBlindSpots({ recentDays: 30, minTotal: 2, now: () => NOW });
    const verif = spots.find((s) => s.theme === 'verification')!;
    expect(verif.total).toBe(3);
    expect(verif.recent).toBe(2);
    expect(verif.older).toBe(1);
    expect(verif.persistent).toBe(true);
    // timezone appears once → below minTotal, absent
    expect(spots.find((s) => s.theme === 'timezone')).toBeUndefined();
    // persistent themes rank first
    expect(spots[0]!.persistent).toBe(true);
  });

  it('renders the blind-spots report', () => {
    seed();
    const body = dyad.renderBlindSpotsReport(dyad.buildBlindSpots({ now: () => NOW }));
    expect(body).toContain('blind spots (F49)');
    expect(body).toContain('PERSISTENT');
    expect(body).toContain('verification');
  });
});

describe('F49/F66 export shapes are zone-2', () => {
  it('produce non-empty bodies that pass the zone screen', async () => {
    seed();
    const [health] = await shapesN3.dyadHealthShape.compile({ now: () => new Date(NOW) } as never);
    const [spots] = await shapesN3.blindSpotsShape.compile({ now: () => new Date(NOW) } as never);
    expect(health!.body).toContain('Dyad health audit');
    expect(spots!.body).toContain('blind spots');
  });
});
