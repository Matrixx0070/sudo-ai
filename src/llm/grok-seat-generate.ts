/**
 * @file grok-seat-generate.ts
 * @description Seat-lane drop-in for the metered `api.x.ai` chat-completions call.
 *
 * One-shot text generation on the $30 Grok subscription seat: routes through the
 * IR choke point (`callIR`) with the `xai-oauth/grok-4.5` alias, so it rides the
 * OAuth seat lane (cli-chat-proxy.grok.com — free/seat-covered, NEVER the metered
 * api.x.ai) and inherits token refresh, the egress allowlist, and gateway logging
 * for free. Returns the assembled text; throws on an empty/error completion so the
 * caller's retry/`withRetry` wrapper behaves exactly as with the original axios call.
 *
 * Swap for the tutorial's `generateContent()`:
 *   const text = await generateContentSeat('Create a description for a futuristic NFT');
 */
import { callIR } from './transport.js';
import type { IRRequest } from '../../shared-types/ir/v1.js';

/** The single confirmed general-purpose text model on the seat's OAuth lane. */
export const GROK_SEAT_TEXT_MODEL = 'xai-oauth/grok-4.5';

export interface GenerateContentSeatOptions {
  /** Override the seat model alias (e.g. 'xai-oauth/grok-composer-2.5-fast'). */
  model?: string;
  /** Upper bound on output tokens. Default 1000 (matches the tutorial). */
  maxTokens?: number;
  /** Optional sampling temperature; omitted when undefined (provider default). */
  temperature?: number;
  /** Optional system instruction prepended to the turn. */
  system?: string;
}

/**
 * Generate text on the Grok seat lane. Drop-in for a metered-API `generateContent`.
 * @throws when the seat returns an error stop_reason or no text (mirrors a failed
 *   HTTP call so existing retry logic triggers).
 */
export async function generateContentSeat(
  prompt: string,
  opts: GenerateContentSeatOptions = {},
): Promise<string> {
  const ir: IRRequest = {
    alias: opts.model ?? GROK_SEAT_TEXT_MODEL,
    caller: 'chat',
    purpose: 'grok-seat.generate',
    priority: 'user',
    trace_id: '',
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    max_tokens: opts.maxTokens ?? 1000,
  };
  if (opts.system !== undefined) ir.system = opts.system;
  if (opts.temperature !== undefined) ir.temperature = opts.temperature;

  const res = await callIR(ir);
  if (res.stop_reason === 'error') {
    throw new Error(`grok seat generateContent failed: stop_reason 'error' (model ${ir.alias})`);
  }
  const text = res.blocks
    .filter((b): b is Extract<(typeof res.blocks)[number], { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (text.trim() === '') {
    throw new Error(`grok seat generateContent returned no text (stop_reason ${res.stop_reason})`);
  }
  return text;
}
