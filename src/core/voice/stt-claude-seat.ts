/**
 * @file stt-claude-seat.ts
 * @description Speech-to-text on the Claude Max OAuth seat (2026-07-31).
 *
 * The Claude Code CLI ships a WebSocket STT lane on the Anthropic API host,
 * authenticated with the SAME OAuth token sudo-ai already holds. It is
 * seat-covered (no per-minute cost, no extra API key) and backed by Deepgram
 * Nova-3. Live-proven: PCM in → `{"type":"TranscriptText","data":...}` out.
 *
 *   (URL lives in src/llm/endpoints.ts -> claudeSeatSttWsUrl)
 *     ?encoding=linear16&sample_rate=16000&channels=1&language=en
 *     &transcription_engine=true&stt_provider=deepgram-nova3
 *
 * This is a CLI-internal endpoint, NOT public API: it is used opportunistically
 * and every failure path falls through to the existing STT providers, so a
 * change on Anthropic's side degrades rather than breaks. Disable with
 * SUDO_STT_CLAUDE_SEAT=0.
 *
 * Input audio arrives in whatever the channel sent (Telegram voice notes are
 * OGG/Opus), so it is transcoded to 16 kHz mono linear16 with ffmpeg. When
 * ffmpeg is absent the provider reports unavailable and the chain moves on.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createLogger } from '../shared/logger.js';
import { claudeSeatSttWsUrl } from '../../llm/endpoints.js';

const log = createLogger('voice:stt-claude-seat');

/** Chunk size for the audio stream (~100ms of 16kHz mono linear16). */
const CHUNK_BYTES = 3200;
/** Wall-clock gap between chunks. MUST be ~real-time: this is a live-dictation
 * endpoint, not a batch transcription API. Live-measured 2026-07-31 on a 6.7s
 * clip: 100ms/chunk (1x) returned the FULL transcript; 50ms (2x) returned 2 of
 * 3 sentences; 0-25ms returned only the first phrase. Faster is not better. */
const CHUNK_INTERVAL_MS = 100;
/** Real-time pacing means wall-clock ~= audio length, so long audio is capped;
 * the caller's other providers (faster than real time) handle those instead. */
const MAX_SEAT_AUDIO_SEC = Number(process.env['SUDO_STT_SEAT_MAX_SEC'] ?? 120);
/** Hard cap on a single transcription so a stalled socket can't hang a turn. */
const OVERALL_TIMEOUT_MS = Math.max(60_000, (Number(process.env['SUDO_STT_SEAT_MAX_SEC'] ?? 120) + 30) * 1000);
/**
 * Quiet period after the last frame before we consider the transcript complete.
 * Deepgram sends a TranscriptEndpoint per speech pause, so "first endpoint" is
 * NOT end-of-stream — waiting for silence is what keeps multi-phrase notes whole.
 */
const IDLE_FINISH_MS = 2_500;

let ffmpegChecked = false;
let ffmpegPresent = false;

/** True when ffmpeg is on PATH (cached; needed to transcode to linear16). */
export function hasFfmpeg(): boolean {
  if (ffmpegChecked) return ffmpegPresent;
  ffmpegChecked = true;
  try {
    ffmpegPresent = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    ffmpegPresent = false;
  }
  if (!ffmpegPresent) {
    log.debug('ffmpeg not found — Claude seat STT unavailable (other providers still apply)');
  }
  return ffmpegPresent;
}

/** Test seam: reset the cached ffmpeg probe. */
export function __resetFfmpegProbe(): void {
  ffmpegChecked = false;
  ffmpegPresent = false;
}

/** Transcode arbitrary audio to 16 kHz mono signed-16 PCM. */
export async function toLinear16(input: Buffer): Promise<Buffer | null> {
  if (!hasFfmpeg()) return null;
  return new Promise((resolve) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ar', '16000', '-ac', '1', '-f', 's16le', 'pipe:1']);
    const out: Buffer[] = [];
    let settled = false;
    const done = (v: Buffer | null): void => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    ff.stdout.on('data', (d: Buffer) => out.push(d));
    ff.on('error', () => done(null));
    ff.on('close', (code) => done(code === 0 && out.length > 0 ? Buffer.concat(out) : null));
    ff.stdin.on('error', () => done(null));
    ff.stdin.end(input);
    setTimeout(() => {
      if (!settled) {
        ff.kill('SIGKILL');
        done(null);
      }
    }, OVERALL_TIMEOUT_MS);
  });
}

export interface SeatSttOptions {
  /** BCP-47-ish language hint (default 'en'). */
  language?: string;
  /** Domain words to bias the recogniser toward. */
  keyterms?: string[];
}

export interface SeatSttOutcome {
  ok: boolean;
  text?: string;
  reason?: string;
}

/** Build the voice_stream URL (exported for tests — the param set is a contract). */
export function buildVoiceStreamUrl(opts: SeatSttOptions = {}): string {
  const params = new URLSearchParams({
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    language: opts.language ?? 'en',
    transcription_engine: 'true',
    stt_provider: 'deepgram-nova3',
  });
  for (const k of opts.keyterms ?? []) params.append('keyterms', k);
  return `${claudeSeatSttWsUrl()}?${params.toString()}`;
}

/** True when the seat STT lane should be attempted. */
export function seatSttEnabled(): boolean {
  return process.env['SUDO_STT_CLAUDE_SEAT'] !== '0' && hasFfmpeg();
}

/**
 * Transcribe on the seat. NEVER throws: returns `{ok:false, reason}` so the
 * caller falls through to its other providers.
 */
export async function transcribeOnClaudeSeat(
  audio: Buffer,
  opts: SeatSttOptions = {},
): Promise<SeatSttOutcome> {
  if (process.env['SUDO_STT_CLAUDE_SEAT'] === '0') return { ok: false, reason: 'disabled' };
  try {
    const { getClaudeOAuthManager } = await import('../../llm/claude-oauth-manager.js');
    const mgr = getClaudeOAuthManager();
    let token = mgr.getAccessToken();
    if (!token) {
      await mgr.refreshToken().catch(() => false);
      token = mgr.getAccessToken();
    }
    if (!token) return { ok: false, reason: 'no seat token' };

    const pcm = await toLinear16(audio);
    if (!pcm || pcm.length === 0) return { ok: false, reason: 'transcode failed (ffmpeg missing or bad audio)' };

    // 16kHz mono s16 = 32000 bytes/sec.
    const seconds = pcm.length / 32_000;
    if (seconds > MAX_SEAT_AUDIO_SEC) {
      return { ok: false, reason: `audio ${seconds.toFixed(0)}s exceeds seat real-time budget (${MAX_SEAT_AUDIO_SEC}s)` };
    }

    const { default: WebSocket } = await import('ws');
    const ws = new WebSocket(buildVoiceStreamUrl(opts), {
      headers: {
        Authorization: `Bearer ${token}`,
        'x-app': 'cli',
        'User-Agent': 'claude-cli (sudo-ai)',
      },
    });

    return await new Promise<SeatSttOutcome>((resolve) => {
      const parts: string[] = [];
      let settled = false;
      const finish = (o: SeatSttOutcome): void => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          /* already closing */
        }
        resolve(o);
      };
      const guard = setTimeout(() => finish({ ok: false, reason: 'timeout' }), OVERALL_TIMEOUT_MS);
      let idle: ReturnType<typeof setTimeout> | null = null;
      const settleAccumulated = (): void => {
        clearTimeout(guard);
        const text = parts.join(' ').trim();
        finish(text.length > 0 ? { ok: true, text } : { ok: false, reason: 'empty transcript' });
      };
      /** Restart the quiet-period timer: the stream is done when frames stop. */
      const bumpIdle = (): void => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(settleAccumulated, IDLE_FINISH_MS);
      };

      ws.on('open', () => {
        // Pace at real time — see CHUNK_INTERVAL_MS. Sending faster makes the
        // server finalize early and silently truncates the transcript.
        void (async () => {
          try {
            for (let i = 0; i < pcm.length; i += CHUNK_BYTES) {
              if (settled) return;
              ws.send(pcm.subarray(i, i + CHUNK_BYTES));
              await new Promise((r) => setTimeout(r, CHUNK_INTERVAL_MS));
            }
            if (!settled) ws.send(JSON.stringify({ type: 'CloseStream' }));
            bumpIdle();
          } catch {
            finish({ ok: false, reason: 'send failed' });
          }
        })();
      });

      ws.on('message', (raw: Buffer | string) => {
        try {
          const msg = JSON.parse(raw.toString()) as { type?: string; data?: string; error?: { message?: string } };
          if (msg.type === 'TranscriptText' && typeof msg.data === 'string' && msg.data.trim() !== '') {
            parts.push(msg.data.trim());
            bumpIdle();
          } else if (msg.type === 'TranscriptEndpoint') {
            // Deepgram emits an endpoint per speech PAUSE, not at end-of-stream:
            // resolving here truncated multi-phrase notes to the first phrase
            // (live-caught 2026-07-31). Keep accumulating; the socket close or
            // the post-CloseStream idle window ends the transcription.
            bumpIdle();
          } else if (msg.type === 'error') {
            clearTimeout(guard);
            finish({ ok: false, reason: `seat error: ${msg.error?.message ?? 'unknown'}` });
          }
        } catch {
          /* non-JSON frame — ignore */
        }
      });

      ws.on('close', () => {
        if (idle) clearTimeout(idle);
        settleAccumulated();
      });

      ws.on('error', (err: Error) => {
        clearTimeout(guard);
        if (idle) clearTimeout(idle);
        finish({ ok: false, reason: `ws error: ${String(err).slice(0, 150)}` });
      });
    });
  } catch (err) {
    return { ok: false, reason: `seat stt error: ${String(err).slice(0, 150)}` };
  }
}
