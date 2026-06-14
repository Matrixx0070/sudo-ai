/**
 * @file acp/brain-backend.ts
 * @description ACP backend that drives sudo-ai's multi-provider Brain.
 *
 * Slice 1 was chat-only: one streamed brain call per prompt turn. Slice 2
 * (gap #26) layers tool dispatch + ACP permission round-trip on top, with the
 * old chat-only behavior preserved when no tools are configured.
 *
 * Tool-call wire format (in the model's streamed text):
 *
 *   <tool_call id="<stable-id>" name="<tool-name>">{"arg":"value"}</tool_call>
 *
 * The full block is scanned for after each stream finishes. For each match,
 * the backend:
 *   1. Emits a `tool_call` session/update with status 'pending'.
 *   2. If the tool requires confirmation, sends `session/request_permission`
 *      to the client and awaits an `allow_*` selection. A `reject_*` or a
 *      `cancelled` outcome ends the call with status 'cancelled' and a
 *      synthetic tool result so the model knows.
 *   3. Emits `tool_call_update` status 'in_progress', dispatches via the
 *      injected dispatcher, then emits 'completed' or 'failed'.
 *   4. Appends the tool result as a `tool` message to history.
 * After dispatching ALL detected tool calls, the loop re-runs the brain stream
 * so the model can react to the results. Bounded by `maxIterations`.
 *
 * Backward compat: omit `tools` from the constructor options and behavior
 * collapses to slice 1 exactly (one stream pass, no parsing).
 *
 * The Brain is duck-typed ({@link AcpBrain}) so this is unit-testable with a
 * stub async generator.
 */

import { randomUUID } from 'node:crypto';
import type { AcpBackend } from './acp-server.js';
import type {
  NewSessionParams,
  StopReason,
  ToolCallKind,
  PermissionOption,
  RequestPermissionParams,
  RequestPermissionResult,
  SessionUpdate,
} from './types.js';
import type { SessionStore, StoredMessage, StoredSession } from './session-store.js';

/** Minimal slice of Brain.stream() this backend depends on. */
export interface AcpBrain {
  stream(request: {
    messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }>;
    stream?: boolean;
    model?: string;
  }): AsyncGenerator<string>;
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
}

/** A `<tool_call>` block parsed out of an assistant turn. */
interface ParsedToolCall {
  toolCallId: string;
  name: string;
  rawInput: string;
  args: Record<string, unknown>;
}

/**
 * One tool dispatch attempt. The backend hands the dispatcher the parsed
 * arguments and a stable `toolCallId`; the dispatcher decides which tool to
 * run (lookup by `toolName`) and returns either a textual result or an
 * honest failure shape — `null`/`undefined` returns are interpreted as the
 * tool refusing politely (synthetic "no output").
 */
export type ToolDispatchResult = {
  success: boolean;
  /** Free-form textual output appended to history as the tool message. */
  output: string;
  /** True if this tool needed `session/request_permission` per ACP. */
  requiresConfirmation: boolean;
  /** Used in the `session/request_permission` toolCall block. */
  title: string;
  kind: ToolCallKind;
};

export interface ToolMetadata {
  title: string;
  kind: ToolCallKind;
  requiresConfirmation: boolean;
}

/**
 * Decoupled tool surface: the backend asks for metadata (title, kind,
 * requiresConfirmation) BEFORE dispatching, and dispatches via execute().
 * Real callers wrap `ToolRegistry`; tests provide a stub.
 */
export interface AcpToolHost {
  describe(toolName: string): ToolMetadata | undefined;
  /**
   * Execute the tool. `sessionId` is threaded through so hosts that bridge to
   * ACP `fs/*` or `terminal/*` client methods can include it in their params
   * (gap #26 slice 3 — the spec requires sessionId on every client request).
   */
  execute(
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    sessionId: string,
  ): Promise<{ success: boolean; output: string }>;
}

/** Issues `session/request_permission` requests to the ACP client. */
export type PermissionRequester = (params: RequestPermissionParams) => Promise<RequestPermissionResult>;

/** Emits `session/update` notifications. The backend itself does not own the wire. */
export type UpdateEmitter = (update: import('./types.js').SessionUpdate) => void;

export interface AcpBackendToolsOptions {
  host: AcpToolHost;
  requestPermission: PermissionRequester;
  /** Cap the brain↔tool ping-pong. Each iteration = one brain stream + dispatch pass. */
  maxIterations?: number;
}

export interface AcpBackendOptions {
  model?: string;
  /** When set, tool dispatch + permission round-trip is enabled (slice 2). */
  tools?: AcpBackendToolsOptions;
  /**
   * When set, the backend persists per-session histories after each prompt
   * turn and `loadSession()` becomes meaningful (slice 4). The server uses
   * the presence of this option to advertise `agentCapabilities.loadSession`.
   */
  sessionStore?: SessionStore;
}

/** Bound per-session history (FIFO trim on overflow). */
const MAX_HISTORY_MESSAGES = 400;
/** Default cap on brain↔tool iterations per prompt turn. */
const DEFAULT_MAX_ITERATIONS = 6;

/** Regex for the `<tool_call ...>...</tool_call>` block — non-greedy body. */
const TOOL_CALL_RE = /<tool_call\s+id="([^"]+)"\s+name="([^"]+)"\s*>([\s\S]*?)<\/tool_call>/g;

/** Standard ACP permission options. */
const STANDARD_PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
  // reject_always is offered + handled in the cache below so a user that
  // permanently blocks a tool isn't re-prompted later in the same session
  // (verifier HIGH 1 — without it, the cache branch was dead code).
  { optionId: 'reject_always', name: 'Always reject', kind: 'reject_always' },
];

/**
 * Build the canonical tool-result message appended to history after a
 * dispatch. Uses a JSON envelope rather than an XML-like wrapper so a tool
 * that outputs literal `</tool_result>` cannot corrupt the model's next read
 * (verifier HIGH 2). Errors carry `success:false` + `error` field so the
 * model can distinguish a refusal from a successful no-output call.
 */
function formatToolResult(
  toolCallId: string,
  result: { success: boolean; output?: string; error?: string },
): string {
  const envelope: Record<string, unknown> = { toolCallId, success: result.success };
  if (result.output !== undefined) envelope['output'] = result.output;
  if (result.error !== undefined) envelope['error'] = result.error;
  return JSON.stringify(envelope);
}

export class BrainAcpBackend implements AcpBackend {
  private readonly histories = new Map<string, ChatMessage[]>();
  private readonly brain: AcpBrain;
  private readonly model: string | undefined;
  private readonly tools: AcpBackendToolsOptions | undefined;
  private readonly sessionStore: SessionStore | undefined;
  /** ISO timestamp of first persist per session — used to fill `createdAt`. */
  private readonly sessionCreatedAt = new Map<string, string>();

  // Permission cache keyed by (sessionId, toolName) — populated when the client
  // returns `allow_always`. `reject_always` is also remembered so the agent
  // stops asking. Cleared per process; survives across turns in the same
  // session.
  private readonly permissionCache = new Map<string, 'always_allow' | 'always_reject'>();

  constructor(brain: AcpBrain, options: AcpBackendOptions = {}) {
    this.brain = brain;
    this.model = options.model;
    this.tools = options.tools;
    this.sessionStore = options.sessionStore;
  }

  createSession(_params: NewSessionParams): string {
    const id = `acp_${randomUUID()}`;
    this.histories.set(id, []);
    this.sessionCreatedAt.set(id, new Date().toISOString());
    return id;
  }

  /** True when a SessionStore is wired — drives the server's loadSession capability advert. */
  supportsLoadSession(): boolean {
    return this.sessionStore !== undefined;
  }

  /**
   * Load a previously-persisted session from disk and replay its history as
   * `session/update` notifications so the client can rebuild its UI
   * (gap #26 slice 4).
   *
   * Returns `true` on success, `false` when the session is unknown to the
   * store. Throws only on a malformed sessionId (caller maps that to
   * `InvalidParams`).
   *
   * Replay scope: text-only — `user_message_chunk` + `agent_message_chunk`.
   * Tool calls embedded in the assistant text remain as raw text per the
   * slice 2 wire format; clients can re-parse them client-side. Replaying
   * structured `tool_call` + `tool_call_update` notifications keyed by
   * stable ids is a future slice (requires storing the call envelope, not
   * just the resulting text).
   */
  async loadSession(args: {
    sessionId: string;
    emit?: (update: SessionUpdate) => void;
  }): Promise<boolean> {
    const store = this.sessionStore;
    if (!store) return false;
    const record = await store.load(args.sessionId);
    if (!record) return false;

    this.histories.set(args.sessionId, record.messages.map((m) => ({ role: m.role, content: m.content })));
    this.sessionCreatedAt.set(args.sessionId, record.createdAt);

    if (args.emit) {
      for (const m of record.messages) {
        if (m.role === 'user') {
          args.emit({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: m.content } });
        } else if (m.role === 'assistant') {
          args.emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: m.content } });
        }
        // Tool messages are not replayed as structured updates this slice —
        // the model still sees them in the next stream pass via history.
      }
    }

    return true;
  }

  /** Persist the in-memory history for one session. No-op without a store. */
  private async persist(sessionId: string): Promise<void> {
    const store = this.sessionStore;
    if (!store) return;
    const history = this.histories.get(sessionId);
    if (!history) return;
    const now = new Date().toISOString();
    const createdAt = this.sessionCreatedAt.get(sessionId) ?? now;
    const record: StoredSession = {
      version: 1,
      sessionId,
      createdAt,
      updatedAt: now,
      messages: history.map((m): StoredMessage => ({ role: m.role, content: m.content })),
    };
    try {
      await store.save(record);
    } catch {
      // Persistence failures should never break the conversation — the
      // in-memory history is still authoritative. A future slice can
      // surface this via a hook event.
    }
  }

  async prompt(args: {
    sessionId: string;
    text: string;
    onChunk: (text: string) => void;
    signal: AbortSignal;
    emit?: UpdateEmitter;
  }): Promise<StopReason> {
    const history = this.histories.get(args.sessionId) ?? [];
    history.push({ role: 'user', content: args.text });

    const tools = this.tools;
    const maxIterations = tools?.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    let cancelled = false;
    let stopReason: StopReason = 'end_turn';

    for (let iter = 0; iter < maxIterations; iter++) {
      const request = {
        messages: history.slice(),
        stream: true as const,
        ...(this.model ? { model: this.model } : {}),
      };

      let assistant = '';
      for await (const chunk of this.brain.stream(request)) {
        if (args.signal.aborted) {
          cancelled = true;
          break;
        }
        assistant += chunk;
        args.onChunk(chunk);
      }

      // Persist whatever was produced so context survives a mid-turn cancel.
      if (assistant.length > 0) history.push({ role: 'assistant', content: assistant });
      if (cancelled) {
        stopReason = 'cancelled';
        break;
      }

      // Slice 1 path: no tools configured → one pass and we're done.
      if (!tools) break;

      const calls = parseToolCalls(assistant);
      if (calls.length === 0) break;

      // Dispatch each call serially so notifications stay ordered. A failed
      // permission round-trip ends the call gracefully (status 'cancelled')
      // and feeds back to the model so the next iteration can react.
      for (const call of calls) {
        if (args.signal.aborted) {
          cancelled = true;
          break;
        }
        await this.dispatchOne(args.sessionId, call, args.signal, args.emit);
      }

      if (cancelled) {
        stopReason = 'cancelled';
        break;
      }

      if (iter === maxIterations - 1) {
        stopReason = 'max_turn_requests';
      }
    }

    if (history.length > MAX_HISTORY_MESSAGES) {
      history.splice(0, history.length - MAX_HISTORY_MESSAGES);
    }
    this.histories.set(args.sessionId, history);
    // Best-effort persist after the turn. See persist() for failure posture.
    await this.persist(args.sessionId);
    return stopReason;
  }

  /** Run a single parsed tool call end-to-end. Pushes a `tool` message to history. */
  private async dispatchOne(
    sessionId: string,
    call: ParsedToolCall,
    signal: AbortSignal,
    emit: UpdateEmitter | undefined,
  ): Promise<void> {
    const history = this.histories.get(sessionId);
    if (!history) return;
    const tools = this.tools;
    if (!tools) return;

    const meta = tools.host.describe(call.name);
    const kind: ToolCallKind = meta?.kind ?? 'other';
    const title = meta?.title ?? call.name;
    const requiresConfirmation = meta?.requiresConfirmation ?? false;

    // Announce the call (status 'pending'); a synchronous emit so a remote
    // client can render before any side-effect happens.
    emit?.({
      sessionUpdate: 'tool_call',
      toolCallId: call.toolCallId,
      title,
      kind,
      status: 'pending',
      rawInput: call.args,
    });

    // Permission gate (ACP `session/request_permission`).
    if (requiresConfirmation) {
      const cacheKey = `${sessionId}::${call.name}`;
      const cached = this.permissionCache.get(cacheKey);
      let granted: boolean;
      if (cached === 'always_allow') {
        granted = true;
      } else if (cached === 'always_reject') {
        granted = false;
      } else {
        const outcome = await tools.requestPermission({
          sessionId,
          toolCall: {
            toolCallId: call.toolCallId,
            title,
            kind,
            rawInput: call.args,
          },
          options: STANDARD_PERMISSION_OPTIONS,
        });
        const sel = outcome.outcome;
        if (sel.outcome === 'cancelled') {
          granted = false;
        } else {
          if (sel.optionId === 'allow_always') {
            this.permissionCache.set(cacheKey, 'always_allow');
          } else if (sel.optionId === 'reject_always') {
            this.permissionCache.set(cacheKey, 'always_reject');
          }
          granted = sel.optionId === 'allow_once' || sel.optionId === 'allow_always';
        }
      }

      if (!granted) {
        emit?.({
          sessionUpdate: 'tool_call_update',
          toolCallId: call.toolCallId,
          status: 'cancelled',
          rawError: 'permission denied by client',
        });
        history.push({
          role: 'tool',
          content: formatToolResult(call.toolCallId, {
            success: false,
            error: 'permission denied by client',
          }),
        });
        return;
      }
    }

    emit?.({
      sessionUpdate: 'tool_call_update',
      toolCallId: call.toolCallId,
      status: 'in_progress',
    });

    let dispatchResult: { success: boolean; output: string };
    try {
      dispatchResult = await tools.host.execute(call.name, call.args, signal, sessionId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emit?.({
        sessionUpdate: 'tool_call_update',
        toolCallId: call.toolCallId,
        status: 'failed',
        rawError: msg,
      });
      history.push({
        role: 'tool',
        content: formatToolResult(call.toolCallId, { success: false, error: msg }),
      });
      return;
    }

    emit?.({
      sessionUpdate: 'tool_call_update',
      toolCallId: call.toolCallId,
      status: dispatchResult.success ? 'completed' : 'failed',
      content: [{ type: 'text', text: dispatchResult.output }],
    });

    history.push({
      role: 'tool',
      content: formatToolResult(call.toolCallId, {
        success: dispatchResult.success,
        output: dispatchResult.output,
      }),
    });
  }
}

/**
 * Parse `<tool_call id="..." name="...">JSON</tool_call>` blocks from an
 * assistant message. Exported for testing. Skips entries whose body isn't
 * valid JSON (so a malformed args block doesn't poison the whole turn).
 *
 * Known limitation: a JSON argument STRING containing the literal sequence
 * `</tool_call>` will truncate the regex match early; the resulting
 * truncated JSON fails to parse and the call is silently skipped. Models
 * should escape closing tags inside string args (the wire format itself is
 * the operator's prompt-engineering responsibility); a future slice may
 * switch the envelope to length-prefixed or fenced-JSON to remove the
 * limitation.
 */
export function parseToolCalls(text: string): ParsedToolCall[] {
  const out: ParsedToolCall[] = [];
  TOOL_CALL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOOL_CALL_RE.exec(text)) !== null) {
    const [, toolCallId, name, rawInput] = match as unknown as [string, string, string, string];
    let args: Record<string, unknown> = {};
    const trimmed = rawInput.trim();
    if (trimmed !== '') {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        } else {
          continue; // malformed args — skip honestly
        }
      } catch {
        continue;
      }
    }
    out.push({ toolCallId, name, rawInput: trimmed, args });
  }
  return out;
}
