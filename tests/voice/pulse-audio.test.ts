/**
 * @file pulse-audio.test.ts
 * @description Unit tests for the PulseAudioSink manager (Path A audio bridge).
 * The command runner is injected, so these assert the exact pulseaudio/pactl/
 * parec invocations without spawning a daemon. The real capture round-trip is
 * exercised by scripts/grok-voice-relay-audio-check.mts (live, not in CI).
 */
import { describe, it, expect, vi } from 'vitest';
import { PulseAudioSink, type RunResult } from '../../src/core/voice/pulse-audio.js';

type Call = { cmd: string; args: string[]; timeoutMs?: number };

function harness(sinkListed: boolean) {
  const calls: Call[] = [];
  const run = vi.fn(async (cmd: string, args: string[], opts: { env: Record<string, string>; timeoutMs?: number }): Promise<RunResult> => {
    calls.push({ cmd, args, timeoutMs: opts.timeoutMs });
    if (cmd === 'pactl') {
      return { code: 0, stdout: sinkListed ? '0\tgrokvoice\tmodule-null-sink.c\ts16le 2ch 44100Hz\tIDLE\n' : '0\tother\tx\ty\tz\n', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  });
  return { calls, run };
}

describe('PulseAudioSink', () => {
  it('exposes the monitor source and fake-mic path', () => {
    const s = new PulseAudioSink({ runtimeDir: '/tmp/pa-x', sinkName: 'grokvoice', run: vi.fn() });
    expect(s.monitorSource).toBe('grokvoice.monitor');
    expect(s.fakeMicPath()).toBe('/tmp/pa-x/fake-mic.wav');
  });

  it('start() loads a null sink and verifies it appeared', async () => {
    const { calls, run } = harness(true);
    const s = new PulseAudioSink({ run });
    await s.start();
    const pa = calls.find((c) => c.cmd === 'pulseaudio' && c.args.includes('--daemonize=yes'));
    expect(pa).toBeTruthy();
    expect(pa!.args.some((a) => a.includes('module-null-sink sink_name=grokvoice'))).toBe(true);
    // it verified via pactl
    expect(calls.some((c) => c.cmd === 'pactl' && c.args.join(' ') === 'list short sinks')).toBe(true);
  });

  it('start() throws when the sink never appears', async () => {
    const { run } = harness(false);
    const s = new PulseAudioSink({ run });
    await expect(s.start()).rejects.toThrow(/did not appear/);
  });

  it('captureMonitor() records the monitor for an exact duration via ffmpeg', async () => {
    const { calls, run } = harness(true);
    const s = new PulseAudioSink({ run });
    const out = await s.captureMonitor(1500, '/tmp/cap.wav');
    expect(out).toBe('/tmp/cap.wav');
    const ff = calls.find((c) => c.cmd === 'ffmpeg');
    expect(ff).toBeTruthy();
    expect(ff!.args).toContain('pulse');
    expect(ff!.args).toContain('grokvoice.monitor');
    // -t <seconds> == duration
    expect(ff!.args[ff!.args.indexOf('-t') + 1]).toBe('1.500');
  });

  it('captureMonitor() throws when ffmpeg fails', async () => {
    const run = vi.fn(async (cmd: string): Promise<RunResult> => {
      if (cmd === 'ffmpeg') return { code: 1, stdout: '', stderr: 'boom' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const s = new PulseAudioSink({ run });
    await expect(s.captureMonitor(1000, '/tmp/x.wav')).rejects.toThrow(/ffmpeg pulse capture failed/);
  });

  it('stop() kills the daemon (best-effort, never throws)', async () => {
    const { calls, run } = harness(true);
    const s = new PulseAudioSink({ run });
    await s.stop();
    expect(calls.some((c) => c.cmd === 'pulseaudio' && c.args.includes('--kill'))).toBe(true);
  });
});
