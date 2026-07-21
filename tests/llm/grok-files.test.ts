/**
 * @file grok-files.test.ts
 * @description Unit tests for the subscription-free Grok file upload/management
 * lane (app-chat file lane). NO net/browser: manager and bridge are injected.
 * Asserts the flag gate, input validation (paths + ids), the request shape
 * handed to the bridge, and bridge ok:false surfacing. Mocks mirror the REAL
 * probed response shape (FileMetadata keys verified live 2026-07-21).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

beforeAll(async () => {
  await import('../../src/llm/grok-files.js');
}, 60_000);

beforeEach(() => {
  process.env['SUDO_GROK_WEBSESSION'] = '1';
});
afterEach(() => {
  delete process.env['SUDO_GROK_WEBSESSION'];
});

const SESSION = { cookie: 'cf_clearance=X; sso=Y', userAgent: 'UA' };
const FID = '4fdff36b-73d1-4e99-b744-f1c308b1f34b';
/** Real FileMetadata shape from the live probe (redacted ids). */
const META = {
  fileMetadataId: FID,
  fileName: 'probe.txt',
  fileMimeType: 'text/plain',
  fileUri: `users/uid-1/${FID}/content`,
  parsedFileUri: '',
  createTime: '2026-07-21T10:53:34.092Z',
  fileSource: 'SELF_UPLOAD_FILE_SOURCE',
};

function fakeManager(session = SESSION) {
  return {
    ensureHealthy: async () => session,
  } as unknown as import('../../src/llm/grok-web-session-manager.js').GrokWebSessionManager;
}

type BridgeReq = import('../../src/llm/grok-files.js').GrokFilesBridgeRequest;
type BridgeRes = import('../../src/llm/grok-files.js').GrokFilesBridgeResponse;
type Deps = import('../../src/llm/grok-files.js').GrokFilesDeps;

function deps(bridge: (req: BridgeReq, creds: { cookie: string; userAgent: string }) => Promise<BridgeRes>): Deps {
  return { manager: fakeManager(), bridge: bridge as Deps['bridge'] };
}

async function tmpFile(content = 'hello grok files'): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'grok-files-test-'));
  const p = path.join(dir, 'sample.txt');
  await writeFile(p, content);
  return p;
}

describe('uploadGrokFile', () => {
  it('happy path: sends base64 content + creds, parses the fileMetadataId', async () => {
    const { uploadGrokFile } = await import('../../src/llm/grok-files.js');
    const p = await tmpFile('upload me');
    const bridge = vi.fn(async (req: BridgeReq, creds: { cookie: string }) => {
      expect(req.op).toBe('upload');
      expect(req.fileName).toBe('sample.txt');
      expect(req.fileMimeType).toBe('text/plain');
      expect(Buffer.from(req.contentB64!, 'base64').toString('utf8')).toBe('upload me');
      expect(creds.cookie).toBe(SESSION.cookie);
      return { ok: true, status: 200, file: { ...META, fileName: 'sample.txt' } };
    });
    const file = await uploadGrokFile(p, { deps: deps(bridge) });
    expect(file.fileMetadataId).toBe(FID);
    expect(file.fileName).toBe('sample.txt');
    expect(bridge).toHaveBeenCalledOnce();
  });

  it('flag OFF → GrokWebDisabledError (bridge never called)', async () => {
    process.env['SUDO_GROK_WEBSESSION'] = '0';
    const { uploadGrokFile, GrokWebDisabledError } = await import('../../src/llm/grok-files.js');
    const p = await tmpFile();
    const bridge = vi.fn(async () => ({ ok: true, file: META }));
    await expect(uploadGrokFile(p, { deps: deps(bridge) })).rejects.toBeInstanceOf(GrokWebDisabledError);
    expect(bridge).not.toHaveBeenCalled();
  });

  it('empty path → TypeError; missing file → TypeError (bridge never called)', async () => {
    const { uploadGrokFile } = await import('../../src/llm/grok-files.js');
    const bridge = vi.fn(async () => ({ ok: true, file: META }));
    await expect(uploadGrokFile('', { deps: deps(bridge) })).rejects.toBeInstanceOf(TypeError);
    await expect(uploadGrokFile('/no/such/file-xyz.txt', { deps: deps(bridge) })).rejects.toBeInstanceOf(TypeError);
    expect(bridge).not.toHaveBeenCalled();
  });

  it('bridge ok:false → GrokFilesError with errorClass + status', async () => {
    const { uploadGrokFile, GrokFilesError } = await import('../../src/llm/grok-files.js');
    const p = await tmpFile();
    const bridge = async (): Promise<BridgeRes> => ({
      ok: false, status: 403, errorClass: 'cloudflare', detail: 'upload-file failed',
    });
    const err = await uploadGrokFile(p, { deps: deps(bridge) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GrokFilesError);
    expect((err as InstanceType<typeof GrokFilesError>).errorClass).toBe('cloudflare');
    expect((err as InstanceType<typeof GrokFilesError>).status).toBe(403);
  });

  it('ok:true but no fileMetadataId → GrokFilesError bad_response', async () => {
    const { uploadGrokFile, GrokFilesError } = await import('../../src/llm/grok-files.js');
    const p = await tmpFile();
    const bridge = async (): Promise<BridgeRes> => ({ ok: true, status: 200 });
    await expect(uploadGrokFile(p, { deps: deps(bridge) })).rejects.toBeInstanceOf(GrokFilesError);
  });
});

describe('getGrokFileMetadata', () => {
  it('happy path: passes the id, returns the metadata', async () => {
    const { getGrokFileMetadata } = await import('../../src/llm/grok-files.js');
    const bridge = vi.fn(async (req: BridgeReq) => {
      expect(req.op).toBe('get');
      expect(req.fileMetadataId).toBe(FID);
      return { ok: true, status: 200, file: META };
    });
    const file = await getGrokFileMetadata(FID, { deps: deps(bridge) });
    expect(file.fileUri).toBe(META.fileUri);
    expect(file.createTime).toBe(META.createTime);
  });

  it('non-UUID id → TypeError (bridge never called)', async () => {
    const { getGrokFileMetadata } = await import('../../src/llm/grok-files.js');
    const bridge = vi.fn(async () => ({ ok: true, file: META }));
    await expect(getGrokFileMetadata('', { deps: deps(bridge) })).rejects.toBeInstanceOf(TypeError);
    await expect(getGrokFileMetadata('../../etc/passwd', { deps: deps(bridge) })).rejects.toBeInstanceOf(TypeError);
    expect(bridge).not.toHaveBeenCalled();
  });

  it('unknown id: bridge not_found → GrokFilesError not_found', async () => {
    const { getGrokFileMetadata, GrokFilesError } = await import('../../src/llm/grok-files.js');
    const bridge = async (): Promise<BridgeRes> => ({
      ok: false, status: 404, errorClass: 'not_found', detail: 'file-metadata failed',
    });
    const err = await getGrokFileMetadata(FID, { deps: deps(bridge) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GrokFilesError);
    expect((err as InstanceType<typeof GrokFilesError>).errorClass).toBe('not_found');
  });
});

describe('downloadGrokFile', () => {
  it('happy path: decodes contentB64 into a Buffer alongside the metadata', async () => {
    const { downloadGrokFile } = await import('../../src/llm/grok-files.js');
    const bridge = vi.fn(async (req: BridgeReq) => {
      expect(req.op).toBe('download');
      expect(req.fileMetadataId).toBe(FID);
      return {
        ok: true, status: 200, file: META,
        contentB64: Buffer.from('round trip bytes').toString('base64'),
      };
    });
    const { file, content } = await downloadGrokFile(FID, { deps: deps(bridge) });
    expect(file.fileMetadataId).toBe(FID);
    expect(content.toString('utf8')).toBe('round trip bytes');
  });

  it('ok:true but missing contentB64 → GrokFilesError bad_response', async () => {
    const { downloadGrokFile, GrokFilesError } = await import('../../src/llm/grok-files.js');
    const bridge = async (): Promise<BridgeRes> => ({ ok: true, status: 200, file: META });
    await expect(downloadGrokFile(FID, { deps: deps(bridge) })).rejects.toBeInstanceOf(GrokFilesError);
  });
});
