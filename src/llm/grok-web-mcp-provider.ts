/**
 * @file grok-web-mcp-provider.ts
 * @description IR provider for the FREE grok.com app-chat lane WITH native
 * tool-calling via MCP connectors (ADR 0001). Distinct from grok-web-provider.ts
 * (prompt-emulated, text-only): here grok's cloud drives the tool loop
 * server-side against sudo-ai's hardened public MCP server and returns a FINAL
 * grounded answer, so this provider is a FULL-TURN EXECUTOR — it always yields
 * `stop_reason:'end_turn'` text, never synthetic tool_use.
 *
 * Recipe proven browserless (reference-grok-web-brain-feasibility.md): a connector
 * is registered + per-user CONNECTED + discovered at bootstrap (outside the hot
 * path); this provider just drives one app-chat turn with its `connectorId`.
 *
 * Hot-path invariant: this module (src/llm) must not import core/gateway or
 * core/gdrive. The connectorId and the F18 final-answer screen are therefore
 * INJECTED (config/env + callback), matching the gdrive/notebooklm seam rule.
 *
 * Billing: SuperGrok weekly pool — cost_usd is always 0.
 */

import type { IRRequest, IRResponse, IRContentBlock } from '../../shared-types/ir/v1.js';
import { chatGrokWeb } from './grok-web-media.js';
import { createLogger } from '../core/shared/logger.js';

const log = createLogger('llm:grok-web-mcp');

export const GROK_WEB_MCP_PREFIX = 'grok-web-mcp/';

/** True when the alias targets the native-MCP grok-web lane. */
export function isGrokWebMcpRoute(alias: string): boolean {
  return alias.startsWith(GROK_WEB_MCP_PREFIX);
}

/** Bare web model id (default 'grok-4' = Expert = the account's frontier). */
export function grokWebMcpModelId(alias: string): string {
  return alias.slice(GROK_WEB_MCP_PREFIX.length) || 'grok-4';
}

/** Injectable seams — real implementations by default, mocked in tests. */
export interface GrokWebMcpDeps {
  /**
   * The registered+connected MCP connectorId to attach to the turn, or null when
   * the connector is not ready (bootstrap not run / lane disabled). Sourced from
   * config/env by default (bootstrap sets SUDO_GROK_WEB_MCP_CONNECTOR_ID).
   */
  getConnectorId: () => string | null;
  /** Drive one app-chat turn with the connector attached. Defaults to chatGrokWeb. */
  chat: (
    message: string,
    opts: { connectorIds: string[]; modelName?: string; disableSearch?: boolean; timeoutSec?: number },
  ) => Promise<{ text: string; toolMarkers?: string[] }>;
  /**
   * OPTIONAL F18 screen on grok's FINAL answer (tool results reach grok's context,
   * not ours; what re-enters sudo-ai is grok's text — screen it for laundered
   * injection). Injected from a layer that MAY import core/gdrive. Returns a risk
   * 0..1; the provider LOGS high risk but passes the answer through (it is the
   * assistant's reply — hard-blocking would break the turn; storage-time
   * quarantine at the memory API remains the backstop). Default: unset (skip).
   */
  screenFinalAnswer?: (text: string) => { risk: number; reason?: string };
  /** Transcript → single app-chat message. Defaults to renderTranscript below. */
  renderMessage?: (system: string | undefined, messages: IRRequest['messages']) => string;
}

/** High-risk threshold above which grok's final answer is logged as suspicious. */
const FINAL_ANSWER_RISK_LOG_THRESHOLD = 0.8;

function defaultDeps(): GrokWebMcpDeps {
  return {
    getConnectorId: () => process.env['SUDO_GROK_WEB_MCP_CONNECTOR_ID'] || null,
    chat: (message, opts) => chatGrokWeb(message, opts),
  };
}

/** Flatten one content block to plain text for the app-chat message. */
function blockToText(b: IRContentBlock): string {
  switch (b.type) {
    case 'text':
      return b.text;
    case 'tool_use':
      return `[called tool ${b.name}(${JSON.stringify(b.input)})]`;
    case 'tool_result': {
      const c = typeof b.content === 'string' ? b.content : b.content.map((x) => (x.type === 'text' ? x.text : '')).join('');
      return `[tool result: ${c}]`;
    }
    default:
      return ''; // image / thinking — not carried onto the app-chat text lane
  }
}

/**
 * Render the IR transcript into a single app-chat message. No tool-emulation
 * scaffolding (grok uses its NATIVE MCP tools) — just system + the turn history.
 */
export function renderTranscript(system: string | undefined, messages: IRRequest['messages']): string {
  const parts: string[] = [];
  if (system && system.trim()) parts.push(system.trim());
  for (const m of messages) {
    const body = m.content.map(blockToText).filter(Boolean).join('\n');
    if (body) parts.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${body}`);
  }
  return parts.join('\n\n');
}

/**
 * One brain turn on the free lane with native MCP tools. Throws on a transient
 * lane failure or a not-ready connector so callIR's failover chain advances.
 */
export async function callGrokWebMcpIR(ir: IRRequest, deps: GrokWebMcpDeps = defaultDeps()): Promise<IRResponse> {
  const connectorId = deps.getConnectorId();
  if (!connectorId) {
    throw new Error('grok-web-mcp: connector not ready (bootstrap did not register/connect a connector).');
  }
  const modelName = grokWebMcpModelId(ir.alias);
  const message = (deps.renderMessage ?? renderTranscript)(ir.system, ir.messages);

  const res = await deps.chat(message, {
    connectorIds: [connectorId],
    modelName,
    disableSearch: true,
    timeoutSec: 120,
  });

  if (deps.screenFinalAnswer) {
    const v = deps.screenFinalAnswer(res.text);
    if (v.risk >= FINAL_ANSWER_RISK_LOG_THRESHOLD) {
      log.warn({ risk: v.risk, reason: v.reason }, 'grok-web-mcp: final answer flagged high injection risk');
    }
  }

  return {
    blocks: [{ type: 'text', text: res.text }],
    stop_reason: 'end_turn',
    usage: { in: 0, out: 0, cached_in: 0 },
    cost_usd: 0,
    trace_id: ir.trace_id,
    extra: {
      provider: 'grok-web-mcp',
      model: modelName,
      lane: 'app-chat-weekly-pool',
      connectorId,
      ...(res.toolMarkers && res.toolMarkers.length ? { toolMarkers: res.toolMarkers } : {}),
    },
  };
}
