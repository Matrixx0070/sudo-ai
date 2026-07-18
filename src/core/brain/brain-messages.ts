/**
 * Message format conversion + system-message folding for Brain.
 * Extracted verbatim from brain.ts (F103 mechanical slimming); zero behavior change.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../shared/logger.js';
import type { BrainMessage } from './types.js';

const log = createLogger('brain');

// ---------------------------------------------------------------------------
// Message format conversion: internal BrainMessage -> Vercel AI SDK ModelMessage
// ---------------------------------------------------------------------------

/**
 * Convert our internal BrainMessage[] to the format that Vercel AI SDK's
 * generateText/streamText expects (ModelMessage[]).
 *
 * Key differences:
 * - Assistant messages with tool calls use content array with ToolCallPart objects
 * - Tool result messages use content array with ToolResultPart objects
 */
/**
 * Opt-in (SUDO_FOLD_SYSTEM_MESSAGES=1). `toSDKMessages` drops every role:'system'
 * message from request.messages (the SDK requires system content via the `system`
 * param, not the array). That silently discards ALL in-loop guidance injected as
 * system messages — auto-plan PLAN, compaction/session-fork summaries, safety
 * warnings, routing hints, etc. — so the model never sees them. When this flag is
 * on, their content is FOLDED into the `system` param instead, so it actually
 * reaches the model. Default OFF: flipping it delivers many previously-inert
 * injections at once — a real behavior + token change — so measure before enabling.
 */
export function readFoldSystemEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SUDO_FOLD_SYSTEM_MESSAGES'] === '1';
}

/** Concatenate non-empty role:'system' message contents, in order (for folding). */
export function extractSystemMessageContent(messages: BrainMessage[]): string {
  return messages
    .filter((m) => m.role === 'system' && typeof m.content === 'string' && m.content.trim().length > 0)
    .map((m) => m.content)
    .join('\n\n');
}

/**
 * The effective system prompt: the base persona `systemPrompt` with any
 * request-array system messages appended, when folding is enabled. Pure +
 * exported for tests. Disabled or no system messages → returns `systemPrompt`
 * unchanged (byte-identical to prior behavior). NOTE: when folding AND Anthropic
 * prompt-caching are both on, the per-turn folded suffix reduces cache hits on
 * the system prefix — acceptable for this opt-in flag; prod (ollama) is uncached.
 */
export function buildEffectiveSystemPrompt(
  systemPrompt: string,
  messages: BrainMessage[],
  enabled: boolean = readFoldSystemEnabled(),
): string {
  if (!enabled) return systemPrompt;
  const folded = extractSystemMessageContent(messages);
  return folded.length > 0 ? `${systemPrompt}\n\n${folded}` : systemPrompt;
}

/**
 * Cache-safe fold for the Anthropic prompt-cache path: returns the folded
 * content as a SEPARATE, uncached leading system message (no cache_control) to
 * sit AFTER `buildCachedSystemMessages(systemPrompt)`. This keeps the cached
 * persona prefix byte-identical turn to turn (cache hits preserved); the
 * per-turn folded content is simply uncached input — which it must be, since
 * new dynamic content can never be cached. Empty / disabled → [] (no-op).
 */
export function buildFoldedSystemMessages(
  messages: BrainMessage[],
  enabled: boolean = readFoldSystemEnabled(),
): Array<{ role: 'system'; content: string }> {
  if (!enabled) return [];
  const folded = extractSystemMessageContent(messages);
  return folded.length > 0 ? [{ role: 'system', content: folded }] : [];
}

export function toSDKMessages(messages: BrainMessage[]): unknown[] {
  return messages
    .filter((msg) => {
      // System messages are handled via the 'system' param of generateText.
      // Including them in the messages array causes SDK schema validation errors.
      if (msg.role === 'system') {
        // Expected + handled, not an error: system content belongs in the
        // `system` param, and with SUDO_FOLD_SYSTEM_MESSAGES=1 it's folded in
        // (no loss). Routine → debug. (Was 90+/run of WARN noise for a by-design
        // drop — the single highest-frequency warning in the daemon logs.)
        log.debug(
          { contentPreview: String(msg.content ?? '').slice(0, 80) },
          'system-role message routed out of request.messages array (handled via system prompt / folding)',
        );
        return false;
      }
      return true;
    })
    .map((msg) => {
      // Assistant message with tool calls: convert to content array format.
      // The SDK expects ToolCallPart objects in the content array.
      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        const contentParts: unknown[] = [];
        if (msg.content) {
          contentParts.push({ type: 'text', text: msg.content });
        }
        for (const tc of msg.toolCalls) {
          contentParts.push({
            type: 'tool-call',
            toolCallId: tc.id,
            toolName: tc.name,
            // Ensure input is always an object, never null/undefined.
            input: tc.arguments ?? {},
          });
        }
        return { role: 'assistant', content: contentParts };
      }

      // Tool result message: ALWAYS convert to content array with tool-result parts.
      // The SDK v6 requires role='tool', content = array of ToolResultPart.
      // Never let a tool message fall through to plain string content — SDK rejects it.
      if (msg.role === 'tool') {
        let callId = msg.toolCallId;
        if (!callId) {
          // A missing toolCallId from upstream is a bug worth surfacing. Use a
          // collision-free UUID (Date.now() collides for two tool messages in
          // the same ms, cross-wiring tool results back to the wrong call).
          callId = `fallback_${randomUUID()}`;
          log.warn({ toolName: msg.toolName }, 'tool message missing toolCallId — synthesised fallback id');
        }
        return {
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolCallId: callId,
            toolName: msg.toolName ?? '',
            output: { type: 'text', value: typeof msg.content === 'string' ? msg.content : String(msg.content ?? '') },
          }],
        };
      }

      // User message with image attachments: convert to multi-part content so
      // vision-capable models actually receive the pixels. Without this the
      // images field was silently dropped and the model saw text only — the
      // vision-via-Brain path answered "no image attached" on every real call.
      if (msg.role === 'user' && msg.images && msg.images.length > 0) {
        const parts: unknown[] = [];
        const text = typeof msg.content === 'string' ? msg.content : String(msg.content ?? '');
        if (text) parts.push({ type: 'text', text });
        for (const img of msg.images) {
          parts.push({
            type: 'image',
            image: img.type === 'url' ? new URL(img.data) : img.data,
            ...(img.mediaType ? { mediaType: img.mediaType } : {}),
          });
        }
        return { role: 'user', content: parts };
      }

      // Plain assistant and user messages pass through as-is.
      return { role: msg.role, content: msg.content ?? '' };
    });
}
