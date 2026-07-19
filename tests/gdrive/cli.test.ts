import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { runGdriveCli, type GdriveCliDeps } from '../../src/core/gdrive/cli.js';
import { buildManifest, type BrainManifest, type ManifestEntry } from '../../src/core/gdrive/manifest.js';

const hmacKey = randomBytes(32);

const entry = (logicalPath: string, sha256: string): ManifestEntry => ({
  logicalPath,
  blob: `memory/blobs/${sha256}`,
  sha256,
  zone: 2,
  bytes: 1,
  category: 'knowledge',
});

/** Collect out() lines into an array + joined string for assertions. */
function capture() {
  const lines: string[] = [];
  return { lines, out: (l: string) => lines.push(l), text: () => lines.join('\n') };
}

/** Base deps: enabled, with an injected runtime/keys/state — no live Drive. */
function baseDeps(over: Partial<GdriveCliDeps> = {}): GdriveCliDeps {
  return {
    isEnabled: () => true,
    loadKeys: () => ({ hmacKey }),
    loadBrainState: () => ({ counter: 5, lastPushAt: '2026-07-19T00:00:00Z' }),
    ...over,
  };
}

describe('F109 — gdrive CLI: status', () => {
  it('reports disabled and exits 0 when SUDO_GDRIVE is off (safe against prod)', async () => {
    const cap = capture();
    const code = await runGdriveCli(['status'], { isEnabled: () => false, out: cap.out });
    expect(code).toBe(0);
    expect(cap.text()).toContain('disabled (SUDO_GDRIVE != 1)');
  });

  it('defaults to status when no subcommand is given', async () => {
    const cap = capture();
    const code = await runGdriveCli([], { isEnabled: () => false, out: cap.out });
    expect(code).toBe(0);
    expect(cap.text()).toContain('gdrive: disabled');
  });

  it('reports brain counter, folders, and manifest revisions when enabled', async () => {
    const cap = capture();
    const client = {
      listChildren: async (_f: string) => [{ id: 'MF', name: 'manifest.json' }],
      revisionsList: async (_id: string) => [{ id: 'r1' }, { id: 'r2' }],
    };
    const code = await runGdriveCli(
      ['status'],
      baseDeps({
        out: cap.out,
        getRuntime: async () => ({ client: client as never, folders: { manifest: 'MFOLDER' }, config: { rootFolderId: 'ROOT' } as never }),
      }),
    );
    expect(code).toBe(0);
    const t = cap.text();
    expect(t).toContain('gdrive: ENABLED');
    expect(t).toContain('brain counter:  5');
    expect(t).toContain('root folder:    ROOT');
    expect(t).toContain('MF (2 revisions)');
  });
});

describe('F109 — gdrive CLI: knew-at', () => {
  it('requires a timestamp argument (exit 2)', async () => {
    const cap = capture();
    const code = await runGdriveCli(['knew-at'], baseDeps({ out: cap.out }));
    expect(code).toBe(2);
    expect(cap.text()).toContain('timestamp argument is required');
  });

  it('reconstructs the manifest known at a timestamp (calls knewAt)', async () => {
    const cap = capture();
    const manifest = buildManifest(
      { brainId: 'main', counter: 7, createdAt: '2026-07-01T00:00:00Z', entries: [entry('a.md', 'aaa'), entry('b.md', 'bbb')] },
      hmacKey,
    );
    const client = {
      listChildren: async (_f: string) => [{ id: 'MF', name: 'manifest.json' }],
      revisionsList: async (_id: string) => [{ id: 'r1', modifiedTime: '2026-07-01T00:00:00Z' }],
      revisionsGetContent: async (_id: string, _rev: string) => JSON.stringify(manifest),
    };
    const code = await runGdriveCli(
      ['knew-at', '2026-07-19T00:00:00Z'],
      baseDeps({
        out: cap.out,
        getRuntime: async () => ({ client: client as never, folders: { manifest: 'MFOLDER' }, config: {} as never }),
      }),
    );
    expect(code).toBe(0);
    const t = cap.text();
    expect(t).toContain('manifest revision: r1');
    expect(t).toContain('manifest counter:  7');
    expect(t).toContain('known paths:       2');
  });
});

describe('F109 — gdrive CLI: bisect', () => {
  it('binary-searches with a human judge and reports the first bad revision', async () => {
    const cap = capture();
    const store = new Map<string, BrainManifest>();
    const revisionIds: string[] = [];
    for (let i = 0; i < 8; i++) {
      const entries = [entry('chunks/base.jsonl', `base${i}`)];
      if (i >= 4) entries.push(entry('beliefs/bad.md', 'deadbeef'));
      const m = buildManifest({ brainId: 'main', counter: i + 1, createdAt: `2026-07-0${(i % 9) + 1}T00:00:00Z`, entries }, hmacKey);
      store.set(`rev-${i}`, m);
      revisionIds.push(`rev-${i}`);
    }
    const client = {
      listChildren: async (_f: string) => [{ id: 'MF', name: 'manifest.json' }],
      revisionsList: async (_id: string) => revisionIds.map((id) => ({ id })),
      revisionsGetContent: async (_id: string, rev: string) => JSON.stringify(store.get(rev)!),
    };
    // Judge: GOOD unless the manifest text carries beliefs/bad.md. The prompt
    // reads the revisionId out of the question and answers accordingly.
    const badRevs = new Set(['rev-4', 'rev-5', 'rev-6', 'rev-7']);
    const prompt = vi.fn(async (q: string) => {
      const m = q.match(/revision (rev-\d)/);
      return m && badRevs.has(m[1]!) ? 'n' : 'y';
    });
    const code = await runGdriveCli(
      ['bisect', '--trust'],
      baseDeps({
        out: cap.out,
        prompt,
        getRuntime: async () => ({ client: client as never, folders: { manifest: 'MFOLDER' }, config: {} as never }),
      }),
    );
    expect(code).toBe(0);
    expect(prompt).toHaveBeenCalled();
    expect(cap.text()).toContain('first bad revision: rev-4');
  });

  it('refuses a history with fewer than 2 revisions', async () => {
    const cap = capture();
    const client = {
      listChildren: async (_f: string) => [{ id: 'MF', name: 'manifest.json' }],
      revisionsList: async (_id: string) => [{ id: 'only' }],
    };
    const code = await runGdriveCli(
      ['bisect'],
      baseDeps({ out: cap.out, getRuntime: async () => ({ client: client as never, folders: { manifest: 'MFOLDER' }, config: {} as never }) }),
    );
    expect(code).toBe(1);
    expect(cap.text()).toContain('need at least 2 manifest revisions');
  });
});

describe('F109 — gdrive CLI: resume', () => {
  it('requires a taskId (exit 2)', async () => {
    const cap = capture();
    const code = await runGdriveCli(['resume'], baseDeps({ out: cap.out }));
    expect(code).toBe(2);
    expect(cap.text()).toContain('taskId argument is required');
  });

  it('is a no-op with a diagnostic when disabled', async () => {
    const cap = capture();
    const code = await runGdriveCli(['resume', 'task-1'], baseDeps({ out: cap.out, isEnabled: () => false }));
    expect(code).toBe(1);
    expect(cap.text()).toContain('disabled (SUDO_GDRIVE != 1)');
  });
});

describe('F109 — gdrive CLI: dispatch', () => {
  it('prints usage for an unknown subcommand (exit 2)', async () => {
    const cap = capture();
    const code = await runGdriveCli(['frobnicate'], { out: cap.out });
    expect(code).toBe(2);
    expect(cap.text()).toContain('unknown subcommand "frobnicate"');
    expect(cap.text()).toContain('Usage: sudo-ai gdrive');
  });

  it('prints usage for help', async () => {
    const cap = capture();
    const code = await runGdriveCli(['help'], { out: cap.out });
    expect(code).toBe(0);
    expect(cap.text()).toContain('knew-at <ISO-8601>');
  });
});
