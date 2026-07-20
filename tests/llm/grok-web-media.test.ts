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

describe('generateGrokVideo', () => {
  it('missing statsig → best-effort error (no metered fallback)', async () => {
    const { generateGrokVideo } = await import('../../src/llm/grok-web-media.js');
    const noStatsig = { cookie: 'c', userAgent: 'u' };
    const bridge = vi.fn(async (req: { op: string }) => {
      if (req.op === 'probe') return { ok: true, status: 200, quota: { video: { available: true, windowSizeSeconds: 64800 } } };
      return { ok: true, images: [{ jobId: 'j', b64: JPEG_B64, publicUrl: 'https://imagine-public.x.ai/imagine-public/images/j.jpg' }] };
    });
    await expect(
      generateGrokVideo('x', { deps: { manager: fakeManager(noStatsig), bridge: bridge as never, now: () => 1 } }),
    ).rejects.toThrow(/statsig/i);
  });

  it('happy path returns the assets.grok.com mp4', async () => {
    const { generateGrokVideo } = await import('../../src/llm/grok-web-media.js');
    const bridge = vi.fn(async (req: { op: string }) => {
      if (req.op === 'probe') return { ok: true, status: 200, quota: { video: { available: true, windowSizeSeconds: 64800 } } };
      if (req.op === 'image') return { ok: true, images: [{ jobId: 'j', b64: JPEG_B64, publicUrl: 'https://imagine-public.x.ai/imagine-public/images/j.jpg' }] };
      return { ok: true, videoUrl: 'https://assets.grok.com/users/u/generated/v/generated_video.mp4', thumbnailUrl: 'https://assets.grok.com/t.jpg' };
    });
    const r = await generateGrokVideo('x', { deps: { manager: fakeManager(), bridge: bridge as never, now: () => 1 } });
    expect(r.videoUrl).toContain('generated_video.mp4');
    expect(r.imageUrl).toContain('imagine-public');
  });
});
