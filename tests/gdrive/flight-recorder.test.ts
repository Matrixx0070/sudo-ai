import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  buildRunBundle,
  packBundle,
  unpackBundle,
  verifyBundle,
  uploadBundle,
} from '../../src/core/gdrive/flight-recorder.js';

const keys = { hmacKey: randomBytes(32), encKey: randomBytes(32) };

const params = {
  runId: 'run-1',
  sessionId: 'sess-1',
  startedAt: '2026-07-16T00:00:00Z',
  finishedAt: '2026-07-16T00:01:00Z',
  outcome: 'failure' as const,
  configSnapshotHash: 'cfg-hash',
  manifestCounter: 7,
  events: [{ type: 'tool-result', digest: 'abc' }],
  traceStore: { query: (q: { sessionId?: string }) => [{ tool: 'x', session: q.sessionId }] },
  llmCalls: [{ model: 'claude', tokens: 100 }],
};

describe('F10 — flight recorder', () => {
  it('joins traces + llm calls + events into a digest-anchored bundle', () => {
    const b = buildRunBundle(params);
    expect(b.traces).toEqual([{ tool: 'x', session: 'sess-1' }]);
    expect(b.manifestCounter).toBe(7);
    expect(verifyBundle(b).ok).toBe(true);
  });

  it('pack/unpack round-trips through gzip + AES-256-GCM', () => {
    const b = buildRunBundle(params);
    const wire = packBundle(b, keys);
    expect(wire.includes(Buffer.from('sess-1'))).toBe(false); // always encrypted
    const back = unpackBundle(wire, keys);
    expect(back).toEqual(b);
  });

  it('verifyBundle (replay stub) detects payload mutation', () => {
    const b = buildRunBundle(params);
    (b.traces as unknown[]).push({ forged: true });
    expect(verifyBundle(b).ok).toBe(false);
  });

  it('refuses to pack without an encryption key', () => {
    const b = buildRunBundle(params);
    expect(() => packBundle(b, { hmacKey: keys.hmacKey })).toThrow(/BRAIN_ENC_KEY_PATH/);
  });

  it('routes failed runs to ops/incidents and successes to ops/audit', async () => {
    const uploads: Array<{ parent: string; name: string }> = [];
    const client = {
      filesCreate: async (meta: { name: string; parents?: string[] }) => {
        uploads.push({ parent: meta.parents?.[0] ?? '', name: meta.name });
        return { id: `f${uploads.length}` };
      },
    };
    const folders = { 'ops/incidents': 'FLD-inc', 'ops/audit': 'FLD-aud' };
    const failed = buildRunBundle(params);
    const ok = buildRunBundle({ ...params, runId: 'run-2', outcome: 'success' });
    const r1 = await uploadBundle(client as never, folders, failed, keys);
    const r2 = await uploadBundle(client as never, folders, ok, keys);
    expect(r1.folder).toBe('ops/incidents');
    expect(r2.folder).toBe('ops/audit');
    expect(uploads[0]).toMatchObject({ parent: 'FLD-inc', name: 'run-run-1.json.gz.enc' });
    expect(uploads[1]).toMatchObject({ parent: 'FLD-aud', name: 'run-run-2.json.gz.enc' });
  });
});
