/**
 * VoiceSession — the streaming half of the turn-based voice loop.
 *
 * Consumes a continuous stream of fixed-size 16 kHz mono s16le PCM frames
 * (`pushFrame`), segments them into utterances with an energy VAD + endpointing,
 * runs each closed utterance through an injected `turn` (the runVoiceTurn
 * primitive, pre-bound with a reply seam + providers), emits the reply audio for
 * playback, and supports BARGE-IN: speech detected while the agent is thinking
 * or speaking abandons the in-flight turn and starts capturing the new
 * utterance.
 *
 * State machine:
 *   listening ──speech onset──▶ capturing ──trailing silence──▶ thinking
 *   thinking  ──turn resolves──▶ speaking  ──playback done (notify)──▶ listening
 *   thinking|speaking ──speech onset (barge-in)──▶ capturing
 *
 * The OS audio devices (mic → frames, reply audio → speaker) are the caller's
 * job — this engine is device-agnostic and fully testable by pushing frames.
 * Acoustic echo cancellation is out of scope: feed echo-cancelled or half-duplex
 * frames, or raise `bargeInOnsetFrames`, so the agent's own voice does not
 * self-trigger barge-in.
 */

import { createLogger } from '../shared/logger.js';
import { EnergyVad } from './vad.js';
import type { VoiceTurnResult } from './voice-turn.js';

const log = createLogger('voice:session');

export type VoiceSessionState = 'listening' | 'capturing' | 'thinking' | 'speaking';

export type VoiceSessionEvent =
  | { type: 'state'; state: VoiceSessionState }
  | { type: 'speech-start' }
  | { type: 'utterance'; wav: Buffer; durationMs: number }
  | { type: 'transcript'; text: string }
  | { type: 'reply'; text: string; audio: { buffer: Buffer; format: string; durationMs: number } }
  | { type: 'barge-in' }
  | { type: 'error'; error: string };

export interface VoiceSessionOptions {
  /** PCM sample rate. Default 16000. */
  sampleRate?: number;
  /** Frame duration in ms (input frames must match). Default 20. */
  frameMs?: number;
  /** Consecutive speech frames to declare speech start. Default 3 (~60ms). */
  speechOnsetFrames?: number;
  /** Trailing silence frames that end an utterance. Default 40 (~800ms). */
  silenceHangoverFrames?: number;
  /** Consecutive speech frames during thinking/speaking to trigger barge-in. Default 5 (~100ms). */
  bargeInOnsetFrames?: number;
  /** Recent frames prepended at capture start so the onset is not clipped. Default 8 (~160ms). */
  preRollFrames?: number;
  /** Hard cap on utterance length in frames (forces endpoint). Default 1500 (~30s). */
  maxUtteranceFrames?: number;
}

export interface VoiceSessionDeps {
  /** Runs one turn on a captured utterance WAV (bind runVoiceTurn + reply + providers). */
  turn: (wav: Buffer) => Promise<VoiceTurnResult>;
  /** Injectable VAD (defaults to EnergyVad with default threshold). */
  vad?: EnergyVad;
}

/** Wrap raw s16le mono PCM in a canonical WAV container. */
function wrapWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate (mono, 16-bit)
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits/sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export class VoiceSession {
  private readonly o: Required<VoiceSessionOptions>;
  private readonly vad: EnergyVad;
  private readonly turn: (wav: Buffer) => Promise<VoiceTurnResult>;
  private readonly listeners = new Set<(e: VoiceSessionEvent) => void>();

  private state: VoiceSessionState = 'listening';
  private speechRun = 0;
  private silenceRun = 0;
  private readonly preRoll: Buffer[] = [];
  private capture: Buffer[] = [];
  private captureHadSpeech = false;
  /** Monotonic turn id; a barge-in adds the current id here so its result is dropped. */
  private turnSeq = 0;
  private readonly abandoned = new Set<number>();

  constructor(deps: VoiceSessionDeps, opts: VoiceSessionOptions = {}) {
    this.turn = deps.turn;
    this.vad = deps.vad ?? new EnergyVad();
    this.o = {
      sampleRate: opts.sampleRate ?? 16000,
      frameMs: opts.frameMs ?? 20,
      speechOnsetFrames: opts.speechOnsetFrames ?? 3,
      silenceHangoverFrames: opts.silenceHangoverFrames ?? 40,
      bargeInOnsetFrames: opts.bargeInOnsetFrames ?? 5,
      preRollFrames: opts.preRollFrames ?? 8,
      maxUtteranceFrames: opts.maxUtteranceFrames ?? 1500,
    };
  }

  /** Subscribe to session events. Returns an unsubscribe fn. */
  on(listener: (e: VoiceSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): VoiceSessionState {
    return this.state;
  }

  private emit(e: VoiceSessionEvent): void {
    for (const l of this.listeners) l(e);
  }

  private setState(s: VoiceSessionState): void {
    if (this.state === s) return;
    this.state = s;
    this.emit({ type: 'state', state: s });
  }

  /** Signal that reply playback finished — returns a speaking session to listening. */
  notifyPlaybackFinished(): void {
    if (this.state === 'speaking') this.setState('listening');
  }

  /** Feed one PCM frame. Drives VAD, endpointing, and barge-in. */
  pushFrame(frame: Buffer): void {
    const speech = this.vad.isSpeech(frame);
    if (speech) {
      this.speechRun++;
      this.silenceRun = 0;
    } else {
      this.silenceRun++;
      this.speechRun = 0;
    }

    this.preRoll.push(frame);
    if (this.preRoll.length > this.o.preRollFrames) this.preRoll.shift();

    switch (this.state) {
      case 'listening':
        if (this.speechRun >= this.o.speechOnsetFrames) this.beginCapture();
        return;

      case 'capturing':
        this.capture.push(frame);
        if (speech) this.captureHadSpeech = true;
        if (this.captureHadSpeech && this.silenceRun >= this.o.silenceHangoverFrames) {
          this.endUtterance();
        } else if (this.capture.length >= this.o.maxUtteranceFrames) {
          log.info({ frames: this.capture.length }, 'voice session: max utterance length — forcing endpoint');
          this.endUtterance();
        }
        return;

      case 'thinking':
      case 'speaking':
        if (this.speechRun >= this.o.bargeInOnsetFrames) {
          this.emit({ type: 'barge-in' });
          this.abandoned.add(this.turnSeq); // drop the in-flight turn's result
          this.beginCapture();
        }
        return;
    }
  }

  private beginCapture(): void {
    // Seed with the pre-roll ring so the utterance onset is not clipped.
    this.capture = [...this.preRoll];
    this.captureHadSpeech = true;
    this.setState('capturing');
    this.emit({ type: 'speech-start' });
  }

  private endUtterance(): void {
    const pcm = Buffer.concat(this.capture);
    this.capture = [];
    this.captureHadSpeech = false;
    const durationMs = Math.round((pcm.length / 2 / this.o.sampleRate) * 1000);
    const wav = wrapWav(pcm, this.o.sampleRate);
    this.emit({ type: 'utterance', wav, durationMs });
    this.setState('thinking');

    const id = ++this.turnSeq;
    this.turn(wav)
      .then((res) => {
        if (this.abandoned.has(id)) {
          this.abandoned.delete(id);
          return; // superseded by a barge-in — discard
        }
        if (res.transcript) this.emit({ type: 'transcript', text: res.transcript });
        if (res.audio) {
          this.emit({ type: 'reply', text: res.replyText, audio: { buffer: res.audio.buffer, format: res.audio.format, durationMs: res.audio.durationMs } });
          this.setState('speaking');
        } else {
          // No audio (no speech / empty reply) — nothing to play.
          this.setState('listening');
        }
      })
      .catch((err: unknown) => {
        if (this.abandoned.has(id)) {
          this.abandoned.delete(id);
          return;
        }
        this.emit({ type: 'error', error: err instanceof Error ? err.message : String(err) });
        this.setState('listening');
      });
  }
}
