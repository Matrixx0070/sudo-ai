/**
 * EnergyVad — a small, dependency-free voice-activity detector.
 *
 * Classifies fixed-size 16-bit little-endian mono PCM frames as speech/non-speech
 * by short-time RMS energy against a threshold. This is deliberately simple
 * (no native deps, fully deterministic + testable); it is adequate for
 * push-to-talk-style endpointing in a quiet channel. Noisy far-field capture
 * would want a spectral/model VAD (webrtcvad / silero) — a drop-in future
 * upgrade behind the same isSpeech() boolean.
 *
 * Frame convention: s16le mono. Energy is normalised to 0..1 (sample / 32768).
 */

export interface EnergyVadOptions {
  /** RMS energy (0..1) above which a frame counts as speech. Default 0.02. */
  threshold?: number;
}

export class EnergyVad {
  private readonly threshold: number;

  constructor(opts: EnergyVadOptions = {}) {
    this.threshold = opts.threshold ?? 0.02;
  }

  /** Root-mean-square energy of an s16le mono frame, normalised to 0..1. */
  static rms(frame: Buffer): number {
    const n = Math.floor(frame.length / 2);
    if (n === 0) return 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const s = frame.readInt16LE(i * 2) / 32768;
      sumSq += s * s;
    }
    return Math.sqrt(sumSq / n);
  }

  /** True when the frame's energy exceeds the speech threshold. */
  isSpeech(frame: Buffer): boolean {
    return EnergyVad.rms(frame) > this.threshold;
  }
}
