import { describe, it, expect } from 'vitest';
import { buildSelfDiff, publishSelfDiff } from '../../src/core/gdrive/self-diff.js';
import type { ChronicleOp } from '../../src/core/gdrive/chronicle.js';

const ops: ChronicleOp[] = [
  { tTx: '2026-07-11T00:00:00Z', op: 'add', memoryId: 'chunks/topics/infra.md', contentSha256: 'a' },
  { tTx: '2026-07-12T00:00:00Z', op: 'update', memoryId: 'chunks/topics/infra.md', contentSha256: 'b' },
  { tTx: '2026-07-13T00:00:00Z', op: 'add', memoryId: 'chunks/topics/security.md', contentSha256: 'c' },
  { tTx: '2026-07-14T00:00:00Z', op: 'deprecate', memoryId: 'structured/user_1.json', contentSha256: 'd' },
];

describe('F13 self-diff renderer', () => {
  it('summarizes memory churn + top movers + belief health', () => {
    const md = buildSelfDiff({
      fromDay: '2026-07-10',
      toDay: '2026-07-17',
      chronicleOps: ops,
      beliefs: [
        { state: 'fresh', trustTier: 'principal' },
        { state: 'stale', rederiveQueued: true, trustTier: 'agent' },
        { state: 'fresh', trustTier: 'external' },
      ],
    });
    expect(md).toContain('# Weekly Self-Diff — 2026-07-10 → 2026-07-17');
    expect(md).toContain('**2** added · **1** updated · **1** deprecated');
    expect(md).toContain('chunks/topics: +2 ~1 -0'); // infra + security adds, infra update
    expect(md).toContain('fresh: 2');
    expect(md).toContain('stale: 1');
    expect(md).toContain('re-derivation queued: 1');
    expect(md).toContain('Did the silhouette change?');
  });

  it('handles empty weeks gracefully', () => {
    const md = buildSelfDiff({ fromDay: '2026-07-10', toDay: '2026-07-17', chronicleOps: [], beliefs: [] });
    expect(md).toContain('no memory changes this week');
    expect(md).toContain('no beliefs registered');
  });

  it('renders the F53 topology slot when a map link is present', () => {
    const md = buildSelfDiff({
      fromDay: '2026-07-10', toDay: '2026-07-17', chronicleOps: [], beliefs: [],
      topology: { mapLink: 'https://drive/map.png', note: 'yes — a new security cluster appeared' },
    });
    expect(md).toContain('Latest mind map: https://drive/map.png');
    expect(md).toContain('new security cluster');
  });
});

describe('F13 self-diff publish', () => {
  it('publishes a Doc, updates in place on re-run', async () => {
    const docs = new Map<string, { name: string; content: string }>();
    let seq = 0;
    const client = {
      async listChildren() {
        return [...docs.entries()].map(([id, d]) => ({ id, name: d.name }));
      },
      async filesCreateAsGoogleDoc(name: string, _parent: string, body: string) {
        const id = `d${++seq}`;
        docs.set(id, { name, content: body });
        return { id, name };
      },
      async filesUpdateGoogleDoc(id: string, body: string) {
        docs.get(id)!.content = body;
      },
    };
    const folders = { 'ops/reports': 'FLD-reports' };
    const inputs = { fromDay: '2026-07-10', toDay: '2026-07-17', chronicleOps: [], beliefs: [] };
    const first = await publishSelfDiff(client as never, folders, inputs);
    const second = await publishSelfDiff(client as never, folders, inputs);
    expect(second.fileId).toBe(first.fileId);
    expect(docs.size).toBe(1);
    expect(second.name).toBe('self-diff-2026-07-17');
  });
});
