/**
 * @file shadow.ts
 * @description gw-refactor Phase 7 — shadow machinery. Per A19 (PROGRESS.md)
 * there are NO dual provider calls: shadow compares TRANSFORMATIONS on the
 * same data.
 *
 * Two comparison axes:
 *   1. Request side — map the legacy BrainRequest into IR (brainRequestToIR),
 *      egress it through the matching adapter, then semantically compare the
 *      wire body against the ORIGINAL legacy inputs (requestShadowDiff). Any
 *      dropped/mangled content = material.
 *   2. Response side — map the legacy ai-SDK-shaped result into an IRResponse
 *      (resultToIR) and compare it against the legacy result (compareShadow):
 *      stop-reason class, exact text, tool-call name/args, usage ±10%.
 *
 * Live hook: runShadow() — fire-and-forget (queueMicrotask), gated on
 * LLM_SHADOW=1 (default OFF: zero behavior/cost change when unset), fully
 * fail-open, records a TINY diff summary row (field names + hashes, never
 * content) into gateway.db with caller 'shadow' / purpose 'live-shadow'.
 */

import { randomUUID, createHash } from 'node:crypto';
import type {
  IRRequest,
  IRResponse,
  IRMessage,
  IRContentBlock,
  IRTool,
  IRToolUseBlock,
  IRToolResultBlock,
  IRUsage,
} from '../../shared-types/ir/v1.js';
import { egressAnthropic, STRUCTURED_OUTPUT_TOOL } from './adapters/egress-anthropic.js';
import { egressOpenAI } from './adapters/egress-openai.js';
import { isAnthropicModelId } from '../core/brain/prompt-cache-discipline.js';
import { getGatewayCallLog } from './logging.js';
import { createLogger } from '../core/shared/logger.js';

const logger = createLogger('llm-shadow');

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Legacy shapes (structural — accept both BrainRequest/BrainMessage and the
// looser shapes found in traces.db prompt_raw / model_params).
// ---------------------------------------------------------------------------

/** Legacy history message (BrainMessage-shaped; content is always a string). */
export interface ShadowLegacyMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Assistant tool invocations (ToolCallFromLLM: parsed argument OBJECT). */
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  /** role:'tool' — links back to the originating call. */
  toolCallId?: string;
  toolName?: string;
  images?: Array<{ type: 'base64' | 'url'; data: string; mediaType?: string }>;
}

/** Legacy request (BrainRequest subset the shadow needs). */
export interface ShadowBrainRequest {
  messages: ShadowLegacyMessage[];
  /** Assembled system prompt (brain passes effectiveSystem at the call site). */
  system?: string;
  model?: string;
  source?: string;
  temperature?: number;
  maxTokens?: number;
  /** OpenAI-function-shaped ToolSchema[] (registry emission). */
  tools?: Array<{ type?: string; function?: { name?: string; description?: string; parameters?: Record<string, unknown> } }>;
  /**
   * Session id when the caller has one (brain threads it through) — mapped to
   * ir.extra.conv_id so conversation-keyed features (xai-oauth prompt caching
   * via the x-grok-conv-id header) get a stable key per session.
   */
  sessionId?: string;
}

/** Legacy result as brain.ts reads it off the ai SDK / BrainResponse. */
export interface ShadowLegacyResult {
  text?: string;
  /** ai-SDK / BrainResponse finish reason ('stop'|'length'|'tool-calls'|'content-filter'|'error'|…). */
  finishReason?: string | null;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    /** ai-SDK v6 naming, accepted as fallback. */
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  };
  toolCalls?: Array<{
    id?: string;
    name?: string;
    /** ai-SDK naming variants. */
    toolName?: string;
    arguments?: Record<string, unknown>;
    args?: Record<string, unknown>;
    input?: Record<string, unknown>;
  }>;
}

/** Diff verdict: `fields` lists MATERIAL divergences; `nonMaterial` the benign ones. */
export interface ShadowDiff {
  material: boolean;
  fields: string[];
  nonMaterial?: string[];
}

// ---------------------------------------------------------------------------
// brainRequestToIR — legacy BrainRequest → IRRequest (cutover-critical mapper)
// ---------------------------------------------------------------------------

/** _gatewayPriorityFor parity (brain.ts): chat/agent → user, else background. */
function priorityFor(source: string | undefined): 'user' | 'background' {
  return source === 'chat' || source === 'agent' ? 'user' : 'background';
}

function imageToBlock(img: NonNullable<ShadowLegacyMessage['images']>[number]): IRContentBlock {
  if (img.type === 'base64') {
    return { type: 'image', source: { type: 'base64', media_type: img.mediaType ?? 'image/png', data: img.data } };
  }
  return { type: 'image', source: { type: 'url', url: img.data } };
}

/**
 * Map a legacy BrainRequest into an IRRequest.
 *
 * Folding rules (mirrors ingress-openai discipline):
 * - role:'system' history messages concatenate into ir.system (after the
 *   request-level system prompt), joined with '\n\n'. Never IR messages.
 * - role:'tool' messages fold Anthropic-style: CONSECUTIVE tool messages
 *   become ONE user message of tool_result blocks (toolCallId → tool_use_id).
 * - assistant toolCalls[] → tool_use blocks appended after any text block
 *   (arguments are already parsed objects in legacy history — carried as-is).
 * - messages that yield no blocks (empty content, no tools/images) are dropped.
 */
export function brainRequestToIR(request: ShadowBrainRequest, modelId: string): IRRequest {
  const systemParts: string[] = [];
  if (request.system !== undefined && request.system !== '') systemParts.push(request.system);

  const messages: IRMessage[] = [];
  let pendingToolResults: IRToolResultBlock[] = [];

  const flushToolResults = (): void => {
    if (pendingToolResults.length > 0) {
      messages.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const msg of request.messages) {
    if (msg.role === 'system') {
      flushToolResults();
      if (msg.content !== '') systemParts.push(msg.content);
      continue;
    }

    if (msg.role === 'tool') {
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: msg.toolCallId ?? '',
        content: msg.content ?? '',
      });
      continue;
    }

    flushToolResults();

    if (msg.role === 'user') {
      const blocks: IRContentBlock[] = [];
      if (msg.content !== '') blocks.push({ type: 'text', text: msg.content });
      for (const img of msg.images ?? []) blocks.push(imageToBlock(img));
      if (blocks.length > 0) messages.push({ role: 'user', content: blocks });
      continue;
    }

    // assistant
    const blocks: IRContentBlock[] = [];
    if (msg.content !== '') blocks.push({ type: 'text', text: msg.content });
    for (const tc of msg.toolCalls ?? []) {
      blocks.push({
        type: 'tool_use',
        id: tc.id ?? '',
        name: tc.name ?? '',
        input: isRec(tc.arguments) ? tc.arguments : {},
      });
    }
    if (blocks.length > 0) messages.push({ role: 'assistant', content: blocks });
  }
  flushToolResults();

  const tools: IRTool[] | undefined =
    request.tools && request.tools.length > 0
      ? request.tools.map((t): IRTool => {
          const fn = t.function ?? {};
          const tool: IRTool = { name: fn.name ?? '', input_schema: isRec(fn.parameters) ? fn.parameters : {} };
          if (fn.description !== undefined) tool.description = fn.description;
          return tool;
        })
      : undefined;

  const ir: IRRequest = {
    alias: modelId,
    caller: request.source ?? 'chat',
    purpose: 'shadow',
    messages,
    priority: priorityFor(request.source),
    trace_id: `shadow-${randomUUID()}`,
  };
  if (systemParts.length > 0) ir.system = systemParts.join('\n\n');
  if (tools !== undefined) ir.tools = tools;
  if (request.maxTokens !== undefined) ir.max_tokens = request.maxTokens;
  if (request.temperature !== undefined) ir.temperature = request.temperature;
  if (request.sessionId !== undefined && request.sessionId !== '') {
    ir.extra = { conv_id: request.sessionId };
  }
  return ir;
}

// ---------------------------------------------------------------------------
// resultToIR — legacy ai-SDK result → IRResponse
// ---------------------------------------------------------------------------

/** Legacy finishReason → IR stop_reason. Unknown/null → 'error'. */
export function legacyFinishReasonToIR(reason: string | null | undefined): IRResponse['stop_reason'] {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool-calls':
      return 'tool_use';
    case 'error':
    case 'content-filter':
    default:
      return 'error';
  }
}

function normalizeLegacyToolCall(tc: NonNullable<ShadowLegacyResult['toolCalls']>[number]): IRToolUseBlock {
  const input = tc.arguments ?? tc.args ?? tc.input;
  return {
    type: 'tool_use',
    id: tc.id ?? '',
    name: tc.name ?? tc.toolName ?? '',
    input: isRec(input) ? input : {},
  };
}

function legacyUsageToIR(u: ShadowLegacyResult['usage']): IRUsage {
  if (!u) return { in: 0, out: 0, cached_in: 0 };
  return {
    in: u.promptTokens ?? u.inputTokens ?? 0,
    out: u.completionTokens ?? u.outputTokens ?? 0,
    cached_in: u.cachedInputTokens ?? 0,
  };
}

/** Map the ai-SDK result shape (as brain.ts reads it) into an IRResponse. */
export function resultToIR(result: ShadowLegacyResult, trace_id: string): IRResponse {
  const blocks: IRContentBlock[] = [];
  if (typeof result.text === 'string' && result.text !== '') {
    blocks.push({ type: 'text', text: result.text });
  }
  for (const tc of result.toolCalls ?? []) blocks.push(normalizeLegacyToolCall(tc));
  return {
    blocks,
    stop_reason: legacyFinishReasonToIR(result.finishReason),
    usage: legacyUsageToIR(result.usage),
    trace_id,
  };
}

// ---------------------------------------------------------------------------
// compareShadow — legacy result vs IRResponse
// ---------------------------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    const ba = b as unknown[];
    if ((a as unknown[]).length !== ba.length) return false;
    return (a as unknown[]).every((v, i) => deepEqual(v, ba[i]));
  }
  const ka = Object.keys(a as Rec).filter((k) => (a as Rec)[k] !== undefined).sort();
  const kb = Object.keys(b as Rec).filter((k) => (b as Rec)[k] !== undefined).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => deepEqual((a as Rec)[k], (b as Rec)[k]));
}

function irText(ir: IRResponse): string {
  return ir.blocks.filter((b): b is Extract<IRContentBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('');
}

/** Relative difference; both-zero → 0; one-zero → 1 (100%). */
function relDiff(a: number, b: number): number {
  if (a === b) return 0;
  const base = Math.max(Math.abs(a), Math.abs(b));
  return base === 0 ? 0 : Math.abs(a - b) / base;
}

/**
 * Compare a legacy result against its IR mapping.
 * Material: stop-reason CLASS mismatch, text mismatch (exact, but
 * whitespace-only differences are non-material), tool-call name/args
 * object-level mismatch, token counts differing >10%.
 * Non-material: whitespace-only text drift, usage within ±10%.
 * Skipped when the legacy side lacks the field (undefined).
 */
export function compareShadow(legacy: ShadowLegacyResult, ir: IRResponse): ShadowDiff {
  const fields: string[] = [];
  const nonMaterial: string[] = [];

  // stop_reason class
  if (legacy.finishReason !== undefined && legacy.finishReason !== null) {
    if (legacyFinishReasonToIR(legacy.finishReason) !== ir.stop_reason) fields.push('stop_reason');
  }

  // text (exact; whitespace-only → non-material)
  if (legacy.text !== undefined) {
    const irT = irText(ir);
    if (legacy.text !== irT) {
      if (legacy.text.replace(/\s+/g, '') === irT.replace(/\s+/g, '')) nonMaterial.push('text');
      else fields.push('text');
    }
  }

  // tool calls (name + args, object-level)
  if (legacy.toolCalls !== undefined) {
    const legacyTUs = legacy.toolCalls.map(normalizeLegacyToolCall);
    const irTUs = ir.blocks.filter((b): b is IRToolUseBlock => b.type === 'tool_use');
    const match =
      legacyTUs.length === irTUs.length &&
      legacyTUs.every((l, i) => l.name === irTUs[i]!.name && deepEqual(l.input, irTUs[i]!.input));
    if (!match) fields.push('tool_calls');
  }

  // usage (±10% tolerance)
  if (legacy.usage !== undefined) {
    const lu = legacyUsageToIR(legacy.usage);
    const dIn = relDiff(lu.in, ir.usage.in);
    const dOut = relDiff(lu.out, ir.usage.out);
    if (dIn > 0.1 || dOut > 0.1) fields.push('usage');
    else if (dIn > 0 || dOut > 0) nonMaterial.push('usage');
  }

  const diff: ShadowDiff = { material: fields.length > 0, fields };
  if (nonMaterial.length > 0) diff.nonMaterial = nonMaterial;
  return diff;
}

// ---------------------------------------------------------------------------
// requestShadowDiff — legacy request vs its adapter-egressed wire body
// ---------------------------------------------------------------------------

export type WireFamily = 'anthropic' | 'openai';

export function wireFamilyFor(modelId: string): WireFamily {
  return isAnthropicModelId(modelId) ? 'anthropic' : 'openai';
}

/** Expected semantic content computed DIRECTLY from the legacy request (not via the IR). */
interface ExpectedSemantics {
  /** Wire message count after folding rules, per family. */
  messageCount: number;
  system: string;
  userText: string;
  assistantText: string;
  toolResultsText: string;
  /** name → JSON schema. */
  tools: Map<string, Rec>;
}

function expectedSemantics(request: ShadowBrainRequest, family: WireFamily): ExpectedSemantics {
  const systemParts: string[] = [];
  if (request.system !== undefined && request.system !== '') systemParts.push(request.system);

  let count = 0;
  let userText = '';
  let assistantText = '';
  let toolResultsText = '';
  let inToolRun = false;

  for (const msg of request.messages) {
    if (msg.role === 'system') {
      inToolRun = false;
      if (msg.content !== '') systemParts.push(msg.content);
      continue;
    }
    if (msg.role === 'tool') {
      toolResultsText += msg.content ?? '';
      if (family === 'openai') {
        count += 1; // each tool message is its own role:'tool' wire message
      } else if (!inToolRun) {
        count += 1; // consecutive run folds into ONE user message
      }
      inToolRun = true;
      continue;
    }
    inToolRun = false;
    if (msg.role === 'user') {
      const hasContent = msg.content !== '' || (msg.images?.length ?? 0) > 0;
      if (hasContent) count += 1;
      userText += msg.content;
      continue;
    }
    // assistant
    const hasContent = msg.content !== '' || (msg.toolCalls?.length ?? 0) > 0;
    if (hasContent) count += 1;
    assistantText += msg.content;
  }

  const system = systemParts.join('\n\n');
  if (family === 'openai' && system !== '') count += 1; // system rides as messages[0]

  const tools = new Map<string, Rec>();
  for (const t of request.tools ?? []) {
    const fn = t.function ?? {};
    tools.set(fn.name ?? '', isRec(fn.parameters) ? fn.parameters : {});
  }

  return { messageCount: count, system, userText, assistantText, toolResultsText, tools };
}

/** Strip cache_control decorations before schema comparison. */
function withoutCacheControl(obj: Rec): Rec {
  const { cache_control: _cc, ...rest } = obj;
  return rest;
}

/** Semantic content actually present in a wire body, per family. */
function wireSemantics(body: Rec, family: WireFamily): ExpectedSemantics {
  let system = '';
  let userText = '';
  let assistantText = '';
  let toolResultsText = '';
  let count = 0;
  const tools = new Map<string, Rec>();

  const messages = Array.isArray(body['messages']) ? body['messages'] : [];

  const partText = (content: unknown): string => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .map((p) => (isRec(p) && (p['type'] === 'text' || p['type'] === undefined) && typeof p['text'] === 'string' ? p['text'] : ''))
      .join('');
  };

  if (family === 'openai') {
    for (const raw of messages) {
      if (!isRec(raw)) continue;
      count += 1;
      const role = raw['role'];
      if (role === 'system') system += partText(raw['content']);
      else if (role === 'user') userText += partText(raw['content']);
      else if (role === 'assistant') assistantText += typeof raw['content'] === 'string' ? raw['content'] : partText(raw['content']);
      else if (role === 'tool') {
        let t = typeof raw['content'] === 'string' ? raw['content'] : partText(raw['content']);
        if (t.startsWith('[tool error] ')) t = t.slice('[tool error] '.length);
        toolResultsText += t;
      }
    }
    const rawTools = Array.isArray(body['tools']) ? body['tools'] : [];
    for (const t of rawTools) {
      if (!isRec(t) || !isRec(t['function'])) continue;
      const fn = t['function'];
      tools.set(typeof fn['name'] === 'string' ? fn['name'] : '', isRec(fn['parameters']) ? fn['parameters'] : {});
    }
  } else {
    // anthropic: top-level system as block array or string
    const sys = body['system'];
    if (typeof sys === 'string') system = sys;
    else if (Array.isArray(sys)) system = sys.map((b) => (isRec(b) && typeof b['text'] === 'string' ? b['text'] : '')).join('');

    for (const raw of messages) {
      if (!isRec(raw)) continue;
      count += 1;
      const role = raw['role'];
      const content = Array.isArray(raw['content']) ? raw['content'] : [];
      for (const b of content) {
        if (!isRec(b)) continue;
        if (b['type'] === 'text' && typeof b['text'] === 'string') {
          if (role === 'user') userText += b['text'];
          else if (role === 'assistant') assistantText += b['text'];
        } else if (b['type'] === 'tool_result') {
          toolResultsText += typeof b['content'] === 'string' ? b['content'] : partText(b['content']);
        }
      }
    }
    const rawTools = Array.isArray(body['tools']) ? body['tools'] : [];
    for (const t of rawTools) {
      if (!isRec(t)) continue;
      const name = typeof t['name'] === 'string' ? t['name'] : '';
      if (name === STRUCTURED_OUTPUT_TOOL) continue; // synthetic forced-output tool
      tools.set(name, isRec(t['input_schema']) ? withoutCacheControl(t['input_schema'] as Rec) : {});
    }
  }

  return { messageCount: count, system, userText, assistantText, toolResultsText, tools };
}

/**
 * Compare a wire body against the legacy request's semantic content.
 * Exported for tests (feed a deliberately mangled body → must flag material).
 */
export function compareWireAgainstLegacy(request: ShadowBrainRequest, body: Rec, family: WireFamily): ShadowDiff {
  const expected = expectedSemantics(request, family);
  const actual = wireSemantics(body, family);
  const fields: string[] = [];

  if (expected.messageCount !== actual.messageCount) fields.push('message_count');
  if (expected.system !== actual.system) fields.push('system_text');
  if (expected.userText !== actual.userText) fields.push('user_text');
  if (expected.assistantText !== actual.assistantText) fields.push('assistant_text');
  if (expected.toolResultsText !== actual.toolResultsText) fields.push('tool_results_text');

  // tools: names + schemas (object-level)
  if (expected.tools.size !== actual.tools.size) {
    fields.push('tools');
  } else {
    for (const [name, schema] of expected.tools) {
      const got = actual.tools.get(name);
      if (got === undefined || !deepEqual(schema, got)) {
        fields.push('tools');
        break;
      }
    }
  }

  // max_tokens / temperature carried (only when the legacy request set them)
  if (request.maxTokens !== undefined && body['max_tokens'] !== request.maxTokens) {
    fields.push('max_tokens');
  }
  if (request.temperature !== undefined) {
    // egress-anthropic clamps to Anthropic's 0..1 range — expected behavior.
    const want = family === 'anthropic' ? Math.min(1, Math.max(0, request.temperature)) : request.temperature;
    if (body['temperature'] !== want) fields.push('temperature');
  }

  return { material: fields.length > 0, fields };
}

/**
 * Build IR from the legacy request, egress through the matching adapter, and
 * compare the resulting wire body's SEMANTIC content against the legacy
 * inputs. Material = any dropped/mangled content.
 */
export function requestShadowDiff(request: ShadowBrainRequest, modelId: string): ShadowDiff {
  const family = wireFamilyFor(modelId);
  const ir = brainRequestToIR(request, modelId);
  const body = family === 'anthropic' ? egressAnthropic(ir) : egressOpenAI(ir);
  return compareWireAgainstLegacy(request, body, family);
}

// ---------------------------------------------------------------------------
// runShadow — live fire-and-forget hook (LLM_SHADOW=1)
// ---------------------------------------------------------------------------

function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

export function isShadowEnabled(): boolean {
  return process.env['LLM_SHADOW'] === '1';
}

/**
 * Fire-and-forget shadow comparison for one live legacy Brain call.
 * Default OFF (LLM_SHADOW unset) — zero behavior or cost change. Fail-open:
 * everything inside the microtask is try/caught; a shadow bug can never break
 * a call. Rows are TINY: diverging field names + short hashes, never content.
 */
export function runShadow(request: ShadowBrainRequest, modelId: string, result: ShadowLegacyResult): void {
  if (!isShadowEnabled()) return;
  // Same no-test-DB-pollution idiom as brain._recordGatewayCall.
  if (process.env['VITEST'] && process.env['SUDO_GATEWAY_LOG_TEST'] !== '1') return;
  queueMicrotask(() => {
    try {
      const traceId = `shadow-${randomUUID()}`;
      const reqDiff = requestShadowDiff(request, modelId);
      const respDiff = compareShadow(result, resultToIR(result, traceId));
      const material = reqDiff.material || respDiff.material;
      getGatewayCallLog().record({
        traceId,
        caller: 'shadow',
        purpose: 'live-shadow',
        alias: modelId,
        irRequest: {
          shadow: true,
          family: wireFamilyFor(modelId),
          request_fields: reqDiff.fields,
          response_fields: respDiff.fields,
          ...(respDiff.nonMaterial ? { response_non_material: respDiff.nonMaterial } : {}),
          message_count: request.messages.length,
          text_sha256: typeof result.text === 'string' ? shortHash(result.text) : null,
          system_sha256: typeof request.system === 'string' ? shortHash(request.system) : null,
        },
        outcome: material ? 'shadow_divergent' : 'shadow_match',
      });
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'runShadow failed (fail-open)');
    }
  });
}
