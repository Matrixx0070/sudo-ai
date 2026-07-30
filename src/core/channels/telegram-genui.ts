/**
 * @file telegram-genui.ts
 * @description TX13 — Generative Telegram UI: map the A2UI CLOSED schema
 * (canvas/schema.ts — validated server-side, plain-text strings only) onto
 * Telegram primitives. Text-ish components render as markdown lines; buttons
 * become an inline keyboard whose taps re-enter the agent as the SAME typed
 * `[CANVAS EVENT]` wire format the web bridge dispatches — one action
 * vocabulary across channels.
 *
 * callback_data is capped at 64 bytes, so actionIds ride a TTL'd token
 * registry (tx13:a:<token>), never raw. Forms render read-only in v1 (a note
 * tells the owner to reply in chat); interactive forms are TX13 v2.
 * Flag: SUDO_TG_GENUI=1 (default OFF).
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../shared/logger.js';
import type { CanvasPayload, CanvasComponent } from '../canvas/schema.js';

const log = createLogger('channels:tg-genui');

export function telegramGenuiEnabled(): boolean {
  return process.env['SUDO_TG_GENUI'] === '1';
}

export const TX13_CALLBACK_PREFIX = 'tx13:a:';

// --- Action-token registry (callback_data is 64 bytes; actionIds are not) ----

interface TokenEntry { actionId: string; sessionId: string; expiresAt: number }
const TOKEN_TTL_MS = 60 * 60_000;
const TOKEN_CAP = 500;
const tokens = new Map<string, TokenEntry>();

function prune(): void {
  const now = Date.now();
  for (const [k, v] of tokens) if (v.expiresAt <= now) tokens.delete(k);
  // Cap: evict oldest (Map preserves insertion order).
  while (tokens.size > TOKEN_CAP) {
    const first = tokens.keys().next().value;
    if (first === undefined) break;
    tokens.delete(first);
  }
}

export function registerActionToken(sessionId: string, actionId: string): string {
  prune();
  const token = randomUUID().slice(0, 13);
  tokens.set(token, { actionId, sessionId, expiresAt: Date.now() + TOKEN_TTL_MS });
  return token;
}

/** Resolve a tx13 callback-data string → the registered action, or null. */
export function resolveTx13Callback(data: string): { actionId: string; sessionId: string } | null {
  if (!data.startsWith(TX13_CALLBACK_PREFIX)) return null;
  const token = data.slice(TX13_CALLBACK_PREFIX.length);
  const entry = tokens.get(token);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return { actionId: entry.actionId, sessionId: entry.sessionId };
}

/** The typed event text a tap feeds back into the agent turn (same wire as web). */
export function canvasEventText(actionId: string): string {
  const payload = JSON.stringify({ kind: 'canvas-event', actionId, formKind: 'button', values: {} });
  return `[CANVAS EVENT] The user interacted with a rendered UI component. Structured event: ${payload}`;
}

// --- Pure component mapping ---------------------------------------------------

function bar(value: number): string {
  const filled = Math.round(Math.max(0, Math.min(100, value)) / 10);
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

function renderComponent(c: CanvasComponent, lines: string[]): void {
  switch (c.type) {
    case 'text':
      lines.push(c.variant === 'heading' ? `**${c.text}**` : c.variant === 'caption' ? `_${c.text}_` : c.text);
      break;
    case 'metric':
      lines.push(`${c.label}: **${c.value}**${c.delta ? ` (${c.delta}${c.trend === 'up' ? ' ↑' : c.trend === 'down' ? ' ↓' : ''})` : ''}`);
      break;
    case 'progress':
      lines.push(`${c.label ? `${c.label} ` : ''}${bar(c.value)} ${Math.round(c.value)}%`);
      break;
    case 'list':
      c.items.forEach((it, i) => lines.push(c.ordered ? `${i + 1}. ${it}` : `• ${it}`));
      break;
    case 'table': {
      lines.push('```');
      lines.push(c.columns.join(' | '));
      for (const row of c.rows.slice(0, 20)) lines.push(row.join(' | '));
      if (c.rows.length > 20) lines.push(`… +${c.rows.length - 20} rows`);
      lines.push('```');
      break;
    }
    case 'chart': {
      if (c.title) lines.push(`**${c.title}**`);
      const max = Math.max(1, ...c.series.map((s) => s.value));
      for (const s of c.series.slice(0, 12)) {
        lines.push(`${s.label}: ${'▮'.repeat(Math.max(1, Math.round((s.value / max) * 12)))} ${s.value}`);
      }
      break;
    }
    case 'form': {
      if (c.title) lines.push(`**${c.title}**`);
      for (const f of c.fields) lines.push(`▸ ${f.label}${f.required ? ' *' : ''}${f.options ? ` (${f.options.join('/')})` : ''}`);
      lines.push(`_Reply in chat to fill this in (interactive forms coming)._`);
      break;
    }
    case 'button':
      // Buttons render into the keyboard, not the text — handled by caller.
      break;
  }
}

export interface TelegramCanvasRender {
  text: string;
  /** Inline-keyboard rows: one button per ButtonComponent, order preserved. */
  buttons: Array<Array<{ text: string; callbackData: string }>>;
}

/** Map a VALIDATED payload to Telegram text + keyboard. Pure except token registry. */
export function renderCanvasForTelegram(sessionId: string, payload: CanvasPayload): TelegramCanvasRender {
  const lines: string[] = [];
  if (payload.title) lines.push(`🖼 **${payload.title}**`, '');
  const buttons: Array<Array<{ text: string; callbackData: string }>> = [];
  for (const c of payload.components) {
    if (c.type === 'button') {
      buttons.push([{ text: c.label, callbackData: `${TX13_CALLBACK_PREFIX}${registerActionToken(sessionId, c.actionId)}` }]);
    } else {
      renderComponent(c, lines);
    }
  }
  return { text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() || '(empty canvas)', buttons };
}

// --- Sink seam (wired by cli.ts) ----------------------------------------------

export interface TelegramGenuiSink {
  /** sessionId → telegram peerId when the session lives on telegram; else null. */
  resolvePeer: (sessionId: string) => Promise<string | null>;
  /** Send text + keyboard rows to a peer. */
  send: (peerId: string, render: TelegramCanvasRender) => Promise<void>;
}

let _sink: TelegramGenuiSink | null = null;
export function setTelegramGenuiSink(sink: TelegramGenuiSink | null): void { _sink = sink; }

/**
 * Try to render a canvas payload to the session's Telegram peer.
 * Returns ok=false with a reason when the flag is off, no sink is wired, or
 * the session is not a Telegram session — callers fall back to text.
 */
export async function tryTelegramCanvasRender(sessionId: string, payload: CanvasPayload): Promise<{ ok: boolean; reason?: string }> {
  if (!telegramGenuiEnabled()) return { ok: false, reason: 'SUDO_TG_GENUI off' };
  if (!_sink) return { ok: false, reason: 'no telegram genui sink wired' };
  try {
    const peerId = await _sink.resolvePeer(sessionId);
    if (!peerId) return { ok: false, reason: 'session is not a telegram session' };
    await _sink.send(peerId, renderCanvasForTelegram(sessionId, payload));
    log.info({ sessionId, peerId, components: payload.components.length }, 'TX13: canvas rendered to Telegram');
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}

/** Test hook. */
export function _resetTx13(): void { tokens.clear(); _sink = null; }
