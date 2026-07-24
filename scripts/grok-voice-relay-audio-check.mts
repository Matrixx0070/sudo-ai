/**
 * Live check for the Path A grok voice-mode relay audio bridge (NOT in CI —
 * needs a real PulseAudio + ffmpeg on the host). Proves the agent-OUT path
 * end-to-end through PulseAudioSink: start the private `grokvoice` null sink,
 * play a tone into it, capture the monitor, and assert the capture is non-silent.
 *
 *   npx tsx scripts/grok-voice-relay-audio-check.mts
 *
 * Exits 0 on success (RMS above the silence floor), 1 otherwise. Cleans up.
 */
import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { PulseAudioSink } from '../src/core/voice/pulse-audio.js';

const RUNTIME = '/tmp/pa-grokvoice-check';
const TONE = '/tmp/pa-check-tone.wav';
const CAP = '/tmp/pa-check-cap.wav';

function run(cmd: string, args: string[], env: Record<string, string> = {}): Promise<number | null> {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { env: { ...process.env, ...env } });
    c.on('error', () => resolve(null));
    c.on('close', (code) => resolve(code));
  });
}

/** RMS of a 16-bit PCM WAV (skip the 44-byte header). */
function wavRms(path: string): number {
  const buf = readFileSync(path);
  const pcm = buf.subarray(44);
  const n = Math.floor(pcm.length / 2);
  if (n === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) sumSq += pcm.readInt16LE(i * 2) ** 2;
  return Math.sqrt(sumSq / n);
}

async function main(): Promise<number> {
  rmSync(RUNTIME, { recursive: true, force: true });
  const sink = new PulseAudioSink({ runtimeDir: RUNTIME });
  const env = { XDG_RUNTIME_DIR: RUNTIME };
  try {
    await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', TONE, '-loglevel', 'error']);
    await sink.start();
    console.log(`sink ready: ${sink.monitorSource}`);
    // Capture for 2s while playing the tone ~0.3s in.
    const capturing = sink.captureMonitor(2000, CAP);
    await new Promise((r) => setTimeout(r, 300));
    await run('paplay', ['-d', sink.sinkName, TONE], env);
    await capturing;
    const rms = wavRms(CAP);
    console.log(`captured ${readFileSync(CAP).length} bytes, RMS ${rms.toFixed(1)}`);
    const ok = rms > 100; // silence floor
    console.log(ok ? '✓ agent-OUT audio bridge works (non-silent capture)' : '✗ capture was silent');
    return ok ? 0 : 1;
  } finally {
    await sink.stop();
    for (const f of [TONE, CAP]) rmSync(f, { force: true });
  }
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
