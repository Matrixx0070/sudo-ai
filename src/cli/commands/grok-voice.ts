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
