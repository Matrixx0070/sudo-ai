/**
 * E2E: fully-local voice round-trip.
 *
 *   Kokoro TTS (text -> WAV)  -->  Whisper STT (WAV -> text)
 *
 * No API keys, no network at inference time (only first-run weight downloads).
 * Proves the offline voice-mode loop end to end.
 *
 * Run: pnpm exec tsx scripts/e2e-local-voice.mts
 */

import { TextToSpeech } from '../src/core/voice/tts.js';
import { SpeechToText } from '../src/core/voice/stt.js';

// Force local-only on both sides regardless of ambient env.
delete process.env['SUDO_TTS_CLOUD'];
delete process.env['SUDO_STT_CLOUD'];
delete process.env['SUDO_KOKORO_TTS'];
delete process.env['SUDO_WHISPER_STT'];

const PHRASE = 'The quick brown fox jumps over the lazy dog.';

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}

async function main(): Promise<void> {
  console.log(`[e2e] phrase: "${PHRASE}"`);

  console.log('[e2e] TTS (Kokoro, local)…');
  const t0 = Date.now();
  const tts = new TextToSpeech();
  const { audioBuffer, format, durationMs } = await tts.synthesize(PHRASE);
  console.log(`[e2e] TTS ok: ${audioBuffer.length} bytes, format=${format}, ~${durationMs}ms audio (${Date.now() - t0}ms wall)`);
  if (format !== 'wav') throw new Error(`expected local kokoro wav, got ${format} — cloud may be enabled`);

  console.log('[e2e] STT (Whisper, local)…');
  const t1 = Date.now();
  const stt = new SpeechToText();
  const result = await stt.transcribe(audioBuffer);
  console.log(`[e2e] STT ok: "${result.text}" (lang=${result.language}, ${Date.now() - t1}ms wall)`);

  // Verify the round-trip recovered the salient content words.
  const got = normalize(result.text);
  const expectWords = ['quick', 'brown', 'fox', 'lazy', 'dog'];
  const hits = expectWords.filter((w) => got.includes(w));
  console.log(`[e2e] recovered ${hits.length}/${expectWords.length} key words: [${hits.join(', ')}]`);

  if (hits.length < 3) {
    throw new Error(`round-trip FAILED — recovered "${got}"`);
  }
  console.log('[e2e] PASS — fully-local Kokoro→Whisper round-trip works.');
}

main().catch((err) => {
  console.error('[e2e] FAIL:', err);
  process.exit(1);
});
