import { describe, it, expect } from 'vitest';
import { createRelease, getRelease, MAX_PINNED_REVISIONS } from '../../src/core/gdrive/releases.js';

const FOLDERS = { manifest: 'FLD-manifest', 'brains/releases': 'FLD-releases' };

function fakeClient(opts: { pinnedCount?: number } = {}) {
  const files = new Map<string, { name: string; parent: string; content: string }>();
  files.set('mf1', { name: 'manifest.json', parent: 'FLD-manifest', content: '{"counter":5}' });
  const revisions = Array.from({ length: (opts.pinnedCount ?? 0) + 2 }, (_, i) => ({
    id: `rev-${i}`,
    keepForever: i < (opts.pinnedCount ?? 0),
  }));
  const pins: Array<{ revisionId: string; keep: boolean }> = [];
  let seq = 1;
  return {
    pins,
    files,
    async listChildren(folderId: string) {
      return [...files.entries()]
        .filter(([, f]) => f.parent === folderId)
        .map(([id, f]) => ({ id, name: f.name }));
    },
    async filesDownload(fileId: string) {
      return files.get(fileId)!.content;
    },
    async filesCreate(meta: { name: string; parents?: string[] }, media?: { body: string }) {
      const id = `f${++seq}`;
      files.set(id, { name: meta.name, parent: meta.parents?.[0] ?? '', content: media?.body ?? '' });
      return { id, name: meta.name };
    },
    async revisionsList() {
      return revisions;
    },
    async revisionsSetKeepForever(_fileId: string, revisionId: string, keep: boolean) {
      pins.push({ revisionId, keep });
    },
  };
}

describe('F36 — brain releases', () => {
  it('copies the manifest bytes to brains/releases and pins the head revision', async () => {
    const client = fakeClient();
    const r = await createRelease(client as never, FOLDERS, 'stable', { date: '2026-07-16' });
    expect(r.releaseName).toBe('brain-2026-07-16-stable.json');
    expect(await getRelease(client as never, FOLDERS, r.releaseName)).toBe('{"counter":5}');
    expect(client.pins).toContainEqual({ revisionId: `rev-1`, keep: true }); // head = last revision
  });

  it('releases are immutable — same name refuses', async () => {
    const client = fakeClient();
    await createRelease(client as never, FOLDERS, 'v1', { date: '2026-07-16' });
    await expect(createRelease(client as never, FOLDERS, 'v1', { date: '2026-07-16' })).rejects.toThrow(/immutable/);
  });

  it('rotates pins past the cap (cap-aware, spec build note)', async () => {
    const client = fakeClient({ pinnedCount: MAX_PINNED_REVISIONS + 2 });
    const r = await createRelease(client as never, FOLDERS, 'rot', { date: '2026-07-16' });
    expect(r.unpinned).toBe(3); // (cap+2 existing) + 1 new - cap
    expect(client.pins.filter((p) => !p.keep)).toHaveLength(3);
    // Oldest pins are the ones released.
    expect(client.pins.filter((p) => !p.keep).map((p) => p.revisionId)).toEqual(['rev-0', 'rev-1', 'rev-2']);
  });

  it('validates tags', async () => {
    const client = fakeClient();
    await expect(createRelease(client as never, FOLDERS, 'bad tag!', {})).rejects.toThrow(/invalid tag/);
  });
});
