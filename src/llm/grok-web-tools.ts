/**
 * @file grok-web-tools.ts
 * @description Prompt-emulated tool-calling layer for the FREE grok.com web
 * (app-chat) lane — the door the mobile/desktop/web apps use, billed against
 * the SuperGrok *weekly pool* (not cli-chat-proxy's daily free bucket, not the
 * metered API). The app-chat lane (`op_chat`) is a plain text lane with no
 * native OpenAI-style `tools` parameter, so we give grok its tools in the
 * system prompt and parse a structured tool call back out of the reply.
 *
 * WHY prompt-emulation and not native function-calling:
 *  - The consumer app-chat persona has no `tools` field; its only native
 *    tool surface is MCP connectors (grok-web MCP path — separate, later slice).
 *  - Prompt-emulation is model-agnostic and improves for free as the model
 *    gets better at instruction-following (bitter lesson): no per-provider
 *    tool-schema translation, no connector registration on the hot path.
 *
 * This module is PURE (no I/O): it renders an IR request into one app-chat
 * message and parses the reply. The multi-turn execute-and-feed-back loop and
 * the transport wiring live in the caller (next slice). Keeping the render +
 * parse pure makes the contract exhaustively unit-testable without a live seat.
 *
 * Wire format grok is asked to emit (one call at a time):
 *
 *     <tool_call>
 *     {"name": "<tool>", "arguments": { ... }}
 *     </tool_call>
 *
 * A reply with no `<tool_call>` block is a final answer (returned as text).
 */

import { randomUUID } from 'node:crypto';
import type { IRMessage, IRTool } from '../../shared-types/ir/v1.js';

// ---------------------------------------------------------------------------
// Parse result
// ---------------------------------------------------------------------------

/** grok asked to invoke a tool. `input` is always a real object. */
export interface GrokToolUse {
  kind: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** grok produced a final answer (no tool call). */
export interface GrokFinalText {
  kind: 'text';
  text: string;
}

export type ParsedGrokReply = GrokToolUse | GrokFinalText;

/** Injectable id minter (real: randomUUID; tests: deterministic). */
export type IdFn = () => string;

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const TOOL_OPEN = '<tool_call>';
const TOOL_CLOSE = '</tool_call>';

/**
 * Render the tool roster + calling contract as a system-prompt fragment. The
 * caller prepends/embeds this (op_chat carries a real `systemPromptName`-style
 * instruction via the leading message; here we return plain text the caller
 * concatenates ahead of the transcript).
 */
export function buildToolSystemPrompt(tools: readonly IRTool[]): string {
  if (tools.length === 0) return '';
  const lines: string[] = [];
  lines.push('You can call tools to answer. Available tools:');
  lines.push('');
  for (const t of tools) {
    const schema = JSON.stringify(t.input_schema ?? {});
    const desc = t.description ? ` — ${t.description}` : '';
    lines.push(`- ${t.name}${desc}`);
    lines.push(`  input JSON schema: ${schema}`);
  }
  lines.push('');
  lines.push('To call a tool, reply with EXACTLY one block and nothing else:');
  lines.push(TOOL_OPEN);
  lines.push('{"name": "<tool name>", "arguments": { <arguments matching the schema> }}');
  lines.push(TOOL_CLOSE);
  lines.push('');
  lines.push(
    'RULES — follow exactly:\n' +
      '1. If ANY tool above can supply information needed to answer, you MUST call ' +
      'it. Do NOT answer from your own knowledge, memory, or built-in web search ' +
      'when a tool can provide the value — even if you think you know it. Never ' +
      'guess, estimate, or fabricate a value a tool can return.\n' +
      '2. When you call a tool, output ONLY the ' +
      TOOL_OPEN +
      ' block — no prose before or after it.\n' +
      '3. Call one tool at a time; after the tool result comes back you may call ' +
      'another tool or answer.\n' +
      '4. Only when no tool is needed (or all needed tools have already returned) ' +
      'give your final answer as plain text with NO ' +
      TOOL_OPEN +
      ' block.',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Transcript rendering (IR -> one app-chat message)
// ---------------------------------------------------------------------------

/**
 * op_chat opens a fresh temporary conversation each call, so there is no
 * server-side history to rely on. We therefore render the whole IR message
 * list into one text transcript and send it as a single message. Deterministic
 * and self-contained — the same messages always render byte-identically.
 */
export function renderTranscript(messages: readonly IRMessage[]): string {
  const out: string[] = [];
  for (const msg of messages) {
    const speaker = msg.role === 'user' ? 'User' : 'Assistant';
    for (const block of msg.content) {
      switch (block.type) {
        case 'text':
          out.push(`${speaker}: ${block.text}`);
          break;
        case 'tool_use':
          // Echo the assistant's prior tool call so the model sees its own move.
          out.push(
            `${speaker}: ${TOOL_OPEN}\n${JSON.stringify({
              name: block.name,
              arguments: block.input,
            })}\n${TOOL_CLOSE}`,
          );
          break;
        case 'tool_result': {
          const content =
            typeof block.content === 'string'
              ? block.content
              : block.content
                  .map((c) => (c.type === 'text' ? c.text : '[image]'))
                  .join('\n');
          const tag = block.is_error ? 'Tool error' : 'Tool result';
          out.push(`${tag}: ${content}`);
          break;
        }
        case 'thinking':
        case 'image':
          // Reasoning never re-sent; images unsupported on this text lane.
          break;
      }
    }
  }
  return out.join('\n\n');
}

/**
 * Full app-chat message for one brain turn: system tool-instructions (if any)
 * followed by the rendered transcript.
 */
export function buildChatMessage(
  messages: readonly IRMessage[],
  tools: readonly IRTool[],
  system?: string,
): string {
  const toolSys = buildToolSystemPrompt(tools);
  const transcript = renderTranscript(messages);
  const head = [system ? `System instructions:\n${system}` : '', toolSys].filter(Boolean).join('\n\n');
  return head ? `${head}\n\n---\n\n${transcript}` : transcript;
}

// ---------------------------------------------------------------------------
// Reply parsing (grok text -> IR-shaped result)
// ---------------------------------------------------------------------------

/** Extract the first balanced JSON object starting at `from` (handles nesting/strings). */
function extractJsonObject(s: string, from: number): string | null {
  const start = s.indexOf('{', from);
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse a grok app-chat reply into a tool call or a final answer.
 *
 * Recognises, in order:
 *  1. `<tool_call> { ... } </tool_call>` (the instructed format)
 *  2. a ```json fenced object that has a `name` + (`arguments`|`input`) key
 *     (models drift to markdown fences — accept it rather than loop)
 *
 * Anything else is a final text answer. A malformed tool block (unparseable
 * JSON, missing name) is treated as text so the loop surfaces grok's words
 * instead of silently failing.
 */
export function parseGrokReply(reply: string, idFn: IdFn = defaultId): ParsedGrokReply {
  const text = reply ?? '';

  // 1) instructed <tool_call> block
  const open = text.indexOf(TOOL_OPEN);
  if (open !== -1) {
    const json = extractJsonObject(text, open + TOOL_OPEN.length);
    const parsed = json ? toToolUse(json, idFn) : null;
    if (parsed) return parsed;
  }

  // 2) fenced ```json { "name": ..., "arguments"/"input": ... }
  const fence = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/i.exec(text);
  if (fence) {
    const parsed = toToolUse(fence[1], idFn);
    if (parsed) return parsed;
  }

  return { kind: 'text', text: text.trim() };
}

function toToolUse(json: string, idFn: IdFn): GrokToolUse | null {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const rec = obj as Record<string, unknown>;
  const name = rec['name'];
  if (typeof name !== 'string' || name === '') return null;
  const rawArgs = 'arguments' in rec ? rec['arguments'] : rec['input'];
  const input =
    typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};
  return { kind: 'tool_use', id: idFn(), name, input };
}

function defaultId(): string {
  return `grokweb_${randomUUID()}`;
}
