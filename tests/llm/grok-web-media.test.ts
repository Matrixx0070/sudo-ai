/**
 * @file grok-web-media.test.ts
 * @description Unit tests for GW5 subscription-free media. NO net/browser/disk-net:
 * the manager + bridge are injected; images write to a temp DATA dir. Asserts the
 * flag gate, quota-exhaustion informing (never metered fallback), and the
 * video-needs-statsig best-effort guard.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// DATA_DIR is captured at import time in paths.ts → set it BEFORE importing the module.
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'gw5-'));
  process.env['DATA_DIR'] = dir;
  process.env['SUDO_GROK_WEBSESSION'] = '1';
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env['DATA_DIR'];
  delete process.env['SUDO_GROK_WEBSESSION'];
  vi.resetModules();
});

const SESSION = { cookie: 'cf_clearance=X; sso=Y', userAgent: 'UA', statsigId: 'SS' };

function fakeManager(session = SESSION) {
  return {
    ensureHealthy: async () => session,
  } as unknown as import('../../src/llm/grok-web-session-manager.js').GrokWebSessionManager;
}

// A tiny 1x1 JPEG in base64 (enough to write + decode).
const JPEG_B64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AfwD/2Q==';

describe('generateGrokImage', () => {
  it('writes JPEGs and returns the public URL', async () => {
    const { generateGrokImage } = await import('../../src/llm/grok-web-media.js');
    const bridge = vi.fn(async (req: { op: string }) => {
      if (req.op === 'probe') return { ok: true, status: 200, quota: { image: { available: true, windowSizeSeconds: 64800 } } };
      return { ok: true, images: [{ jobId: 'j1', b64: JPEG_B64, publicUrl: 'https://imagine-public.x.ai/imagine-public/images/j1.jpg' }] };
    });
    const r = await generateGrokImage('a cat', { deps: { manager: fakeManager(), bridge: bridge as never, now: () => 1 } });
    expect(r.url).toContain('imagine-public');
    expect(r.files).toHaveLength(1);
    expect(existsSync(r.files[0]!)).toBe(true);
  });

  it('flag OFF → GrokWebDisabledError', async () => {
    process.env['SUDO_GROK_WEBSESSION'] = '0';
    const { generateGrokImage, GrokWebDisabledError } = await import('../../src/llm/grok-web-media.js');
    await expect(
      generateGrokImage('x', { deps: { manager: fakeManager(), bridge: (async () => ({ ok: true })) as never, now: () => 1 } }),
    ).rejects.toBeInstanceOf(GrokWebDisabledError);
  });

  it('quota exhausted → informs, never calls image bridge', async () => {
    const { generateGrokImage, GrokWebQuotaExhaustedError } = await import('../../src/llm/grok-web-media.js');
    let imageCalled = false;
    const bridge = vi.fn(async (req: { op: string }) => {
      if (req.op === 'probe') return { ok: true, status: 200, quota: { image: { available: false, windowSizeSeconds: 0 } } };
      imageCalled = true;
      return { ok: true, images: [] };
    });
    await expect(
      generateGrokImage('x', { deps: { manager: fakeManager(), bridge: bridge as never, now: () => 1 } }),
    ).rejects.toBeInstanceOf(GrokWebQuotaExhaustedError);
    expect(imageCalled).toBe(false);
  });
});

describe('generateGrokVideo (oracle lane, GWV2)', () => {
  it('text-to-video: mints one fresh statsig, returns mp4 URL + downloaded file', async () => {
    const { generateGrokVideo } = await import('../../src/llm/grok-web-media.js');
    let minted = 0;
    const bridge = vi.fn(async (req: { op: string; outputPath?: string }) => {
      if (req.op === 'probe') return { ok: true, status: 200, quota: { video720p: { remainingQueries: 5 } } };
      if (req.op === 'video')
        return {
          ok: true,
          videoUrl: 'https://assets.grok.com/users/u/generated/v/generated_video.mp4',
          videoId: 'v',
          thumbnailUrl: 'https://assets.grok.com/t.jpg',
        };
      if (req.op === 'download') return { ok: true, path: req.outputPath, bytes: 2048, ftyp: true };
      return { ok: false };
    });
    const r = await generateGrokVideo('a paper boat on calm water', {
      deps: {
        manager: fakeManager(),
        bridge: bridge as never,
        now: () => 1,
        mintStatsig: async () => {
          minted++;
          return 'TOK94';
        },
      },
    });
    expect(minted).toBe(1);
    expect(r.videoUrl).toContain('generated_video.mp4');
    expect(r.imageUrl).toBeNull(); // text-to-video has no source image
    expect(r.file).toContain('grok-video-');
    expect(r.videoId).toBe('v');
    // The video request carried NO imageUrl (text-to-video) and the minted token.
    const vidCall = bridge.mock.calls.find((c) => (c[0] as { op: string }).op === 'video');
    expect((vidCall![0] as { imageUrl?: string }).imageUrl).toBeUndefined();
    expect((vidCall![1] as { statsigId?: string }).statsigId).toBe('TOK94');
  });

  it('403 anti-bot → re-mints exactly once, then a clear error (never metered fallback)', async () => {
    const { generateGrokVideo } = await import('../../src/llm/grok-web-media.js');
    let minted = 0;
    const bridge = vi.fn(async (req: { op: string }) => {
      if (req.op === 'probe') return { ok: true, status: 200, quota: { video720p: { remainingQueries: 5 } } };
      if (req.op === 'video') return { ok: false, status: 403, errorClass: 'statsig', detail: 'anti-bot' };
      return { ok: false };
    });
    await expect(
      generateGrokVideo('x', {
        deps: {
          manager: fakeManager(),
          bridge: bridge as never,
          now: () => 1,
          mintStatsig: async () => {
            minted++;
            return 'T';
          },
        },
      }),
    ).rejects.toThrow(/anti-bot|spend money/i);
    expect(minted).toBe(2); // initial mint + exactly one re-mint
  });

  it('quota exhausted → informs, never mints or calls the video bridge', async () => {
    const { generateGrokVideo, GrokWebQuotaExhaustedError } = await import('../../src/llm/grok-web-media.js');
    let minted = 0;
    let videoCalled = false;
    const bridge = vi.fn(async (req: { op: string }) => {
      if (req.op === 'probe') return { ok: true, status: 200, quota: { video720p: { remainingQueries: 0 } } };
      if (req.op === 'video') videoCalled = true;
      return { ok: true };
    });
    await expect(
      generateGrokVideo('x', {
        deps: {
          manager: fakeManager(),
          bridge: bridge as never,
          now: () => 1,
          mintStatsig: async () => {
            minted++;
            return 'T';
          },
        },
      }),
    ).rejects.toBeInstanceOf(GrokWebQuotaExhaustedError);
    expect(minted).toBe(0);
    expect(videoCalled).toBe(false);
  });

  it('image-to-video: passes imageUrl through to the bridge', async () => {
    const { generateGrokVideo } = await import('../../src/llm/grok-web-media.js');
    const bridge = vi.fn(async (req: { op: string; outputPath?: string }) => {
      if (req.op === 'probe') return { ok: true, status: 200, quota: { video720p: { remainingQueries: 5 } } };
      if (req.op === 'video')
        return { ok: true, videoUrl: 'https://assets.grok.com/users/u/generated/v/generated_video.mp4', videoId: 'v' };
      if (req.op === 'download') return { ok: true, path: req.outputPath, bytes: 10, ftyp: true };
      return { ok: false };
    });
    const imageUrl = 'https://imagine-public.x.ai/imagine-public/images/j.jpg';
    const r = await generateGrokVideo('x', {
      imageUrl,
      deps: { manager: fakeManager(), bridge: bridge as never, now: () => 1, mintStatsig: async () => 'T' },
    });
    expect(r.imageUrl).toBe(imageUrl);
    const vidCall = bridge.mock.calls.find((c) => (c[0] as { op: string }).op === 'video');
    expect((vidCall![0] as { imageUrl?: string }).imageUrl).toBe(imageUrl);
  });
});
