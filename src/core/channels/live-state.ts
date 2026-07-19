/**
 * @file channels/live-state.ts
 * @description BO11 / scorecard-S13 — live working-states shared across surfaces.
 *
 * OpenClaw's TUI footer becomes a 3-phase progress line while a turn runs:
 *   `⠦ noodling… • 0s`  (waiting)  →  `⠋ running • Ns`  →  `⠏ streaming • Ns`
 * with an always-visible chip `… | xai/grok-4.3 | tokens 21k/1.0m (2%)`.
 *
 * This module is the ONE pure source of truth for that state so the web SPA and
 * the Telegram progressive-edit message render identically. It maps the agent
 * loop's {@link AgentEvent} stream onto a phase, formats the elapsed counter,
 * builds the always-visible model/context chip, and produces the wire frame the
 * SPA consumes + the text line Telegram edits.
 *
 * Everything here is PURE and total (never throws). Whimsy (the rotating verb on
 * the waiting phase) is injected via {@link PhaseFrameInput.whimsy} +
 * {@link PhaseFrameInput.verbIndex}; with whimsy off the label is the plain
 * phase word so prod tone is unchanged.
 */

import type { AgentEvent } from '../agent/types.js';
import { workingVerb } from '../whimsy/verbs.js';

/** The three live phases of a turn, in order. */
export type WorkPhase = 'waiting' | 'running' | 'streaming';

/** Phase ordering used to keep the SPA counter monotonic across a turn. */
export const PHASE_ORDER: readonly WorkPhase[] = ['waiting', 'running', 'streaming'];

/** Braille spinner frames (matches OpenClaw's live footer glyphs). */
export const SPINNER_FRAMES: readonly string[] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Deterministic spinner glyph for a tick. Wraps; safe for any integer. */
export function spinnerFrame(tick: number): string {
  const n = SPINNER_FRAMES.length;
  const i = Math.trunc(Number.isFinite(tick) ? tick : 0);
  return SPINNER_FRAMES[((i % n) + n) % n] ?? SPINNER_FRAMES[0]!;
}

/** ms → whole elapsed seconds, floored, never negative. */
export function elapsedSeconds(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  return Math.floor(elapsedMs / 1000);
}

/**
 * Advance the phase given the previous phase and the next agent event.
 * Monotonic within a turn: never steps backward (streaming stays streaming even
 * if a late tool-call arrives), matching the visual progression waiting → running
 * → streaming. Unknown/terminal events keep the current phase.
 */
export function nextPhase(prev: WorkPhase, ev: AgentEvent): WorkPhase {
  const rank = (p: WorkPhase): number => PHASE_ORDER.indexOf(p);
  let candidate: WorkPhase = prev;
  switch (ev.type) {
    case 'tool-call':
      candidate = 'running';
      break;
    case 'message':
      candidate = 'running';
      break;
    case 'stream-chunk':
      candidate = 'streaming';
      break;
    default:
      candidate = prev;
  }
  return rank(candidate) > rank(prev) ? candidate : prev;
}

/** Inputs for the pure label + frame builders. */
export interface PhaseFrameInput {
  phase: WorkPhase;
  elapsedMs: number;
  /** Always-visible chip: "model | tokens used/window (pct%)". */
  chip?: string;
  /** Injected rotation index for the whimsy verb (waiting phase only). */
  verbIndex?: number;
  /** Force whimsy on/off; defaults to the SUDO_WHIMSY env gate via workingVerb. */
  whimsy?: boolean;
}

/**
 * Human label for a phase. On the waiting phase with whimsy enabled this is a
 * rotating verb ("noodling…"); otherwise the plain phase word. Running/streaming
 * are never whimsified (parity with OpenClaw, which only whimsifies the wait).
 */
export function phaseLabel(input: Pick<PhaseFrameInput, 'phase' | 'verbIndex' | 'whimsy'>): string {
  if (input.phase === 'waiting') {
    const verb = workingVerb(input.verbIndex ?? 0, input.whimsy === undefined ? undefined : { enabled: input.whimsy });
    return verb ? `${verb}…` : 'waiting';
  }
  return input.phase; // 'running' | 'streaming'
}

/** Build the model/context chip string from status-card primitives. */
export function formatModelContextChip(model: string, context: string): string {
  const m = (model && model.trim()) || 'unknown';
  const c = (context && context.trim()) || '';
  return c ? `${m} | ${c}` : m;
}

/**
 * The SPA wire frame for a live phase. Shape mirrors the SPA's ChatWSMessage
 * union (`type:'phase'`). `elapsedSec` is the SERVER baseline; the client ticks
 * locally each second from it so the counter stays live without frame spam.
 */
export function buildPhaseFrame(input: PhaseFrameInput): string {
  const frame: {
    type: 'phase';
    phase: WorkPhase;
    elapsedSec: number;
    label: string;
    chip?: string;
  } = {
    type: 'phase',
    phase: input.phase,
    elapsedSec: elapsedSeconds(input.elapsedMs),
    label: phaseLabel(input),
  };
  if (input.chip && input.chip.trim()) frame.chip = input.chip.trim();
  return JSON.stringify(frame);
}

/**
 * The Telegram progressive-edit line — a single message body we keep editing as
 * the turn runs, e.g. `⠋ running • 4s\nxai/grok-4.3 | 21k/1.0m (2%)`.
 */
export function formatTelegramWorking(input: PhaseFrameInput & { tick?: number }): string {
  const spinner = spinnerFrame(input.tick ?? 0);
  const label = phaseLabel(input);
  const secs = elapsedSeconds(input.elapsedMs);
  const head = `${spinner} ${label} • ${secs}s`;
  return input.chip && input.chip.trim() ? `${head}\n${input.chip.trim()}` : head;
}

/**
 * Stateful per-turn tracker. Bind at run() start; feed it each {@link AgentEvent}
 * and it yields a phase frame (JSON string) only when the phase actually changes,
 * so downstream sends stay quiet during steady streaming. `chip` and whimsy are
 * fixed for the turn (computed once, cheap to render).
 */
export class LiveStateTracker {
  private phase: WorkPhase = 'waiting';
  private readonly startMs: number;
  private readonly chip: string | undefined;
  private readonly verbIndex: number;
  private readonly whimsy: boolean | undefined;

  constructor(opts?: { startMs?: number; chip?: string; verbIndex?: number; whimsy?: boolean }) {
    this.startMs = opts?.startMs ?? Date.now();
    this.chip = opts?.chip;
    this.verbIndex = opts?.verbIndex ?? 0;
    this.whimsy = opts?.whimsy;
  }

  /** Current phase (for inspection / tests). */
  get currentPhase(): WorkPhase {
    return this.phase;
  }

  private frameInput(nowMs: number): PhaseFrameInput {
    return {
      phase: this.phase,
      elapsedMs: nowMs - this.startMs,
      ...(this.chip !== undefined ? { chip: this.chip } : {}),
      verbIndex: this.verbIndex,
      ...(this.whimsy !== undefined ? { whimsy: this.whimsy } : {}),
    };
  }

  /** The initial "waiting" frame to emit at turn start (before any event). */
  initialFrame(nowMs: number = Date.now()): string {
    return buildPhaseFrame(this.frameInput(nowMs));
  }

  /** Feed an event; returns a phase frame JSON only when the phase changed. */
  onEvent(ev: AgentEvent, nowMs: number = Date.now()): string | null {
    const next = nextPhase(this.phase, ev);
    if (next === this.phase) return null;
    this.phase = next;
    return buildPhaseFrame(this.frameInput(nowMs));
  }
}
