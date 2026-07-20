/**
 * @file grok-web-bridge.test.ts
 * @description Unit tests for the GW2 Node↔Python replay bridge. NO live net and
 * NO real python: the spawn seam is mocked with a fake child that plays back
 * canned stdout. Also asserts secrets never appear in what is written to the
 * child's stdin log (they must be there) but never in the returned object.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { callGrokWebBridge } from '../../src/llm/grok-web-bridge.js';
import type { GrokWebCreds, GrokWebRequest } from '../../src/llm/grok-web-bridge.js';

const CREDS: GrokWebCreds = {
  cookie: 'cf_clearance=SECRET_CLEARANCE; sso=SECRET_SSO',
  userAgent: 'Mozilla/5.0 (X11; Linux) Chrome/150',
  statsigId: 'SECRET_STATSIG',
};

/**
 * Build a fake `spawn` that emits `stdoutLines` on the child's stdout then
 * closes with `exitCode`. Captures what was written to stdin for assertions.
 */
function fakeSpawn(opts: {
  stdoutLines?: string[];
  stderr?: string;
  exitCode?: number;
  emitError?: string;
  onStdin?: (data: string) => void;
}) {
  return ((_bin: string, _args: readonly string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { write: (d: string) => void; end: () => void };
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let stdinBuf = '';
    child.stdin = {
      write: (d: string) => {
        stdinBuf += d;
      },
      end: () => {
        opts.onStdin?.(stdinBuf);
        // Deliver output asynchronously, after stdin is closed.
        setImmediate(() => {
          if (opts.emitError) {
            child.emit('error', new Error(opts.emitError));
            return;
          }
          for (const line of opts.stdoutLines ?? []) child.stdout.emit('data', Buffer.from(line + '\n'));
          if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr));
          child.emit('close', opts.exitCode ?? 0);
        });
      },
    };
    child.kill = () => {};
    return child;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

describe('callGrokWebBridge', () => {
  it('probe: parses the quota JSON', async () => {
    const spawnFn = fakeSpawn({
      stdoutLines: [
        JSON.stringify({ ok: true, status: 200, quota: { video: { available: true, windowSizeSeconds: 64800 } } }),
      ],
    });
    const r = await callGrokWebBridge({ op: 'probe' }, CREDS, spawnFn);
    expect(r.ok).toBe(true);
    expect(r.quota?.['video']?.available).toBe(true);
  });

  it('image: returns decoded image descriptors', async () => {
    const spawnFn = fakeSpawn({
      stdoutLines: [
        JSON.stringify({
          ok: true,
          images: [{ jobId: 'abc', b64: 'AAAA', publicUrl: 'https://imagine-public.x.ai/imagine-public/images/abc.jpg' }],
        }),
      ],
    });
    const req: GrokWebRequest = { op: 'image', prompt: 'a star', numGenerations: 1 };
    const r = await callGrokWebBridge(req, CREDS, spawnFn);
    expect(r.ok).toBe(true);
    expect(r.images?.[0]?.jobId).toBe('abc');
    expect(r.images?.[0]?.publicUrl).toContain('imagine-public');
  });

  it('video: returns the assets.grok.com mp4 url', async () => {
    const spawnFn = fakeSpawn({
      stdoutLines: [
        JSON.stringify({ ok: true, videoUrl: 'https://assets.grok.com/users/u/generated/v/generated_video.mp4', videoId: 'v' }),
      ],
    });
    const req: GrokWebRequest = { op: 'video', imageUrl: 'https://imagine-public.x.ai/imagine-public/images/abc.jpg' };
    const r = await callGrokWebBridge(req, CREDS, spawnFn);
    expect(r.ok).toBe(true);
    expect(r.videoUrl).toContain('assets.grok.com');
    expect(r.videoUrl).toContain('generated_video.mp4');
  });

  it('propagates structured error classes (cloudflare / statsig / grpc)', async () => {
    for (const ec of ['cloudflare', 'statsig', 'grpc_not_found', 'relogin'] as const) {
      const spawnFn = fakeSpawn({ stdoutLines: [JSON.stringify({ ok: false, status: 403, errorClass: ec })] });
      const r = await callGrokWebBridge({ op: 'probe' }, CREDS, spawnFn);
      expect(r.ok).toBe(false);
      expect(r.errorClass).toBe(ec);
    }
  });

  it('ignores non-JSON preamble and parses the last JSON line', async () => {
    const spawnFn = fakeSpawn({
      stdoutLines: ['warning: some noise', JSON.stringify({ ok: true, status: 200 })],
    });
    const r = await callGrokWebBridge({ op: 'probe' }, CREDS, spawnFn);
    expect(r.ok).toBe(true);
  });

  it('returns bridge_error when the child emits no JSON', async () => {
    const spawnFn = fakeSpawn({ stdoutLines: [], stderr: 'Traceback...', exitCode: 1 });
    const r = await callGrokWebBridge({ op: 'probe' }, CREDS, spawnFn);
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe('bridge_error');
  });

  it('returns bridge_error when spawn itself fails', async () => {
    const spawnFn = fakeSpawn({ emitError: 'ENOENT' });
    const r = await callGrokWebBridge({ op: 'probe' }, CREDS, spawnFn);
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe('bridge_error');
    expect(r.detail).toContain('spawn failed');
  });

  it('passes secrets to the child stdin but never returns them in the result', async () => {
    let stdinSeen = '';
    const spawnFn = fakeSpawn({
      stdoutLines: [JSON.stringify({ ok: true, status: 200 })],
      onStdin: (d) => {
        stdinSeen = d;
      },
    });
    const r = await callGrokWebBridge({ op: 'probe' }, CREDS, spawnFn);
    // Secrets MUST reach the child (that's the transport)...
    expect(stdinSeen).toContain('SECRET_CLEARANCE');
    expect(stdinSeen).toContain('SECRET_STATSIG');
    // ...but MUST NOT leak back into the parsed response object.
    expect(JSON.stringify(r)).not.toContain('SECRET_CLEARANCE');
    expect(JSON.stringify(r)).not.toContain('SECRET_STATSIG');
  });

  it('honors a timeout when the child never closes', async () => {
    vi.useFakeTimers();
    // A spawn whose child never emits close.
    const neverClose = (() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: { write: () => void; end: () => void };
        kill: () => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: () => {}, end: () => {} };
      child.kill = () => {};
      return child;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    const p = callGrokWebBridge({ op: 'probe', timeoutSec: 1 }, CREDS, neverClose);
    await vi.advanceTimersByTimeAsync(16_100);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe('timeout');
    vi.useRealTimers();
  });
});
