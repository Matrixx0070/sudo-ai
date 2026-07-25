/**
 * @file grok-web-provider.ts
 * @description First-class IR provider for the FREE grok.com app-chat lane, so
 * `grok-web/<model>` is selectable in config/sudo-ai.json5 models.primary[]
 * exactly like `claude-oauth/...` or `xai-oauth/...`. Unlike the HTTP providers
 * (egress adapter → fetch → parse), this is a LOCAL provider: it runs the
 * prompt-emulated `grokWebComplete` over the durable web session + pooled
 * statsig, and returns a normal IRResponse (tool_use or end_turn). callIR
 * short-circuits to this before the wire path (see transport.ts).
 *
 * Billing: draws the SuperGrok WEEKLY pool — cost_usd is always 0. On a 429
 * (pool/burst throttle) grokWebComplete throws GrokWebRateLimitedError, which
 * callIR logs and the failover chain moves past — never a metered fallback.
 */

import type { IRRequest, IRResponse } from '../../shared-types/ir/v1.js';
import { getGrokConnector } from './grok-connector.js';

export const GROK_WEB_PREFIX = 'grok-web/';

/** True when the alias targets the local grok-web lane. */
export function isGrokWebRoute(alias: string): boolean {
  return alias.startsWith(GROK_WEB_PREFIX);
}

/** Bare web model id (default 'grok-4' = Expert = the account's frontier). */
export function grokWebModelId(alias: string): string {
  return alias.slice(GROK_WEB_PREFIX.length) || 'grok-4';
}

/**
 * One brain turn on the free lane, returned as an IRResponse. Throws on
 * transient lane failure (rate-limit / mint failure) so callIR's failover chain
 * advances to the next configured model.
 */
export async function callGrokWebIR(ir: IRRequest): Promise<IRResponse> {
  const modelName = grokWebModelId(ir.alias);
  const blocks = await getGrokConnector().complete(ir.messages, ir.tools ?? [], {
    modelName,
    ...(ir.system ? { system: ir.system } : {}),
  });
  const stopReason: IRResponse['stop_reason'] = blocks.some((b) => b.type === 'tool_use')
    ? 'tool_use'
    : 'end_turn';
  return {
    blocks,
    stop_reason: stopReason,
    usage: { in: 0, out: 0, cached_in: 0 },
    cost_usd: 0,
    trace_id: ir.trace_id,
    extra: { provider: 'grok-web', model: modelName, lane: 'app-chat-weekly-pool' },
  };
}
