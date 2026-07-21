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
import path from 'node:path';
import type { STTOptions, TTSOptions } from '../../core/voice/types.js';

export interface VoiceTurnCliOptions {
  stt?: string;
  tts?: string;
  voice?: string;
  language?: string;
  out?: string;
  echo?: boolean;
  model?: string;
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
