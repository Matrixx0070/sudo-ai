/**
 * @file channels/activity-timeline.ts
 * @description Compact live agent-activity timeline for chat surfaces.
 *
 * Consumes the {@link ProgressEvent} stream a channel subscribes to (bridged
 * from the agent loop by gateway-turn-handler's progress bridge) and renders
 * the "modern AI app" working card that gets edited in place:
 *
 *   ⠹ working… • 12s
 *   fable-5 | 21k/1.0m (2%)
 *   ✓ memory.search · 1s
 *   ✓ web.fetch · 3s
 *   ▸ browser.screenshot…
 *
 * Everything here is PURE state + formatting (never throws, no I/O, no
 * timers): the channel owns the edit cadence and passes `nowMs` in. Reuses
 * live-state.ts primitives (spinner, elapsed, phase labels) so Telegram, the
 * web SPA and any future surface stay visually consistent.
 */

import type { ProgressEvent } from '../gateway/progress.js';
import { elapsedSeconds, type WorkPhase } from './live-state.js';

/**
 * Claude-style pulse glyphs (braille spinners render as faint broken dots on
 * iOS Telegram). One glyph per tick, breathing out and back in.
 */
const PULSE_FRAMES: readonly string[] = ['✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳'];

/** Professional phase labels (the raw phase words read as debug output). */
const PHASE_LABELS: Readonly<Record<WorkPhase, string>> = {
  waiting: 'Thinking…',
  running: 'Working…',
  streaming: 'Writing…',
};

/** Pulse glyph for a tick. Wraps; safe for any integer. */
function pulseFrame(tick: number): string {
  const n = PULSE_FRAMES.length;
  const i = Math.trunc(Number.isFinite(tick) ? tick : 0);
  return PULSE_FRAMES[((i % n) + n) % n] ?? PULSE_FRAMES[0]!;
}

/** "47s" under a minute, "1m 05s" past it. */
function fmtElapsed(secs: number): string {
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`;
}

/** One tool invocation observed during the turn. */
export interface TimelineStep {
  tool: string;
  startMs: number;
  endMs?: number;
  ok?: boolean;
}

/** Hard caps keep the rendered card small and far under Telegram's 4096. */
const MAX_VISIBLE_STEPS = 6;
const MAX_RENDER_CHARS = 3000;
const MAX_TRACKED_STEPS = 200;

/**
 * Display form of a tool name. Dots become ` › ` — Telegram auto-linkifies
 * dotted names (`browser.search` turns into a blue link because `.search`
 * is a real TLD), and the breadcrumb reads better anyway.
 */
function stepName(tool: string): string {
  const t = (tool || 'tool').trim() || 'tool';
  const clamped = t.length > 48 ? `${t.slice(0, 47)}…` : t;
  return clamped.replace(/\./g, ' › ');
}

/** Duration chip for a finished step: "· 3s" (omitted under a second). */
function durationChip(step: TimelineStep): string {
  if (step.endMs === undefined) return '';
  const secs = elapsedSeconds(step.endMs - step.startMs);
  return secs > 0 ? ` · ${fmtElapsed(secs)}` : '';
}

/**
 * Stateful per-turn activity timeline. Feed every ProgressEvent for the turn
 * via {@link onProgress}; render on the channel's own cadence with
 * {@link render} and once at the end with {@link renderFinal}.
 */
export class ActivityTimeline {
  private readonly steps: TimelineStep[] = [];
  private phase: WorkPhase = 'waiting';
  private errored = false;

  /** Number of steps observed (for tests / summaries). */
  get stepCount(): number {
    return this.steps.length;
  }

  /** Whether any activity beyond the initial wait has been observed. */
  get hasActivity(): boolean {
    return this.steps.length > 0 || this.phase !== 'waiting';
  }

  /** Ingest one progress event. Total: unknown event types are ignored. */
  onProgress(ev: ProgressEvent, nowMs: number): void {
    if (!ev || typeof ev !== 'object') return;
    switch (ev.type) {
      case 'tool_call': {
        if (this.steps.length >= MAX_TRACKED_STEPS) break;
        this.steps.push({ tool: stepName(ev.tool ?? ev.message), startMs: nowMs });
        if (this.phase === 'waiting') this.phase = 'running';
        break;
      }
      case 'tool_result': {
        // Close the newest still-open step for this tool (steps are effectively
        // sequential in the ReACT loop, but match by name to stay robust).
        const name = stepName(ev.tool ?? '');
        for (let i = this.steps.length - 1; i >= 0; i--) {
          const s = this.steps[i]!;
          if (s.endMs === undefined && (s.tool === name || ev.tool === undefined)) {
            s.endMs = nowMs;
            s.ok = ev.ok !== false;
            break;
          }
        }
        break;
      }
      case 'thinking':
        if (this.phase === 'waiting') this.phase = 'running';
        break;
      case 'streaming':
        this.phase = 'streaming';
        break;
      case 'error':
        this.errored = true;
        break;
      default:
        break;
    }
  }

  /** The step lines (tail-windowed, older steps collapsed to a count). */
  private stepLines(nowMs: number): string[] {
    const lines: string[] = [];
    const hidden = Math.max(0, this.steps.length - MAX_VISIBLE_STEPS);
    if (hidden > 0) lines.push(`… +${hidden} earlier step${hidden === 1 ? '' : 's'}`);
    for (const step of this.steps.slice(-MAX_VISIBLE_STEPS)) {
      if (step.endMs === undefined) {
        const secs = elapsedSeconds(nowMs - step.startMs);
        lines.push(`▸ ${step.tool}…${secs > 1 ? ` ${fmtElapsed(secs)}` : ''}`);
      } else {
        lines.push(`${step.ok === false ? '✗' : '✓'} ${step.tool}${durationChip(step)}`);
      }
    }
    return lines;
  }

  /**
   * The live working card: spinner header + optional model/context chip +
   * step timeline. Same inputs as live-state's formatTelegramWorking so the
   * caller's tick loop drives both identically.
   */
  render(input: { nowMs: number; startMs: number; tick: number; chip?: string; verbIndex?: number; whimsy?: boolean }): string {
    const secs = elapsedSeconds(input.nowMs - input.startMs);
    const parts: string[] = [`${pulseFrame(input.tick)} ${PHASE_LABELS[this.phase]} ${fmtElapsed(secs)}`];
    if (input.chip && input.chip.trim()) parts.push(input.chip.trim());
    parts.push(...this.stepLines(input.nowMs));
    const text = parts.join('\n');
    return text.length > MAX_RENDER_CHARS ? `${text.slice(0, MAX_RENDER_CHARS - 1)}…` : text;
  }

  /**
   * Collapsed end-of-turn summary ("✅ Done • 14s • 3 steps"), used when the
   * channel keeps the working message instead of deleting it.
   */
  renderFinal(input: { nowMs: number; startMs: number }): string {
    const secs = elapsedSeconds(input.nowMs - input.startMs);
    const failed = this.steps.filter((s) => s.ok === false).length;
    const head = this.errored ? '⚠️ Finished with errors' : '✅ Done';
    const parts = [`${head} • ${fmtElapsed(secs)}`];
    if (this.steps.length > 0) {
      parts.push(`${this.steps.length} step${this.steps.length === 1 ? '' : 's'}${failed > 0 ? ` (${failed} failed)` : ''}`);
    }
    return parts.join(' • ');
  }
}
