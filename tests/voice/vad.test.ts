/**
 * @file vad.test.ts
 * @description Unit tests for the energy VAD: RMS math + speech/non-speech
 * classification against the threshold.
 */
import { describe, it, expect } from 'vitest';
import { EnergyVad } from '../../src/core/voice/vad.js';

const FRAME = 640; // 20ms @ 16kHz mono s16le

function silence(): Buffer {
  return Buffer.alloc(FRAME, 0);
}
function tone(amp: number): Buffer {
  const b = Buffer.alloc(FRAME);
  for (let i = 0; i < FRAME / 2; i++) b.writeInt16LE(amp, i * 2);
  return b;
}

describe('EnergyVad', () => {
  it('rms is 0 for silence and ~amp/32768 for a constant frame', () => {
    expect(EnergyVad.rms(silence())).toBe(0);
    expect(EnergyVad.rms(tone(8000))).toBeCloseTo(8000 / 32768, 5);
  });

  it('classifies silence as non-speech and a loud frame as speech', () => {
    const vad = new EnergyVad();
    expect(vad.isSpeech(silence())).toBe(false);
    expect(vad.isSpeech(tone(8000))).toBe(true);
  });

  it('honours a custom threshold', () => {
    const quiet = tone(300); // rms ~0.009
    expect(new EnergyVad({ threshold: 0.02 }).isSpeech(quiet)).toBe(false);
    expect(new EnergyVad({ threshold: 0.005 }).isSpeech(quiet)).toBe(true);
  });

  it('rms of an empty buffer is 0 (no divide-by-zero)', () => {
    expect(EnergyVad.rms(Buffer.alloc(0))).toBe(0);
  });
});
