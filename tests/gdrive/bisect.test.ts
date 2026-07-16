import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { bisectBrain, diffManifests } from '../../src/core/gdrive/bisect.js';
import { buildManifest, type BrainManifest, type ManifestEntry } from '../../src/core/gdrive/manifest.js';

const hmacKey = randomBytes(32);
const keys = { hmacKey };

const entry = (logicalPath: string, sha256: string): ManifestEntry => ({
  logicalPath,
  blob: `memory/blobs/${sha256}`,
  sha256,
  zone: 2,
  bytes: 1,
  category: 'knowledge',
});

/**
 * Synthetic 8-revision history: revisions 0..3 are GOOD; revision 4 plants
 * the bad memory ("beliefs/bad.md") and 4..7 stay BAD.
 */
function history(): { revisionIds: string[]; store: Map<string, BrainManifest> } {
  const store = new Map<string, BrainManifest>();
  const revisionIds: string[] = [];
  for (let i = 0; i < 8; i++) {
    const entries = [entry('chunks/base.jsonl', `base${i}`)];
    if (i >= 4) entries.push(entry('beliefs/bad.md', 'deadbeef'));
    const m = buildManifest(
      { brainId: 'main', counter: i + 1, createdAt: `2026-07-0${(i % 9) + 1}T00:00:00Z`, entries },
      hmacKey,
    );
    const rev = `rev-${i}`;
    revisionIds.push(rev);
    store.set(rev, m);
  }
  return { revisionIds, store };
}

function fakeClient(store: Map<string, BrainManifest>) {
  return {
    revisionsGetContent: async (_fileId: string, revisionId: string) =>
      JSON.stringify(store.get(revisionId)!),
  };
}

describe('F9 — memory bisection', () => {
  it('converges on the planted bad revision and reports the manifest diff', async () => {
    const { revisionIds, store } = history();
    const judge = async (m: BrainManifest) =>
      !m.entries.some((e) => e.logicalPath === 'beliefs/bad.md');

    const result = await bisectBrain(fakeClient(store) as never, 'MF', revisionIds, judge, keys);
    expect(result.firstBadRevisionId).toBe('rev-4');
    expect(result.lastGoodRevisionId).toBe('rev-3');
    expect(result.diff!.added.map((e) => e.logicalPath)).toContain('beliefs/bad.md');
  });

  it('uses O(log n) judge calls with trusted endpoints', async () => {
    const { revisionIds, store } = history();
    const judge = async (m: BrainManifest) =>
      !m.entries.some((e) => e.logicalPath === 'beliefs/bad.md');
    const result = await bisectBrain(fakeClient(store) as never, 'MF', revisionIds, judge, keys, {
      trustEndpoints: true,
    });
    expect(result.firstBadRevisionId).toBe('rev-4');
    expect(result.judgeCalls).toBeLessThanOrEqual(3); // ceil(log2(8)) = 3
  });

  it('rejects an inverted range (start not good / end not bad)', async () => {
    const { revisionIds, store } = history();
    const alwaysBad = async () => false;
    await expect(
      bisectBrain(fakeClient(store) as never, 'MF', revisionIds, alwaysBad, keys),
    ).rejects.toThrow(/start is not GOOD/);
    const alwaysGood = async () => true;
    await expect(
      bisectBrain(fakeClient(store) as never, 'MF', revisionIds, alwaysGood, keys),
    ).rejects.toThrow(/end is not BAD/);
  });

  it('refuses tampered historical revisions (signature checked per revision)', async () => {
    const { revisionIds, store } = history();
    // rev-3 is the first midpoint of an 8-wide range, so the search always
    // visits it — signature verification is per VISITED revision.
    const tampered = { ...store.get('rev-3')!, counter: 999 };
    store.set('rev-3', tampered as BrainManifest);
    const judge = async () => true;
    await expect(
      bisectBrain(fakeClient(store) as never, 'MF', revisionIds, judge, keys, { trustEndpoints: true }),
    ).rejects.toThrow(/HMAC mismatch/);
  });

  it('diffManifests reports added/removed/changed', () => {
    const a = buildManifest(
      { brainId: 'x', counter: 1, createdAt: 't', entries: [entry('keep.md', 'k1'), entry('gone.md', 'g1'), entry('mut.md', 'm1')] },
      hmacKey,
    );
    const b = buildManifest(
      { brainId: 'x', counter: 2, createdAt: 't', entries: [entry('keep.md', 'k1'), entry('new.md', 'n1'), entry('mut.md', 'm2')] },
      hmacKey,
    );
    const d = diffManifests(a, b);
    expect(d.added.map((e) => e.logicalPath)).toEqual(['new.md']);
    expect(d.removed.map((e) => e.logicalPath)).toEqual(['gone.md']);
    expect(d.changed.map((c) => c.logicalPath)).toEqual(['mut.md']);
  });
});
