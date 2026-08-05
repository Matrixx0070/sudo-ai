/**
 * Tests for post-publish metadata edits (GAP-05).
 *
 * The headline risk is not "does the title change" — it is that
 * `videos.update` is a FULL REPLACE. Sending `{snippet:{title}}` blanks the
 * description, tags and categoryId. Run over a channel, that destroys every
 * description you have. So the central assertions here are about what is
 * PRESERVED, and about what actually goes on the wire.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  updateVideoMetadata,
  mergeSnippet,
  validatePatch,
  isNoOp,
  metadataWritesEnabled,
  MAX_TITLE_CHARS,
  type MetadataDeps,
  type VideoSnippet,
} from '../../src/core/youtube/metadata.js';

const CURRENT: VideoSnippet = {
  title: 'Original title',
  description: 'A long, carefully written description that must never be silently lost.',
  tags: ['finance', 'investing', 'compound interest'],
  categoryId: '25',
};

const saved: Record<string, string | undefined> = {};
const KEYS = ['SUDO_YT_PUBLISH_ENABLED', 'YOUTUBE_OAUTH_TOKEN', 'YOUTUBE_OAUTH_CLIENT_ID',
  'YOUTUBE_OAUTH_CLIENT_SECRET', 'YOUTUBE_OAUTH_REFRESH_TOKEN'];

beforeEach(() => {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

/** Deps that serve CURRENT on read and capture the write body. */
function deps(overrides: { readOk?: boolean; writeStatus?: number } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const d: MetadataDeps & { calls: typeof calls } = {
    calls,
    token: async () => 'tok',
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      if (String(url).includes('part=snippet&id=')) {
        return {
          ok: overrides.readOk !== false,
          status: overrides.readOk === false ? 500 : 200,
          json: async () => ({ items: [{ snippet: { ...CURRENT } }] }),
          text: async () => '',
        } as unknown as Response;
      }
      const st = overrides.writeStatus ?? 200;
      return { ok: st < 300, status: st, json: async () => ({}), text: async () => 'err' } as unknown as Response;
    }) as unknown as typeof globalThis.fetch,
  };
  return d;
}

/** Enable the live-write flag + a credential. */
function enable() {
  process.env['SUDO_YT_PUBLISH_ENABLED'] = '1';
  process.env['YOUTUBE_OAUTH_TOKEN'] = 'legacy';
}

describe('mergeSnippet — the function that stops descriptions being blanked', () => {
  it('preserves every field the patch did not mention', () => {
    const merged = mergeSnippet(CURRENT, { title: 'New title' });
    expect(merged.title).toBe('New title');
    expect(merged.description).toBe(CURRENT.description);
    expect(merged.tags).toEqual(CURRENT.tags);
    expect(merged.categoryId).toBe(CURRENT.categoryId);
  });

  it('allows an explicit empty description (clearing is deliberate, not accidental)', () => {
    expect(mergeSnippet(CURRENT, { description: '' }).description).toBe('');
  });

  it('carries defaultLanguage through — the API rejects some updates without it', () => {
    const withLang = { ...CURRENT, defaultLanguage: 'en' };
    expect(mergeSnippet(withLang, { title: 'x' }).defaultLanguage).toBe('en');
  });
});

describe('validation — reject, never truncate', () => {
  it('rejects an over-length title instead of mangling it', () => {
    const errs = validatePatch({ title: 'x'.repeat(MAX_TITLE_CHARS + 1) });
    expect(errs.join(' ')).toMatch(/not truncated for you/);
  });

  it('rejects empty titles and angle brackets', () => {
    expect(validatePatch({ title: '   ' })).toHaveLength(1);
    expect(validatePatch({ title: 'a <b> c' }).join(' ')).toMatch(/< or >/);
  });

  it('rejects over-long descriptions and tag sets', () => {
    expect(validatePatch({ description: 'x'.repeat(5001) })).toHaveLength(1);
    expect(validatePatch({ tags: [ 'x'.repeat(501) ] })).toHaveLength(1);
  });

  it('accepts a valid patch', () => {
    expect(validatePatch({ title: 'A fine title', tags: ['a', 'b'] })).toEqual([]);
  });
});

describe('isNoOp', () => {
  it('detects an identical patch so the 50-unit write is skipped', () => {
    expect(isNoOp(CURRENT, mergeSnippet(CURRENT, {}))).toBe(true);
    expect(isNoOp(CURRENT, mergeSnippet(CURRENT, { title: 'different' }))).toBe(false);
  });
});

describe('updateVideoMetadata — wire behaviour', () => {
  it('is REFUSED by default — this writes to a live channel', async () => {
    const out = await updateVideoMetadata('vid1', { title: 'New' }, deps());
    expect(out.status).toBe('refused');
    if (out.status === 'refused') expect(out.blockedBy).toBe('flag');
  });

  it('sends the FULL merged snippet, not the partial patch', async () => {
    enable();
    const d = deps();
    const out = await updateVideoMetadata('vid1', { title: 'New title' }, d);

    expect(out.status).toBe('updated');
    const write = d.calls.find((c) => c.init?.method === 'PUT');
    expect(write, 'a PUT must have been issued').toBeDefined();

    const body = JSON.parse(String(write!.init!.body));
    expect(body.id).toBe('vid1');
    expect(body.snippet.title).toBe('New title');
    // The whole point: these must be present in the request.
    expect(body.snippet.description).toBe(CURRENT.description);
    expect(body.snippet.tags).toEqual(CURRENT.tags);
    expect(body.snippet.categoryId).toBe('25');
  });

  it('reads before writing — there is no path that skips the read', async () => {
    enable();
    const d = deps();
    await updateVideoMetadata('vid1', { title: 'New title' }, d);
    expect(d.calls[0]!.url).toContain('part=snippet&id=vid1');
    expect(d.calls[0]!.init?.method ?? 'GET').toBe('GET');
    expect(d.calls[1]!.init?.method).toBe('PUT');
  });

  it('charges 1 unit for the read and 50 for the write', async () => {
    enable();
    const spend = vi.fn();
    const d = { ...deps(), ledger: { spend } };
    const out = await updateVideoMetadata('vid1', { title: 'New title' }, d);
    expect(spend).toHaveBeenNthCalledWith(1, 'videos.list');
    expect(spend).toHaveBeenNthCalledWith(2, 'videos.update');
    if (out.status === 'updated') expect(out.quotaUnits).toBe(51);
  });

  it('skips the 50-unit write when nothing would change', async () => {
    enable();
    const spend = vi.fn();
    const d = { ...deps(), ledger: { spend } };
    const out = await updateVideoMetadata('vid1', { title: CURRENT.title }, d);

    expect(out.status).toBe('unchanged');
    expect(spend).toHaveBeenCalledTimes(1);          // read only
    expect(d.calls.some((c) => c.init?.method === 'PUT')).toBe(false);
  });

  it('does not write when the read fails — never guesses the current snippet', async () => {
    enable();
    const d = deps({ readOk: false });
    const out = await updateVideoMetadata('vid1', { title: 'New' }, d);
    expect(out.status).toBe('refused');
    expect(d.calls.some((c) => c.init?.method === 'PUT')).toBe(false);
  });

  it('surfaces an API failure on the write', async () => {
    enable();
    const out = await updateVideoMetadata('vid1', { title: 'New' }, deps({ writeStatus: 403 }));
    expect(out.status).toBe('refused');
    if (out.status === 'refused') expect(out.blockedBy).toBe('api');
  });

  it('validates before touching the network at all', async () => {
    enable();
    const d = deps();
    const out = await updateVideoMetadata('vid1', { title: 'x'.repeat(300) }, d);
    expect(out.status).toBe('refused');
    expect(d.calls).toHaveLength(0);
  });

  it('refuses a missing credential without spending quota', async () => {
    process.env['SUDO_YT_PUBLISH_ENABLED'] = '1';
    const spend = vi.fn();
    const out = await updateVideoMetadata('vid1', { title: 'New' }, { ...deps(), ledger: { spend } });
    expect(out.status).toBe('refused');
    if (out.status === 'refused') expect(out.blockedBy).toBe('auth');
    expect(spend).not.toHaveBeenCalled();
  });

  it('reports before/after for audit', async () => {
    enable();
    const out = await updateVideoMetadata('vid1', { title: 'New title' }, deps());
    if (out.status === 'updated') {
      expect(out.before.title).toBe('Original title');
      expect(out.after.title).toBe('New title');
      expect(out.after.description).toBe(out.before.description);
    }
  });
});

describe('metadataWritesEnabled', () => {
  it('only an explicit 1 enables live writes', () => {
    for (const v of ['0', 'true', 'yes', '']) {
      expect(metadataWritesEnabled({ SUDO_YT_PUBLISH_ENABLED: v } as NodeJS.ProcessEnv)).toBe(false);
    }
    expect(metadataWritesEnabled({ SUDO_YT_PUBLISH_ENABLED: '1' } as NodeJS.ProcessEnv)).toBe(true);
  });
});
