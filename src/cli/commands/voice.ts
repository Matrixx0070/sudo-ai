/**
 * @file voice.ts
 * @description `sudo-ai voice turn <audio>` — run one turn-based voice exchange:
 * transcribe an audio file, get an agent reply, and synthesise it back to audio.
 *
 * The reply is a single LLM completion via the chat choke point (chatIR) —
 * light, real "brain" answer without booting the full agent loop. Pass --echo
 * to skip the LLM entirely (zero-spend pipeline check: the reply is the
 * transcript itself). STT/TTS default to local (Kokoro/Whisper); pass
 * --stt grok / --tts grok to route through the owner's free Grok subscription
 * voice lanes (needs SUDO_GROK_WEBSESSION=1). This is a CLI (owner) surface.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { STTOptions, TTSOptions } from '../../core/voice/types.js';
import type { VoiceTurnResult } from '../../core/voice/voice-turn.js';

export interface VoiceTurnCliOptions {
  stt?: string;
  tts?: string;
  voice?: string;
  language?: string;
  out?: string;
  echo?: boolean;
  model?: string;
}

/** ffmpeg-decode any audio file to raw s16le 16 kHz mono PCM (what the VAD wants). */
function decodeToPcm16k(inPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-i', inPath, '-f', 's16le', '-ac', '1', '-ar', '16000', '-loglevel', 'error', 'pipe:1']);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e) => reject(new Error(`ffmpeg could not run (is it installed?): ${String(e)}`)));
    child.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(out))
        : reject(new Error(`ffmpeg decode failed (exit ${code}): ${Buffer.concat(err).toString('utf8').slice(0, 300)}`)),
    );
  });
}

/** Single LLM completion used as the reply seam (real brain answer, light). */
async function llmReply(transcript: string, alias: string): Promise<string> {
  const { chatIR } = await import('../../llm/client.js');
  const r = await chatIR({
    alias,
    caller: 'cli:voice-turn',
    purpose: 'voice conversation turn',
    system: 'You are a helpful voice assistant. Reply in one or two short, natural spoken sentences.',
    messages: [{ role: 'user', content: transcript }],
    maxTokens: 300,
    priority: 'user',
  });
  return r.text;
}

/**
 * Run `sudo-ai voice turn`. Returns a process exit code.
 */
export async function runVoiceTurnCli(audioPath: string, opts: VoiceTurnCliOptions): Promise<number> {
  let audio: Buffer;
  try {
    audio = await readFile(audioPath);
  } catch (err) {
    console.error(`Cannot read audio file "${audioPath}": ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (audio.length === 0) {
    console.error('Audio file is empty.');
    return 1;
  }

  const { runVoiceTurn } = await import('../../core/voice/voice-turn.js');

  const turnOpts: {
    sttProvider?: STTOptions['provider'];
    ttsProvider?: TTSOptions['provider'];
    voice?: string;
    language?: string;
  } = {};
  if (opts.stt) turnOpts.sttProvider = opts.stt as STTOptions['provider'];
  if (opts.tts) turnOpts.ttsProvider = opts.tts as TTSOptions['provider'];
  if (opts.voice) turnOpts.voice = opts.voice;
  if (opts.language) turnOpts.language = opts.language;

  const alias = opts.model ?? 'sudo/cheap';
  const reply = opts.echo
    ? async (t: string): Promise<string> => t
    : (t: string): Promise<string> => llmReply(t, alias);

  let result;
  try {
    result = await runVoiceTurn(audio, reply, turnOpts);
  } catch (err) {
    console.error(`Voice turn failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  if (result.note) {
    console.log(`(${result.note})`);
    if (result.transcript) console.log(`Heard: ${result.transcript}`);
    return 0;
  }

  console.log(`Heard: ${result.transcript}`);
  console.log(`Reply: ${result.replyText}`);

  if (result.audio) {
    const outPath = opts.out ?? path.join('/tmp', `sudo-ai-voice-turn-${audio.length}.${result.audio.format}`);
    try {
      await writeFile(outPath, result.audio.buffer);
      console.log(`Audio: ${outPath} (${result.audio.format}, ~${Math.round(result.audio.durationMs / 1000)}s, ${result.audio.buffer.length} bytes)`);
    } catch (err) {
      console.error(`Failed to write audio to "${outPath}": ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  return 0;
}

export interface VoiceStreamCliOptions extends VoiceTurnCliOptions {
  threshold?: number;
}

/**
 * Run `sudo-ai voice stream`. Drives an audio FILE through the streaming session
 * frame-by-frame (16 kHz mono, 20ms frames) to exercise VAD endpointing +
 * turn-per-utterance + barge-in on real audio. A live mic is the same pipeline
 * with the frame source swapped for a capture device.
 */
export async function runVoiceStreamCli(audioPath: string, opts: VoiceStreamCliOptions): Promise<number> {
  let pcm: Buffer;
  try {
    pcm = await decodeToPcm16k(audioPath);
  } catch (err) {
    console.error(`Cannot decode "${audioPath}": ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (pcm.length === 0) {
    console.error('Decoded audio is empty.');
    return 1;
  }

  const { runVoiceTurn } = await import('../../core/voice/voice-turn.js');
  const { VoiceSession } = await import('../../core/voice/voice-session.js');
  const { EnergyVad } = await import('../../core/voice/vad.js');

  const turnOpts: { sttProvider?: STTOptions['provider']; ttsProvider?: TTSOptions['provider']; voice?: string; language?: string } = {};
  if (opts.stt) turnOpts.sttProvider = opts.stt as STTOptions['provider'];
  if (opts.tts) turnOpts.ttsProvider = opts.tts as TTSOptions['provider'];
  if (opts.voice) turnOpts.voice = opts.voice;
  if (opts.language) turnOpts.language = opts.language;

  const alias = opts.model ?? 'sudo/cheap';
  const reply = opts.echo ? async (t: string): Promise<string> => t : (t: string): Promise<string> => llmReply(t, alias);
  const turn = (wav: Buffer): Promise<VoiceTurnResult> => runVoiceTurn(wav, reply, turnOpts);

  const sessionDeps = opts.threshold !== undefined
    ? { turn, vad: new EnergyVad({ threshold: opts.threshold }) }
    : { turn };
  const session = new VoiceSession(sessionDeps);

  let pending = 0;
  let replies = 0;
  let done: () => void = () => {};
  const idle = new Promise<void>((r) => { done = r; });

  session.on((e) => {
    if (e.type === 'speech-start') console.log('· speech detected');
    else if (e.type === 'utterance') { pending++; console.log(`· utterance captured (~${Math.round(e.durationMs / 1000)}s) — transcribing…`); }
    else if (e.type === 'transcript') console.log(`  heard: ${e.text}`);
    else if (e.type === 'barge-in') console.log('· barge-in — user interrupted');
    else if (e.type === 'error') { console.error(`  turn error: ${e.error}`); if (--pending <= 0) done(); }
    else if (e.type === 'reply') {
      const outPath = opts.out ? `${opts.out}.${replies}.${e.audio.format}` : path.join('/tmp', `sudo-ai-voice-stream-${replies}.${e.audio.format}`);
      replies++;
      void writeFile(outPath, e.audio.buffer).then(() => {
        console.log(`  reply: ${e.text}`);
        console.log(`  audio: ${outPath} (${e.audio.format}, ~${Math.round(e.audio.durationMs / 1000)}s, ${e.audio.buffer.length} bytes)`);
        session.notifyPlaybackFinished();
        if (--pending <= 0) done();
      });
    }
  });

  // 20ms frames at 16 kHz mono s16le = 640 bytes.
  const FRAME = 640;
  for (let off = 0; off + FRAME <= pcm.length; off += FRAME) {
    session.pushFrame(pcm.subarray(off, off + FRAME));
  }
  // Tail of silence to force the final endpoint if the file ends mid-utterance.
  for (let i = 0; i < 50; i++) session.pushFrame(Buffer.alloc(FRAME, 0));

  if (pending === 0) {
    console.log('(no speech detected in the input)');
    return 0;
  }
  // Wait for all in-flight turns, with a safety cap.
  const timeout = new Promise<void>((r) => setTimeout(r, 120_000));
  await Promise.race([idle, timeout]);
  console.log(`Done — ${replies} repl${replies === 1 ? 'y' : 'ies'} produced.`);
  return 0;
}
