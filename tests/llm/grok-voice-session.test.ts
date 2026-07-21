/**
 * @file grok-voice-session.test.ts
 * @description Unit tests for the persistent multi-turn realtime voice session.
 * NO python/livekit: the spawn seam is a fake streaming child that speaks the
 * line-delimited JSON protocol (ready/reply/bye). The reply WAV is created on
 * disk so the session reads it back. The live LiveKit conversation is proven
 * separately (not in CI).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'grok-sess-'));
  process.env['DATA_DIR'] = dir;
  process.env['SUDO_GROK_WEBSESSION'] = '1';
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env['DATA_DIR'];
  delete process.env['SUDO_GROK_WEBSESSION'];
  vi.resetModules();
});

function fakeManager() {
  return { ensureHealthy: async () => ({ cookie: 'c', userAgent: 'u' }) } as unknown as import('../../src/llm/grok-web-session-manager.js').GrokWebSessionManager;
}

/** A fake persistent child that plays the session protocol. */
function makeChild(replyBytes: Buffer) {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stdin: PassThrough; kill: () => void };
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => child.emit('close', 0);
  // Respond to commands written on stdin.
  child.stdin.on('data', (d: Buffer) => {
    for (const line of d.toString('utf8').split('\n').filter(Boolean)) {
      const cmd = JSON.parse(line);
      if (cmd.cmd === 'speak') {
        writeFileSync(cmd.out, replyBytes); // the python client writes the reply WAV
        child.stdout.write(JSON.stringify({ event: 'reply', turn: 1, path: cmd.out, durationMs: 3200 }) + '\n');
      } else if (cmd.cmd === 'quit') {
        child.stdout.write(JSON.stringify({ event: 'bye' }) + '\n');
        setImmediate(() => child.emit('close', 0));
      }
    }
  });
  // Announce ready shortly after spawn.
  setImmediate(() => child.stdout.write(JSON.stringify({ event: 'ready', agentIdentity: 'agent-AJ_x' }) + '\n'));
  return child;
}

describe('GrokVoiceSession', () => {
  it('starts (ready), runs a turn, and stops over one persistent process', async () => {
    const { GrokVoiceSession } = await import('../../src/llm/grok-voice-session.js');
    const reply = Buffer.from('RIFFreplyWAVE');
    const spawnFn = vi.fn(() => makeChild(reply)) as never;
    const s = new GrokVoiceSession({ spawnFn, manager: fakeManager() });

    const { agentIdentity } = await s.start();
    expect(agentIdentity).toBe('agent-AJ_x');

    const r = await s.speak(Buffer.from('RIFFin'));
    expect(r.replyWav.equals(reply)).toBe(true);
    expect(r.durationMs).toBe(3200);

    // A second turn reuses the SAME process (persistent room).
    const r2 = await s.speak(Buffer.from('RIFFin2'));
    expect(r2.replyWav.equals(reply)).toBe(true);
    expect(spawnFn).toHaveBeenCalledOnce();

    await s.stop();
  });

  it('flag OFF → GrokWebDisabledError (never spawns)', async () => {
    process.env['SUDO_GROK_WEBSESSION'] = '0';
    const { GrokVoiceSession, GrokWebDisabledError } = await import('../../src/llm/grok-voice-session.js');
    const spawnFn = vi.fn() as never;
    const s = new GrokVoiceSession({ spawnFn, manager: fakeManager() });
    await expect(s.start()).rejects.toBeInstanceOf(GrokWebDisabledError);
    expect(spawnFn).not.toHaveBeenCalled();
  });
});
