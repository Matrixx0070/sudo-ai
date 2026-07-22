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

// Stub the headed warm-browser statsig oracle so the browserless-fallback tests
// never launch a browser. File-scoped + hoisted (deterministic across test files);
// dormant for tests that inject `mintStatsig` or succeed on the browserless path.
vi.mock('../../src/llm/grok-statsig-oracle.js', () => ({
  getGrokStatsigOracle: () => ({ mint: async () => 'ORACLE_TOKEN_94' }),
}));

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

describe('generateGrokVideo — browserless statsig fast-path (SUDO_GROK_STATSIG_BROWSERLESS)', () => {
  // A real 48-byte seed (base64) with a known live-verified fingerprint.
  const FP_SEED = 'zGcIAVbd8I1DldqMZQjmWCf+GbDsxzCkZMy1geYQrI0Ndy2ds9O1SHmvrQGWzpO6';
  afterEach(() => {
    delete process.env['SUDO_GROK_STATSIG_BROWSERLESS'];
    delete process.env['SUDO_GROK_WARM_BROWSER'];
  });

  const videoBridge = (seedResult: Record<string, unknown>) =>
    vi.fn(async (req: { op: string; outputPath?: string }) => {
      if (req.op === 'probe') return { ok: true, status: 200, quota: { video720p: { remainingQueries: 5 } } };
      if (req.op === 'seed') return seedResult;
      if (req.op === 'video')
        return { ok: true, videoUrl: 'https://assets.grok.com/users/u/generated/v/generated_video.mp4', videoId: 'v' };
      if (req.op === 'download') return { ok: true, path: req.outputPath, bytes: 1, ftyp: true };
      return { ok: false };
    });

  it('flag ON + seed fetched → mints the statsig in pure Node (no oracle/browser)', async () => {
    process.env['SUDO_GROK_STATSIG_BROWSERLESS'] = '1';
    const NOW = (101_649_780 + 1_682_924_400) * 1000;
    const { generateGrokVideo } = await import('../../src/llm/grok-web-media.js');
    const { deriveFingerprint, computeR, STATSIG_SALT } = await import('../../src/llm/grok-statsig-mint.js');
    const crypto = await import('node:crypto');

    const bridge = videoBridge({ ok: true, status: 200, seed: FP_SEED });
    // NO mintStatsig injected → the module's browserless-first minter runs.
    const r = await generateGrokVideo('a paper boat', {
      deps: { manager: fakeManager(), bridge: bridge as never, now: () => NOW },
    });
    expect(r.videoUrl).toContain('generated_video.mp4');
    // The browserless path was taken (seed op fetched).
    expect(bridge.mock.calls.some((c) => (c[0] as { op: string }).op === 'seed')).toBe(true);

    // The token handed to the video op is a valid pure-Node statsig for FP_SEED:
    // decode (k0 = token[0]) and verify seed48 + r + the sha16 of the derived message.
    const vidCall = bridge.mock.calls.find((c) => (c[0] as { op: string }).op === 'video');
    const token = (vidCall![1] as { statsigId: string }).statsigId;
    const b = Buffer.from(token, 'base64');
    const payload = Buffer.from(b.subarray(1).map((x) => x ^ b[0]!));
    expect(payload.length).toBe(69);
    expect(payload.subarray(0, 48).toString('base64')).toBe(Buffer.from(FP_SEED, 'base64').toString('base64'));
    const r32 = computeR(NOW);
    expect(payload.readUInt32LE(48)).toBe(r32);
    const msg = `POST!/rest/app-chat/conversations/new!${r32}${STATSIG_SALT}${deriveFingerprint(FP_SEED).dHex}`;
    const sha16 = crypto.createHash('sha256').update(Buffer.from(msg, 'utf8')).digest().subarray(0, 16);
    expect(payload.subarray(52, 68).toString('hex')).toBe(sha16.toString('hex'));
  });

  it('flag ON + seed fetch fails → falls back to the browser oracle', async () => {
    process.env['SUDO_GROK_STATSIG_BROWSERLESS'] = '1';
    process.env['SUDO_GROK_WARM_BROWSER'] = '0'; // skip warm-browser provisioning
    const { generateGrokVideo } = await import('../../src/llm/grok-web-media.js');
    const bridge = videoBridge({ ok: false, status: 200, errorClass: 'no_seed', detail: 'seed meta not present' });
    const r = await generateGrokVideo('x', {
      deps: { manager: fakeManager(), bridge: bridge as never, now: () => 1 },
    });
    expect(r.videoUrl).toContain('generated_video.mp4');
    const vidCall = bridge.mock.calls.find((c) => (c[0] as { op: string }).op === 'video');
    expect((vidCall![1] as { statsigId: string }).statsigId).toBe('ORACLE_TOKEN_94');
  });

  it('flag OFF (default) → oracle path, seed op never called', async () => {
    process.env['SUDO_GROK_WARM_BROWSER'] = '0';
    const { generateGrokVideo } = await import('../../src/llm/grok-web-media.js');
    const bridge = videoBridge({ ok: true, seed: FP_SEED });
    await generateGrokVideo('x', {
      deps: { manager: fakeManager(), bridge: bridge as never, now: () => 1 },
    });
    expect(bridge.mock.calls.some((c) => (c[0] as { op: string }).op === 'seed')).toBe(false);
  });
});
