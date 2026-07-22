/**
 * @file grok-workspaces.test.ts
 * @description Unit tests for the READ-ONLY grok workspaces lanes (list /
 * detail / files / file content+download). NO net/browser/disk: the manager +
 * bridge are injected. Mocks mirror the REAL response shapes probed live
 * 2026-07-22 (list → {"workspaces":[]}, per-id shapes from the app bundle's
 * workspaceRepository* client). The live grok.com round-trip is proven
 * separately (never in CI).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

beforeEach(() => {
  process.env['SUDO_GROK_WEBSESSION'] = '1';
});
afterEach(() => {
  delete process.env['SUDO_GROK_WEBSESSION'];
  vi.resetModules();
});

const SESSION = { cookie: 'cf_clearance=X; sso=Y', userAgent: 'UA' };
const WID = '11111111-2222-3333-4444-555555555555';
function fakeManager(session = SESSION) {
  return {
    ensureHealthy: async () => session,
  } as unknown as import('../../src/llm/grok-web-session-manager.js').GrokWebSessionManager;
}
function deps(bridge: unknown) {
  return { manager: fakeManager(), bridge: bridge as never };
}

describe('listGrokWorkspaces', () => {
  it('sends a list op with cookie creds and parses the workspaces array', async () => {
    const { listGrokWorkspaces } = await import('../../src/llm/grok-workspaces.js');
    const bridge = vi.fn(async (req: { op: string; shared?: boolean }, creds: { cookie: string; userAgent: string }) => {
      expect(req.op).toBe('list');
      expect(req.shared).toBeUndefined();
      expect(creds.cookie).toBe(SESSION.cookie);
      expect(creds.userAgent).toBe(SESSION.userAgent);
      // Mirrors the live GET /rest/workspaces shape (workspace keys from the
      // app bundle's dB mapper).
      return {
        ok: true,
        workspaces: [{ workspaceId: WID, name: 'Research', createTime: '2026-07-01T00:00:00Z' }],
        nextPageToken: '',
      };
    });
    const r = await listGrokWorkspaces({ deps: deps(bridge) });
    expect(r.workspaces).toHaveLength(1);
    expect(r.workspaces[0]?.workspaceId).toBe(WID);
    expect(r.nextPageToken).toBe('');
    expect(bridge).toHaveBeenCalledOnce();
  });

  it('empty seat (live 2026-07-22: {"workspaces":[]}) → empty array, no throw', async () => {
    const { listGrokWorkspaces } = await import('../../src/llm/grok-workspaces.js');
    const bridge = vi.fn(async () => ({ ok: true, workspaces: [], nextPageToken: '' }));
    const r = await listGrokWorkspaces({ deps: deps(bridge) });
    expect(r.workspaces).toEqual([]);
  });

  it('shared:true rides through to the bridge (shared list lane)', async () => {
    const { listGrokWorkspaces } = await import('../../src/llm/grok-workspaces.js');
    const bridge = vi.fn(async (req: { shared?: boolean }) => {
      expect(req.shared).toBe(true);
      return { ok: true, workspaces: [], nextPageToken: '' };
    });
    await listGrokWorkspaces({ shared: true, deps: deps(bridge) });
    expect(bridge).toHaveBeenCalledOnce();
  });

  it('flag OFF → GrokWebDisabledError (never calls the bridge)', async () => {
    process.env['SUDO_GROK_WEBSESSION'] = '0';
    const { listGrokWorkspaces, GrokWebDisabledError } = await import('../../src/llm/grok-workspaces.js');
    let called = false;
    await expect(
      listGrokWorkspaces({
        deps: deps(async () => {
          called = true;
          return { ok: true, workspaces: [] };
        }),
      }),
    ).rejects.toBeInstanceOf(GrokWebDisabledError);
    expect(called).toBe(false);
  });

  it('bridge ok:false → structured GrokWorkspacesError throw', async () => {
    const { listGrokWorkspaces, GrokWorkspacesError } = await import('../../src/llm/grok-workspaces.js');
    const bridge = vi.fn(async () => ({ ok: false, errorClass: 'cloudflare', detail: 'Just a moment' }));
    const err = await listGrokWorkspaces({ deps: deps(bridge) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GrokWorkspacesError);
    expect((err as InstanceType<typeof GrokWorkspacesError>).errorClass).toBe('cloudflare');
    expect((err as Error).message).toMatch(/grok-workspaces list failed: cloudflare/);
  });

  it('ok reply without a workspaces array → bad_response (no silent empty)', async () => {
    const { listGrokWorkspaces } = await import('../../src/llm/grok-workspaces.js');
    const bridge = vi.fn(async () => ({ ok: true }));
    await expect(listGrokWorkspaces({ deps: deps(bridge) })).rejects.toThrow(/no workspaces array/);
  });
});

describe('getGrokWorkspace / getGrokComputerRoot', () => {
  it('bad workspaceId → TypeError (never calls the bridge)', async () => {
    const { getGrokWorkspace } = await import('../../src/llm/grok-workspaces.js');
    let called = false;
    await expect(
      getGrokWorkspace('not-a-uuid!', {
        deps: deps(async () => {
          called = true;
          return { ok: true };
        }),
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(called).toBe(false);
  });

  it('parses the detail bundle (workspace + side reads incl. computer-root access)', async () => {
    const { getGrokWorkspace, getGrokComputerRoot } = await import('../../src/llm/grok-workspaces.js');
    const bridge = vi.fn(async (req: { op: string; workspaceId?: string }) => {
      expect(req.op).toBe('detail');
      expect(req.workspaceId).toBe(WID);
      // Shapes from the bundle: {connectorIds}, {collectionIds},
      // {permissions}, computer-root/access {state, provider}.
      return {
        ok: true,
        workspace: { workspaceId: WID, name: 'Research', isReadonly: false },
        connectorIds: ['conn-1'],
        collectionIds: [],
        permissions: { userPermissions: [] },
        computerRoot: { state: 'COMPUTER_ROOT_ACCESS_STATE_OK', provider: 'GOOGLE_DRIVE' },
      };
    });
    const d = await getGrokWorkspace(WID, { deps: deps(bridge) });
    expect(d.workspace.name).toBe('Research');
    expect(d.connectorIds).toEqual(['conn-1']);
    expect(d.computerRoot?.provider).toBe('GOOGLE_DRIVE');
    const root = await getGrokComputerRoot(WID, { deps: deps(bridge) });
    expect(root?.state).toBe('COMPUTER_ROOT_ACCESS_STATE_OK');
  });

  it('unknown id → structured not_found (live probe: 404 access-denied)', async () => {
    const { getGrokWorkspace, GrokWorkspacesError } = await import('../../src/llm/grok-workspaces.js');
    const bridge = vi.fn(async () => ({
      ok: false,
      status: 404,
      errorClass: 'not_found',
      detail: 'HTTP 404: Workspace not found or access denied',
    }));
    const err = await getGrokWorkspace(WID, { deps: deps(bridge) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GrokWorkspacesError);
    expect((err as InstanceType<typeof GrokWorkspacesError>).errorClass).toBe('not_found');
    expect((err as InstanceType<typeof GrokWorkspacesError>).status).toBe(404);
  });
});

describe('listGrokWorkspaceFiles', () => {
  it('parses the files listing (bundle dx shape) and passes path/recursive', async () => {
    const { listGrokWorkspaceFiles } = await import('../../src/llm/grok-workspaces.js');
    const bridge = vi.fn(async (req: { op: string; path?: string; recursive?: boolean }) => {
      expect(req.op).toBe('files');
      expect(req.path).toBe('docs');
      expect(req.recursive).toBe(true);
      return {
        ok: true,
        files: [
          { path: 'docs/plan.md', name: 'plan.md', isDirectory: false, size: 812, mimeType: 'text/markdown' },
          { path: 'docs/img', name: 'img', isDirectory: true },
        ],
        path: 'docs',
      };
    });
    const r = await listGrokWorkspaceFiles(WID, { path: 'docs', recursive: true, deps: deps(bridge) });
    expect(r.files).toHaveLength(2);
    expect(r.files[1]?.isDirectory).toBe(true);
    expect(r.path).toBe('docs');
  });

  it('traversal in the listing path → TypeError (never calls the bridge)', async () => {
    const { listGrokWorkspaceFiles } = await import('../../src/llm/grok-workspaces.js');
    let called = false;
    await expect(
      listGrokWorkspaceFiles(WID, {
        path: '../secrets',
        deps: deps(async () => {
          called = true;
          return { ok: true, files: [] };
        }),
      }),
    ).rejects.toThrow(/must not contain/);
    expect(called).toBe(false);
  });
});

describe('file content + download', () => {
  it('getGrokWorkspaceFileContent returns the signed-URL metadata block', async () => {
    const { getGrokWorkspaceFileContent } = await import('../../src/llm/grok-workspaces.js');
    const bridge = vi.fn(async (req: { op: string; path?: string; download?: boolean }) => {
      expect(req.op).toBe('file_content');
      expect(req.path).toBe('docs/plan.md');
      expect(req.download).toBeUndefined();
      // Bundle shape: {signedUrl, expiresAt, mimeType, size, downloadSignedUrl}.
      return {
        ok: true,
        content: { signedUrl: 'https://REDACTED', mimeType: 'text/markdown', size: 812 },
      };
    });
    const c = await getGrokWorkspaceFileContent(WID, 'docs/plan.md', { deps: deps(bridge) });
    expect(c.mimeType).toBe('text/markdown');
  });

  it('download decodes contentB64 into a Buffer', async () => {
    const { downloadGrokWorkspaceFile } = await import('../../src/llm/grok-workspaces.js');
    const bridge = vi.fn(async (req: { download?: boolean }) => {
      expect(req.download).toBe(true);
      return {
        ok: true,
        content: { mimeType: 'text/plain', size: 5 },
        contentB64: Buffer.from('hello').toString('base64'),
      };
    });
    const { content, meta } = await downloadGrokWorkspaceFile(WID, 'notes.txt', { deps: deps(bridge) });
    expect(content.toString('utf8')).toBe('hello');
    expect(meta.mimeType).toBe('text/plain');
  });

  it.each(['../../etc/passwd', 'a/../../b', 'x\\..\\y'])(
    'path traversal %s → TypeError (never calls the bridge)',
    async (evil) => {
      const { downloadGrokWorkspaceFile } = await import('../../src/llm/grok-workspaces.js');
      let called = false;
      await expect(
        downloadGrokWorkspaceFile(WID, evil, {
          deps: deps(async () => {
            called = true;
            return { ok: true };
          }),
        }),
      ).rejects.toBeInstanceOf(TypeError);
      expect(called).toBe(false);
    },
  );

  it('ok download reply missing contentB64 → bad_response throw', async () => {
    const { downloadGrokWorkspaceFile } = await import('../../src/llm/grok-workspaces.js');
    const bridge = vi.fn(async () => ({ ok: true, content: { size: 1 } }));
    await expect(downloadGrokWorkspaceFile(WID, 'notes.txt', { deps: deps(bridge) })).rejects.toThrow(
      /missing content bytes/,
    );
  });

  it('bridge rejects a non-allow-listed signed URL host → structured bad_response surfaces', async () => {
    const { downloadGrokWorkspaceFile, GrokWorkspacesError } = await import('../../src/llm/grok-workspaces.js');
    // Mirrors grok_workspaces.py: signed URL host outside grok.com is refused.
    const bridge = vi.fn(async () => ({
      ok: false,
      errorClass: 'bad_response',
      detail: 'signed URL host not allow-listed: evil.example.com',
    }));
    const err = await downloadGrokWorkspaceFile(WID, 'notes.txt', { deps: deps(bridge) }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GrokWorkspacesError);
    expect((err as InstanceType<typeof GrokWorkspacesError>).errorClass).toBe('bad_response');
  });
});
