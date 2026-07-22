/**
 * @file grok-voice.ts
 * @description `sudo-ai grok voice <input>` — one realtime voice turn with
 * grok's own voice agent over LiveKit, free on the $30 subscription seat.
 * Speaks the input audio into the room and saves the agent's spoken reply.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface GrokVoiceCliOptions {
  seconds?: number;
  out?: string;
}

/** Run `sudo-ai grok voice`. Returns a process exit code. */
export async function runGrokVoice(inputPath: string, opts: GrokVoiceCliOptions): Promise<number> {
  let input: Buffer;
  try {
    input = await readFile(inputPath);
  } catch (err) {
    console.error(`Cannot read input audio "${inputPath}": ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (input.length === 0) {
    console.error('Input audio is empty.');
    return 1;
  }

  const { grokRealtimeVoiceTurn } = await import('../../llm/grok-realtime-voice.js');
  console.log('Connecting to grok voice agent (LiveKit, subscription seat)…');
  let result;
  try {
    result = await grokRealtimeVoiceTurn(input, opts.seconds ? { captureSeconds: opts.seconds } : {});
  } catch (err) {
    console.error(`Realtime voice turn failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const outPath = opts.out ?? path.join('/tmp', `grok-voice-reply-${input.length}.wav`);
  try {
    await writeFile(outPath, result.replyWav);
  } catch (err) {
    console.error(`Failed to write reply to "${outPath}": ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  console.log(`Reply: ${outPath} (~${Math.round(result.durationMs / 1000)}s, ${result.replyWav.length} bytes, agent ${result.agentIdentity ?? '?'})`);
  return 0;
}

/**
 * `sudo-ai grok converse <inputs...>` — a PERSISTENT multi-turn realtime voice
 * conversation with grok's agent over ONE LiveKit connection (context persists
 * across turns). Speaks each input WAV in order; saves reply-<i>.wav.
 */
export async function runGrokConverse(inputs: string[], opts: { out?: string }): Promise<number> {
  if (!inputs.length) {
    console.error('Provide one or more input audio files.');
    return 1;
  }
  const { GrokVoiceSession } = await import('../../llm/grok-voice-session.js');
  const session = new GrokVoiceSession();
  console.log('Joining grok voice room (LiveKit, subscription seat)…');
  try {
    const { agentIdentity } = await session.start();
    console.log(`Connected — agent ${agentIdentity ?? '?'}. ${inputs.length} turn(s).`);
    for (const [i, input] of inputs.entries()) {
      let wav: Buffer;
      try {
        wav = await readFile(input);
      } catch (err) {
        console.error(`turn ${i}: cannot read "${input}": ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const r = await session.speak(wav);
      const outPath = `${opts.out ?? path.join('/tmp', 'grok-converse-reply')}-${i}.wav`;
      await writeFile(outPath, r.replyWav);
      console.log(`turn ${r.turn}: reply ${outPath} (~${Math.round(r.durationMs / 1000)}s, ${r.replyWav.length} bytes)`);
    }
    return 0;
  } catch (err) {
    console.error(`Conversation failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await session.stop();
  }
}
