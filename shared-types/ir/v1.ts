/**
 * @file shared-types/ir/v1.ts
 * @description Internal LLM IR, version 1 — the Anthropic-shaped intermediate
 * representation every in-process LLM call is expressed in before it hits the
 * gateway/provider layer (gw-refactor Phase 2).
 *
 * Rules:
 * - Anthropic content-block shape (`text` / `tool_use` / `tool_result` /
 *   `image`), because it is the strictest superset we translate FROM.
 * - `tool_use.input` is a REAL object, never a JSON string. Providers that
 *   hand back stringified arguments must be normalized before entering the IR.
 * - Vendor-specific extras live ONLY in `extra` (request and response). No
 *   provider field ever leaks into the typed surface.
 * - Dependency-light on purpose: zod and nothing else.
 */

import { z } from 'zod';

/** Bump when the wire shape changes incompatibly. */
export const IR_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

export const IRTextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});
export type IRTextBlock = z.infer<typeof IRTextBlockSchema>;

export const IRToolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  /** Always a real object — never a stringified JSON blob. */
  input: z.record(z.string(), z.unknown()),
});
export type IRToolUseBlock = z.infer<typeof IRToolUseBlockSchema>;

/**
 * Extended-thinking block (gw-cutover Phase 0, A15 debt). Anthropic-only on
 * the wire today: parseAnthropicResponse maps `thinking` blocks into this and
 * egressAnthropic passes them back through verbatim (signature included, so
 * multi-turn tool use with thinking survives). The OpenAI egress SKIPS them —
 * that wire has no equivalent block and the text channel must not leak
 * reasoning. ADDITIVE to the v1 union: absent blocks parse exactly as before.
 */
export const IRThinkingBlockSchema = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
  /** Anthropic's integrity signature — must round-trip for passthrough. */
  signature: z.string().optional(),
});
export type IRThinkingBlock = z.infer<typeof IRThinkingBlockSchema>;

export const IRImageSourceSchema = z.object({
  type: z.enum(['base64', 'url']),
  media_type: z.string().optional(),
  data: z.string().optional(),
  url: z.string().optional(),
});
export type IRImageSource = z.infer<typeof IRImageSourceSchema>;

export const IRImageBlockSchema = z.object({
  type: z.literal('image'),
  source: IRImageSourceSchema,
});
export type IRImageBlock = z.infer<typeof IRImageBlockSchema>;

/** Blocks permitted inside a tool_result's array-form content. */
export const IRToolResultContentBlockSchema = z.discriminatedUnion('type', [
  IRTextBlockSchema,
  IRImageBlockSchema,
]);
export type IRToolResultContentBlock = z.infer<typeof IRToolResultContentBlockSchema>;

export const IRToolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(IRToolResultContentBlockSchema)]),
  is_error: z.boolean().optional(),
});
export type IRToolResultBlock = z.infer<typeof IRToolResultBlockSchema>;

export const IRContentBlockSchema = z.discriminatedUnion('type', [
  IRTextBlockSchema,
  IRToolUseBlockSchema,
  IRToolResultBlockSchema,
  IRImageBlockSchema,
  IRThinkingBlockSchema,
]);
export type IRContentBlock = z.infer<typeof IRContentBlockSchema>;

// ---------------------------------------------------------------------------
// Messages / tools
// ---------------------------------------------------------------------------

export const IRMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.array(IRContentBlockSchema),
});
export type IRMessage = z.infer<typeof IRMessageSchema>;

export const IRToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  input_schema: z.record(z.string(), z.unknown()),
});
export type IRTool = z.infer<typeof IRToolSchema>;

// ---------------------------------------------------------------------------
// Request / response envelopes
// ---------------------------------------------------------------------------

export const IRRequestSchema = z.object({
  /** Capability alias (sudo/cheap, sudo/frontier, …) or concrete model id. */
  alias: z.string(),
  /** Which subsystem is calling (agent-loop, swarm:<role>, cron:<job>, …). */
  caller: z.string(),
  /** Short free-text purpose for telemetry. */
  purpose: z.string(),
  system: z.string().optional(),
  messages: z.array(IRMessageSchema),
  tools: z.array(IRToolSchema).optional(),
  /** JSON schema when the caller demands forced-JSON output. */
  response_schema: z.record(z.string(), z.unknown()).optional(),
  priority: z.enum(['user', 'background']),
  trace_id: z.string(),
  max_tokens: z.number().optional(),
  temperature: z.number().optional(),
  /** Vendor extras live ONLY here — never as top-level fields. */
  extra: z.record(z.string(), z.unknown()).optional(),
});
export type IRRequest = z.infer<typeof IRRequestSchema>;

/**
 * INVARIANT: `in` = TOTAL input tokens INCLUDING cached ones (cache reads AND
 * cache-creation writes) — matches ai-SDK/OpenAI semantics, where
 * prompt_tokens already covers cached input. `cached_in` (cache reads) and
 * `cache_creation_in` (cache writes, Anthropic only) are SUBSETS of `in` used
 * for cost discounting — never add them on top of `in`.
 */
export const IRUsageSchema = z.object({
  in: z.number(),
  out: z.number(),
  cached_in: z.number(),
  /** Anthropic cache_creation_input_tokens (subset of `in`; absent elsewhere). */
  cache_creation_in: z.number().optional(),
});
export type IRUsage = z.infer<typeof IRUsageSchema>;

export const IRResponseSchema = z.object({
  blocks: z.array(IRContentBlockSchema),
  stop_reason: z.enum(['end_turn', 'tool_use', 'max_tokens', 'error']),
  usage: IRUsageSchema,
  cost_usd: z.number().optional(),
  trace_id: z.string(),
  extra: z.record(z.string(), z.unknown()).optional(),
});
export type IRResponse = z.infer<typeof IRResponseSchema>;

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

/** Strict parse — throws ZodError on invalid input. */
export function parseIRRequest(u: unknown): IRRequest {
  return IRRequestSchema.parse(u);
}

/** Strict parse — throws ZodError on invalid input. */
export function parseIRResponse(u: unknown): IRResponse {
  return IRResponseSchema.parse(u);
}

/** Non-throwing variant: `{ success: true, data } | { success: false, error }`. */
export function safeParseIRRequest(u: unknown): z.ZodSafeParseResult<IRRequest> {
  return IRRequestSchema.safeParse(u);
}

/** Non-throwing variant: `{ success: true, data } | { success: false, error }`. */
export function safeParseIRResponse(u: unknown): z.ZodSafeParseResult<IRResponse> {
  return IRResponseSchema.safeParse(u);
}
