/**
 * @file vision-claude-oauth.ts
 * @description The Claude OAuth seat leg of the vision choke point (2026-07-31).
 *
 * Vision is live-proven on the Max seat: image content blocks on the Messages
 * API under `oauth-2025-04-20`. Because the seat is flat-rate, this leg is
 * tried FIRST in {@link import('./client.js').visionIR} and the metered
 * xai/openai legs remain as failovers (no capability dropped).
 *
 * Extracted from client.ts to keep that file under its max-lines ratchet.
 */

import { PROVIDER_BASE_URLS } from './endpoints.js';

/** Default seat model for vision. Any vision-capable claude id works. */
const DEFAULT_VISION_MODEL = 'claude-haiku-4-5-20251001';

/** Per-route cap so a hung provider can never hang the calling tool. */
const VISION_TIMEOUT_MS = 60_000;

export interface ClaudeVisionRequest {
  /** data: URL or https URL of the image. */
  imageUrl: string;
  prompt: string;
  maxTokens?: number;
}

export type ClaudeVisionOutcome =
  | { ok: true; text: string }
  | { ok: false; reason: string };

/**
 * Build the Anthropic messages body for a vision turn. A `data:` URL becomes a
 * base64 source block; anything else becomes a url source block.
 */
export function buildClaudeVisionBody(req: ClaudeVisionRequest, model: string): Record<string, unknown> {
  const dataMatch = /^data:([^;,]+);base64,(.+)$/.exec(req.imageUrl);
  const imageBlock = dataMatch
    ? { type: 'image', source: { type: 'base64', media_type: dataMatch[1], data: dataMatch[2] } }
    : { type: 'image', source: { type: 'url', url: req.imageUrl } };
  return {
    model,
    max_tokens: req.maxTokens ?? 1024,
    messages: [{ role: 'user', content: [imageBlock, { type: 'text', text: req.prompt }] }],
  };
}

/**
 * Attempt the seat leg. Never throws: returns `{ok:false, reason}` when the
 * seat has no usable token or the call fails, so the caller falls through to
 * its metered legs.
 */
export async function tryClaudeOAuthVision(req: ClaudeVisionRequest): Promise<ClaudeVisionOutcome> {
  try {
    const { getClaudeOAuthManager } = await import('./claude-oauth-manager.js');
    const mgr = getClaudeOAuthManager();
    let token = mgr.getAccessToken();
    if (!token) {
      await mgr.refreshToken().catch(() => false);
      token = mgr.getAccessToken();
    }
    if (!token) return { ok: false, reason: 'claude-oauth: no usable token' };

    const model = process.env['SUDO_VISION_CLAUDE_MODEL'] ?? DEFAULT_VISION_MODEL;
    const body = buildClaudeVisionBody(req, model);
    const { applyOAuthBodyContract } = await import('./transport.js');
    applyOAuthBodyContract(body);

    const res = await fetch(`${PROVIDER_BASE_URLS.anthropic}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
    });

    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { ok: false, reason: `claude-oauth vision failed: ${res.status} ${t.slice(0, 200)}` };
    }

    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = (json.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
    if (text.length === 0) return { ok: false, reason: 'claude-oauth vision: empty text' };
    return { ok: true, text };
  } catch (err) {
    return { ok: false, reason: `claude-oauth vision leg error: ${String(err).slice(0, 200)}` };
  }
}
