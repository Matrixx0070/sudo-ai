/**
 * @file skill/tools/federate.ts
 * @description skill.federate — publishes tool refinement events to the
 * federation layer (AuditChainSync, Wave 7E) or fetches peer events.
 *
 * Duck-typed federation access: if AuditChainSync is not available in the
 * runtime environment, returns {ok: false, reason: 'federation not configured'}.
 * All cross-module deps are accessed via ToolRegistry.getGlobal() or require().
 */

import { createLogger } from '../../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';

const logger = createLogger('skill:federate');

// ---------------------------------------------------------------------------
// Duck-typed federation interface
// ---------------------------------------------------------------------------

interface AuditChainSyncLike {
  appendToChain(event: {
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<void> | void;
  fetchPeerTail?(limit?: number): Promise<PeerEvent[]> | PeerEvent[];
}

interface PeerEvent {
  id?: string;
  eventType?: string;
  event_type?: string;
  payload?: unknown;
  ts?: number;
  received_at?: number;
}

// ---------------------------------------------------------------------------
// Federation discovery — fail-open
// ---------------------------------------------------------------------------

/**
 * Attempt to resolve a live AuditChainSync instance from the global registry
 * or a well-known global. Returns null when federation is not available.
 */
function resolveFederation(): AuditChainSyncLike | null {
  // Check env to confirm federation is expected
  const envUrl = process.env['SUDO_FEDERATION_URL'] ?? process.env['SUDO_AUDIT_CHAIN_URL'];
  if (!envUrl) return null;

  // Try global registry approach: some waves inject via globalThis
  const g = globalThis as Record<string, unknown>;
  const candidate = g['__auditChainSync'] ?? g['auditChainSync'];
  if (candidate && typeof (candidate as Record<string, unknown>)['appendToChain'] === 'function') {
    return candidate as AuditChainSyncLike;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const federateTool: ToolDefinition = {
  name: 'skill.federate',
  description:
    'Publish tool refinement events to the federation layer (AuditChainSync) or fetch peer skill events. ' +
    'Returns {ok: false, reason: "federation not configured"} when federation is not available in the environment.',
  category: 'skill' as import('../../../types.js').ToolCategory,
  timeout: 20_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Operation: "publish" to send a refinement event, "fetch" to pull peer events.',
      enum: ['publish', 'fetch'],
    },
    eventType: {
      type: 'string',
      description: 'Event type tag (used for filtering on fetch). Default: "skill.federate".',
      default: 'skill.federate',
    },
    payload: {
      type: 'object',
      description: 'Payload to publish (required for action=publish).',
      properties: {},
    },
    peerName: {
      type: 'string',
      description: 'Optional peer identifier to filter results (for fetch).',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string | undefined;
    const eventType = (params['eventType'] as string | undefined) ?? 'skill.federate';
    const payload = (params['payload'] as Record<string, unknown> | undefined) ?? {};

    logger.info({ session: ctx.sessionId, action, eventType }, 'skill.federate invoked');

    if (!action || !['publish', 'fetch'].includes(action)) {
      return { success: false, output: 'action must be "publish" or "fetch".' };
    }

    const fed = resolveFederation();
    if (!fed) {
      logger.info({ action }, 'skill.federate: federation not configured');
      return {
        success: true,
        output: 'Federation not configured for this instance.',
        data: { ok: false, reason: 'federation not configured' },
      };
    }

    try {
      if (action === 'publish') {
        const event = {
          eventType,
          payload: { source: 'skill.federate', toolRefinement: payload, ts: Date.now() },
        };
        await Promise.resolve(fed.appendToChain(event));
        logger.info({ eventType }, 'skill.federate: event published');
        return {
          success: true,
          output: `Refinement event published to federation (type: ${eventType}).`,
          data: { ok: true, event },
        };
      }

      // action === 'fetch'
      if (typeof fed.fetchPeerTail !== 'function') {
        return {
          success: true,
          output: 'Federation available but fetchPeerTail not implemented.',
          data: { ok: false, reason: 'fetchPeerTail not available' },
        };
      }

      const peerEvents = (await Promise.resolve(fed.fetchPeerTail(50))) as PeerEvent[];
      const filtered = peerEvents.filter(e => {
        const et = e.eventType ?? e.event_type ?? '';
        return et === eventType || et === 'skill.federate';
      });

      const summary = filtered.map(e => ({
        id: e.id,
        eventType: e.eventType ?? e.event_type,
        ts: e.ts ?? e.received_at,
        payloadPreview: JSON.stringify(e.payload ?? {}).slice(0, 80),
      }));

      return {
        success: true,
        output: filtered.length === 0
          ? `No peer skill.federate events found in tail.`
          : `Found ${filtered.length} peer event(s):\n${summary.map(s => `  [${s.id?.slice(0, 8)}] ${s.eventType} @ ${s.ts}: ${s.payloadPreview}`).join('\n')}`,
        data: { ok: true, events: summary, totalFetched: peerEvents.length },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'skill.federate error');
      return { success: false, output: `skill.federate error: ${msg}` };
    }
  },
};
