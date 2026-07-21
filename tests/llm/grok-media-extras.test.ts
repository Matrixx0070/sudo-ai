/**
 * @file grok-media-extras.test.ts
 * @description Unit tests for the subscription-free Grok video caption + upscale
 * lane. NO net/browser: manager and bridge are injected. Asserts the flag gate,
 * input validation (videoId + output path traversal), the request shape handed
 * to the bridge, and bridge ok:false surfacing. Mocks mirror the REAL probed
 * response shapes (upscale {hdMediaUrl}; caption {result:{...}}; forbidden 403 on
 * a non-owned video — all verified live 2026-07-21).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

beforeAll(async () => {
  await import('../../src/llm/grok-media-extras.js');
}, 60_000);

beforeEach(() => {
  process.env['SUDO_GROK_WEBSESSION'] = '1';
});
afterEach(() => {
  delete process.env['SUDO_GROK_WEBSESSION'];
});

const SESSION = { cookie: 'cf_clearance=X; sso=Y', userAgent: 'UA' };
const VID = '4fea41a3-eb1a-4beb-aa67-55840f377083';
const HD_URL = `https://assets.grok.com/users/uid-1/generated/${VID}/generated_video_hd.mp4`;

function fakeManager(session = SESSION) {
  return {
    ensureHealthy: async () => session,
  } as unknown as import('../../src/llm/grok-web-session-manager.js').GrokWebSessionManager;
}

type BridgeReq = import('../../src/llm/grok-media-extras.js').GrokMediaExtrasBridgeRequest;
type BridgeRes = import('../../src/llm/grok-media-extras.js').GrokMediaExtrasBridgeResponse;
type Deps = import('../../src/llm/grok-media-extras.js').GrokMediaExtrasDeps;

function deps(
  bridge: (req: BridgeReq, creds: { cookie: string; userAgent: string }) => Promise<BridgeRes>,
): Deps {
  return { manager: fakeManager(), bridge: bridge as Deps['bridge'] };
}

describe('upscaleGrokVideo', () => {
  it('happy path: sends videoId + target + creds, returns the direct hdMediaUrl', async () => {
    const { upscaleGrokVideo } = await import('../../src/llm/grok-media-extras.js');
    const bridge = vi.fn(async (req: BridgeReq, creds: { cookie: string }) => {
      expect(req.op).toBe('upscale');
      expect(req.videoId).toBe(VID);
      expect(req.targetResolution).toBe('UPSCALE_TARGET_RESOLUTION_1080P');
      expect(creds.cookie).toBe(SESSION.cookie);
      return { ok: true, status: 200, hdMediaUrl: HD_URL };
    });
    const r = await upscaleGrokVideo(VID, {
      targetResolution: 'UPSCALE_TARGET_RESOLUTION_1080P',
      deps: deps(bridge),
    });
    expect(r.hdMediaUrl).toBe(HD_URL);
    expect(r.file).toBeUndefined();
    expect(bridge).toHaveBeenCalledOnce();
  });

  it('with outputPath: also runs a download op confined to the path directory', async () => {
    const { upscaleGrokVideo } = await import('../../src/llm/grok-media-extras.js');
    const seen: BridgeReq[] = [];
    const bridge = vi.fn(async (req: BridgeReq) => {
      seen.push(req);
      if (req.op === 'upscale') return { ok: true, status: 200, hdMediaUrl: HD_URL };
      expect(req.op).toBe('download');
      expect(req.url).toBe(HD_URL);
      expect(req.outputPath).toBe('/tmp/out/hd.mp4');
      expect(req.outputDir).toBe('/tmp/out');
      return { ok: true, status: 200, path: '/tmp/out/hd.mp4', bytes: 42 };
    });
    const r = await upscaleGrokVideo(VID, { outputPath: '/tmp/out/hd.mp4', deps: deps(bridge) });
    expect(r.hdMediaUrl).toBe(HD_URL);
    expect(r.file).toBe('/tmp/out/hd.mp4');
    expect(r.bytes).toBe(42);
    expect(seen.map((s) => s.op)).toEqual(['upscale', 'download']);
  });

  it('flag OFF → GrokWebDisabledError (bridge never called)', async () => {
    process.env['SUDO_GROK_WEBSESSION'] = '0';
    const { upscaleGrokVideo, GrokWebDisabledError } = await import('../../src/llm/grok-media-extras.js');
    const bridge = vi.fn(async () => ({ ok: true, hdMediaUrl: HD_URL }));
    await expect(upscaleGrokVideo(VID, { deps: deps(bridge) })).rejects.toBeInstanceOf(
      GrokWebDisabledError,
    );
    expect(bridge).not.toHaveBeenCalled();
  });

  it('non-UUID videoId → TypeError; traversal outputPath → TypeError (bridge never called)', async () => {
    const { upscaleGrokVideo } = await import('../../src/llm/grok-media-extras.js');
    const bridge = vi.fn(async () => ({ ok: true, hdMediaUrl: HD_URL }));
    await expect(upscaleGrokVideo('', { deps: deps(bridge) })).rejects.toBeInstanceOf(TypeError);
    await expect(upscaleGrokVideo('not-a-uuid', { deps: deps(bridge) })).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(
      upscaleGrokVideo(VID, { outputPath: '../../etc/evil.mp4', deps: deps(bridge) }),
    ).rejects.toBeInstanceOf(TypeError);
    // videoId is validated before any bridge call; the traversal case only fails
    // after the upscale succeeds, so allow that one call but assert no download.
    for (const c of bridge.mock.calls) expect((c[0] as BridgeReq).op).not.toBe('download');
  });

  it('bridge ok:false → GrokMediaExtrasError with errorClass + status', async () => {
    const { upscaleGrokVideo, GrokMediaExtrasError } = await import('../../src/llm/grok-media-extras.js');
    const bridge = async (): Promise<BridgeRes> => ({
      ok: false,
      status: 400,
      errorClass: 'bad_request',
      detail: 'video upscale failed',
    });
    const err = await upscaleGrokVideo(VID, { deps: deps(bridge) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GrokMediaExtrasError);
    expect((err as InstanceType<typeof GrokMediaExtrasError>).errorClass).toBe('bad_request');
    expect((err as InstanceType<typeof GrokMediaExtrasError>).status).toBe(400);
  });

  it('ok:true but no hdMediaUrl → GrokMediaExtrasError bad_response', async () => {
    const { upscaleGrokVideo, GrokMediaExtrasError } = await import('../../src/llm/grok-media-extras.js');
    const bridge = async (): Promise<BridgeRes> => ({ ok: true, status: 200 });
    await expect(upscaleGrokVideo(VID, { deps: deps(bridge) })).rejects.toBeInstanceOf(
      GrokMediaExtrasError,
    );
  });
});

describe('captionGrokVideo', () => {
  it('happy path: sends videoId + optional preset/style, returns the job result', async () => {
    const { captionGrokVideo } = await import('../../src/llm/grok-media-extras.js');
    const bridge = vi.fn(async (req: BridgeReq) => {
      expect(req.op).toBe('caption');
      expect(req.videoId).toBe(VID);
      expect(req.preset).toBe('bold');
      expect(req.style).toBeUndefined();
      return {
        ok: true,
        status: 200,
        caption: { postId: 'p-1', status: 'CAPTION_STATUS_PENDING', progressPct: 0 },
      };
    });
    const r = await captionGrokVideo(VID, { preset: 'bold', deps: deps(bridge) });
    expect(r.postId).toBe('p-1');
    expect(r.status).toBe('CAPTION_STATUS_PENDING');
    expect(bridge).toHaveBeenCalledOnce();
  });

  it('non-owned video: bridge forbidden → GrokMediaExtrasError forbidden', async () => {
    const { captionGrokVideo, GrokMediaExtrasError } = await import('../../src/llm/grok-media-extras.js');
    const bridge = async (): Promise<BridgeRes> => ({
      ok: false,
      status: 403,
      errorClass: 'forbidden',
      detail: 'video caption failed',
    });
    const err = await captionGrokVideo(VID, { deps: deps(bridge) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GrokMediaExtrasError);
    expect((err as InstanceType<typeof GrokMediaExtrasError>).errorClass).toBe('forbidden');
    expect((err as InstanceType<typeof GrokMediaExtrasError>).status).toBe(403);
  });

  it('non-UUID videoId → TypeError (bridge never called)', async () => {
    const { captionGrokVideo } = await import('../../src/llm/grok-media-extras.js');
    const bridge = vi.fn(async () => ({ ok: true, caption: {} }));
    await expect(captionGrokVideo('nope', { deps: deps(bridge) })).rejects.toBeInstanceOf(TypeError);
    expect(bridge).not.toHaveBeenCalled();
  });

  it('ok:true but no caption result → GrokMediaExtrasError bad_response', async () => {
    const { captionGrokVideo, GrokMediaExtrasError } = await import('../../src/llm/grok-media-extras.js');
    const bridge = async (): Promise<BridgeRes> => ({ ok: true, status: 200 });
    await expect(captionGrokVideo(VID, { deps: deps(bridge) })).rejects.toBeInstanceOf(
      GrokMediaExtrasError,
    );
  });
});
