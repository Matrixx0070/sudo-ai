/**
 * @file grok-livekit-bridge.test.ts
 * @description Unit tests for the Node↔Python realtime-voice bridge. NO python:
 * the spawn seam is mocked with a fake child that plays back canned stdout.
 * Asserts request+creds go in on stdin, the JSON reply is parsed, and transport
 * failures yield structured errors. The live LiveKit turn is proven separately.
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { callGrokLivekitBridge } from '../../src/llm/grok-livekit-bridge.js';
import type { GrokWebCreds } from '../../src/llm/grok-web-bridge.js';

const CREDS: GrokWebCreds = { cookie: 'cf=SECRET; sso=SECRET2', userAgent: 'UA/150' };

function fakeSpawn(opts: { stdout?: string; exitCode?: number; emitError?: string; onStdin?: (d: string) => void }) {
  return ((_bin: string, _args: readonly string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter; stderr: EventEmitter;
      stdin: { write: (d: string) => void; end: () => void }; kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let buf = '';
    child.stdin = {
      write: (d: string) => { buf += d; },
      end: () => setImmediate(() => {
        opts.onStdin?.(buf);
        if (opts.emitError) { child.emit('error', new Error(opts.emitError)); return; }
        if (opts.stdout) child.stdout.emit('data', Buffer.from(opts.stdout + '\n'));
        child.emit('close', opts.exitCode ?? 0);
      }),
    };
    child.kill = () => {};
    return child;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

describe('callGrokLivekitBridge', () => {
  it('writes request + creds on stdin and parses the JSON reply', async () => {
    let stdin = '';
    const reply = { ok: true, path: '/tmp/reply.wav', durationMs: 4200, agentIdentity: 'agent-AJ_x' };
    const r = await callGrokLivekitBridge(
      { inputWav: '/tmp/in.wav', outputPath: '/tmp/reply.wav', captureSeconds: 6 },
      CREDS,
      fakeSpawn({ stdout: JSON.stringify(reply), onStdin: (d) => { stdin = d; } }),
    );
    const sent = JSON.parse(stdin);
    expect(sent.inputWav).toBe('/tmp/in.wav');
    expect(sent.cookie).toBe(CREDS.cookie); // creds go in on stdin
    expect(r.ok).toBe(true);
    expect(r.durationMs).toBe(4200);
    // returned object carries no cookie material
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });

  it('surfaces a structured error on a spawn failure', async () => {
    const r = await callGrokLivekitBridge(
      { inputWav: '/tmp/in.wav', outputPath: '/tmp/out.wav' },
      CREDS,
      fakeSpawn({ emitError: 'ENOENT python3' }),
    );
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe('bridge_error');
  });

  it('returns bridge_error when the child emits no JSON', async () => {
    const r = await callGrokLivekitBridge(
      { inputWav: '/tmp/in.wav', outputPath: '/tmp/out.wav' },
      CREDS,
      fakeSpawn({ stdout: 'not json', exitCode: 1 }),
    );
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe('bridge_error');
  });
});
