/**
 * @file egress-anthropic.ts
 * @description IR → Anthropic Messages API request body, plus the matching
 * response parser (gw-refactor Phase 3). The IR is Anthropic-shaped, so
 * content blocks map 1:1; the work here is cache discipline, limits, and
 * forced structured output.
 *
 * Shape rules:
 * - system is TOP-LEVEL, as a content-block array so cache_control can attach.
 *   If ir.system contains the DYNAMIC_BOUNDARY_MARKER (prompt-cache-discipline)
 *   the static prefix gets cache_control:{type:'ephemeral'}; else one uncached
 *   block.
 * - max_tokens is ALWAYS set: ir.max_tokens ?? getAliasLimits(alias).max_output.
 * - temperature clamped to Anthropic's 0..1 range.
 * - tools get cache_control on the LAST entry (caches the whole tools array).
 * - response_schema → forced tool use: synthetic 'structured_output' tool whose
 *   input_schema IS the response schema + tool_choice {type:'tool', ...}.
 */

import type {
  IRRequest,
  IRResponse,
  IRContentBlock,
  IRImageBlock,
  IRUsage,
} from '../../../shared-types/ir/v1.js';
import { resolveAlias } from '../aliases.js';
import { getAliasLimits } from '../limits.js';
import { DYNAMIC_BOUNDARY_MARKER } from '../../core/brain/prompt-cache-discipline.js';
import { parseToolArguments } from './tool-args.js';

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Synthetic tool name used to force structured JSON output. */
export const STRUCTURED_OUTPUT_TOOL = 'structured_output';

// ---------------------------------------------------------------------------
// Stop-reason maps (wire ↔ IR)
// ---------------------------------------------------------------------------

/** Anthropic stop_reason → IR stop_reason. Unknown/refusal-ish → 'error'. */
export function anthropicStopReasonToIR(reason: unknown): IRResponse['stop_reason'] {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    default:
      // refusal / content-filter-ish / anything unknown.
      return 'error';
  }
}

/** Reverse map for future egress of IRResponses over the Anthropic wire. */
export function irStopReasonToAnthropic(reason: IRResponse['stop_reason']): string {
  switch (reason) {
    case 'end_turn':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'error':
      return 'refusal';
  }
}

// ---------------------------------------------------------------------------
// Request egress
// ---------------------------------------------------------------------------

/** Strip the provider prefix — the Anthropic API wants the bare model id. */
function bareModelId(resolved: string): string {
  return resolved.replace(/^(anthropic|claude-oauth)\//, '');
}

/**
 * Cache breakpoint marker for every cache_control site in this adapter.
 * SUDO_ANTHROPIC_CACHE_TTL=1h opts into Anthropic's extended-TTL cache
 * (write 2x vs 1.25x, read 0.1x either way) — pays off when call gaps
 * cluster in the 5m–60m band. All three breakpoints must share one TTL:
 * Anthropic requires longer-TTL breakpoints to precede shorter ones, and a
 * uniform value sidesteps the ordering rule entirely. Any value other than
 * '1h' (or unset) = today's 5-minute default.
 */
function cacheControl(): Rec {
  return process.env['SUDO_ANTHROPIC_CACHE_TTL'] === '1h'
    ? { type: 'ephemeral', ttl: '1h' }
    : { type: 'ephemeral' };
}

/**
 * Split ir.system at the dynamic boundary: static prefix carries the
 * cache_control breakpoint, the dynamic remainder is uncached. No boundary
 * (or nothing above it) → single uncached block.
 */
function systemBlocks(system: string): Rec[] {
  const idx = system.indexOf(DYNAMIC_BOUNDARY_MARKER);
  if (idx <= 0) return [{ type: 'text', text: system }];
  return [
    { type: 'text', text: system.slice(0, idx), cache_control: cacheControl() },
    { type: 'text', text: system.slice(idx) },
  ];
}

/**
 * Rolling conversation-history cache (L1, gw-cache #1). Mark the LAST content
 * block of the LAST message with a cache_control breakpoint so the whole prompt
 * prefix (tools → system → history) becomes a cache READ on the next turn — the
 * standard Anthropic multi-turn pattern. Previously ONLY system + tools were
 * cached; message history was re-sent uncached every turn (the dominant input
 * cost on long agent loops).
 *
 * Guards:
 *  - Only with prior history to reuse (≥2 messages) — the first user turn has
 *    nothing to read back and would only pay cache-creation.
 *  - Skip a trailing `thinking` block (assistant reasoning; not a cache anchor).
 *  - Anthropic silently no-ops the breakpoint when the cumulative prefix is
 *    below the min cacheable length, so this never errors on short prompts.
 *  - Kill switch: SUDO_PROMPT_CACHE_HISTORY=0.
 * Mutates the passed array in place (already a fresh per-call mapping).
 */
function markHistoryForCache(messages: Array<{ role: string; content: Rec[] }>): void {
  if (process.env['SUDO_PROMPT_CACHE_HISTORY'] === '0') return;
  if (messages.length < 2) return;
  const last = messages[messages.length - 1];
  if (!last || !Array.isArray(last.content) || last.content.length === 0) return;
  const i = last.content.length - 1;
  const block = last.content[i]!;
  if (block['type'] === 'thinking') return;
  last.content[i] = { ...block, cache_control: cacheControl() };
}

function imageBlockOut(block: IRImageBlock): Rec {
  const src = block.source;
  if (src.type === 'base64') {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: src.media_type ?? 'image/png',
        data: src.data ?? '',
      },
    };
  }
  return { type: 'image', source: { type: 'url', url: src.url ?? '' } };
}

function blockOut(block: IRContentBlock): Rec {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result': {
      const out: Rec = {
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content:
          typeof block.content === 'string'
            ? block.content
            : block.content.map((c) => (c.type === 'text' ? { type: 'text', text: c.text } : imageBlockOut(c))),
      };
      if (block.is_error !== undefined) out['is_error'] = block.is_error;
      return out;
    }
    case 'image':
      return imageBlockOut(block);
    case 'thinking': {
      // Passthrough (A15): thinking blocks in request history go back to the
      // Anthropic wire verbatim — signature included, or the API rejects the
      // replayed block on multi-turn tool use.
      const out: Rec = { type: 'thinking', thinking: block.thinking };
      if (block.signature !== undefined) out['signature'] = block.signature;
      return out;
    }
  }
}

/** IRRequest → Anthropic Messages API request body. max_tokens ALWAYS set. */
export function egressAnthropic(ir: IRRequest): Rec {
  const messages = ir.messages.map((m) => ({ role: m.role, content: m.content.map(blockOut) }));
  markHistoryForCache(messages);
  const body: Rec = {
    model: bareModelId(resolveAlias(ir.alias)),
    max_tokens: ir.max_tokens ?? getAliasLimits(ir.alias).max_output,
    messages,
  };

  if (ir.system !== undefined && ir.system !== '') {
    body['system'] = systemBlocks(ir.system);
  }

  if (ir.temperature !== undefined) {
    body['temperature'] = Math.min(1, Math.max(0, ir.temperature));
  }

  const tools: Rec[] = (ir.tools ?? []).map((t) => ({
    name: t.name,
    ...(t.description !== undefined ? { description: t.description } : {}),
    input_schema: t.input_schema,
  }));

  if (ir.response_schema !== undefined) {
    // Forced structured output: synthetic tool + forced tool_choice.
    tools.push({
      name: STRUCTURED_OUTPUT_TOOL,
      description: 'Emit the final answer as structured output matching the schema.',
      input_schema: ir.response_schema,
    });
    body['tool_choice'] = { type: 'tool', name: STRUCTURED_OUTPUT_TOOL };
  }

  if (tools.length > 0) {
    // cache_control on the LAST tool caches the whole tools array
    // (same discipline as markLastToolForCache in prompt-cache-discipline).
    const last = tools[tools.length - 1]!;
    tools[tools.length - 1] = { ...last, cache_control: cacheControl() };
    body['tools'] = tools;
  }

  return body;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function parseUsage(u: unknown): IRUsage {
  if (!isRec(u)) return { in: 0, out: 0, cached_in: 0 };
  const input = typeof u['input_tokens'] === 'number' ? u['input_tokens'] : 0;
  const cacheRead =
    typeof u['cache_read_input_tokens'] === 'number' ? u['cache_read_input_tokens'] : 0;
  const cacheCreation =
    typeof u['cache_creation_input_tokens'] === 'number' ? u['cache_creation_input_tokens'] : 0;
  // IRUsage invariant: `in` = TOTAL input incl. cached (matches ai-SDK/OpenAI
  // semantics). Anthropic's input_tokens EXCLUDES cache reads/writes, so sum
  // them here; cached_in/cache_creation_in stay the discountable subsets.
  const usage: IRUsage = {
    in: input + cacheRead + cacheCreation,
    out: typeof u['output_tokens'] === 'number' ? u['output_tokens'] : 0,
    cached_in: cacheRead,
  };
  if (typeof u['cache_creation_input_tokens'] === 'number') {
    usage.cache_creation_in = cacheCreation;
  }
  return usage;
}

/**
 * Anthropic Messages API response JSON → IRResponse. Content blocks map 1:1
 * (tool_use input is already an object on this wire — but we defensively
 * re-normalize strings through parseToolArguments). 200-but-empty content →
 * stop_reason 'error' + extra.provider_bug=true. Never throws.
 */
export function parseAnthropicResponse(json: unknown, trace_id: string): IRResponse {
  const j: Rec = isRec(json) ? json : {};
  const usage = parseUsage(j['usage']);
  const content = Array.isArray(j['content']) ? j['content'] : [];

  const blocks: IRContentBlock[] = [];
  const parseErrors: Record<string, string> = {};

  for (const raw of content) {
    if (!isRec(raw)) continue;
    if (raw['type'] === 'text' && typeof raw['text'] === 'string') {
      if (raw['text'] !== '') blocks.push({ type: 'text', text: raw['text'] });
    } else if (raw['type'] === 'tool_use') {
      const id = typeof raw['id'] === 'string' ? raw['id'] : '';
      let input: Record<string, unknown>;
      if (isRec(raw['input'])) {
        input = raw['input'];
      } else if (typeof raw['input'] === 'string') {
        const parsed = parseToolArguments(raw['input']);
        input = parsed.input;
        if (parsed.error !== undefined) parseErrors[id] = parsed.error;
      } else {
        input = {};
      }
      blocks.push({
        type: 'tool_use',
        id,
        name: typeof raw['name'] === 'string' ? raw['name'] : '',
        input,
      });
    } else if (raw['type'] === 'thinking' && typeof raw['thinking'] === 'string') {
      // A15: thinking blocks are mapped into the IR (previously dropped) so
      // opus/fable extended thinking is never silently lost.
      const tb: IRContentBlock = { type: 'thinking', thinking: raw['thinking'] };
      if (typeof raw['signature'] === 'string') tb.signature = raw['signature'];
      blocks.push(tb);
    }
    // redacted_thinking and unknown block types are dropped from the typed
    // surface (vendor-specific; nothing downstream consumes them yet).
  }

  const extra: Record<string, unknown> = {};
  if (Object.keys(parseErrors).length > 0) extra['parse_error'] = parseErrors;

  let stopReason: IRResponse['stop_reason'];
  if (blocks.length === 0) {
    stopReason = 'error';
    extra['provider_bug'] = true;
  } else {
    stopReason = anthropicStopReasonToIR(j['stop_reason']);
    if (j['stop_reason'] === 'stop_sequence') {
      extra['stop_sequence'] = typeof j['stop_sequence'] === 'string' ? j['stop_sequence'] : null;
    }
    if (stopReason === 'error') {
      extra['reason'] = typeof j['stop_reason'] === 'string' ? j['stop_reason'] : 'unknown';
    }
  }

  const res: IRResponse = { blocks, stop_reason: stopReason, usage, trace_id };
  if (Object.keys(extra).length > 0) res.extra = extra;
  return res;
}
