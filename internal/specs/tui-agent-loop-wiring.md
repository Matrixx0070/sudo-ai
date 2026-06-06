# TUI Agent Loop Wiring Spec

**Status:** Authoritative spec for one builder.  
**Date:** 2026-04-17  
**Scope:** Wire the TUI chat to AgentLoop (full 265-tool, 500-iteration loop) without redesigning the TUI.

---

## 1. Current AgentLoop Contract

### Signature

```
AgentLoop.run(
  sessionId: string,
  message:   string,
  onEvent?:  AgentEventHandler,
): Promise<AgentRunResult>
```

`AgentRunResult` = `{ text: string; attachments: Array<{ type, path, filename? }> }`

`AgentEventHandler` = `(event: AgentEvent) => void`

### AgentEvent union (src/core/agent/types.ts:48-61)

| Event type | Fields | When emitted |
|---|---|---|
| `stream-chunk` | `chunk: string` | When LLM emits text alongside tool-calls (`finishReason === 'tool-calls'` + non-empty content). NOT on the final stop turn. |
| `message` | `content: string` | On `finishReason === 'stop'` — this is the primary carrier of final assistant text. Must NOT be dropped. |
| `tool-call` | `name: string`, `args: Record<string,unknown>` | Once per tool dispatch, before execution |
| `tool-result` | `name: string`, `result: unknown` | Once per tool completion (success or error text) |
| `error` | `error: string` | Veto, epistemic block, injection-critical, loop-guard abort |
| `done` | — | End of run |
| `rich-response` | structured blocks | Drop in TUI |
| `trace-meta` | complexity/taint | Drop in TUI |
| `compaction` | `summary` | Drop in TUI |

### Multi-turn iteration depth

`MAX_AGENT_ITERATIONS = 500` (`src/core/shared/constants.ts:68`).  
Inner while-loop at `src/core/agent/loop.ts:747` runs until `finishReason === 'stop'` or cap.  
**No change needed.** 500 iterations already satisfies the "200+ tools in a single turn" requirement.

### Important: no token streaming into AgentEvent

`loop.ts:812` is `await this.brain.call(...)` — a single awaited call, not a streaming call. The `stream-chunk` event fires only when the model returns text alongside tool-calls. For a no-tool reply, the final text arrives in one chunk via the `message` event. This means the TUI will show a longer spinner followed by an instant full-text render, compared to the current character-by-character streaming. This is a known UX trade-off of the in-process path, not a bug.

### Tool registry

`ToolRegistry` is instantiated in `src/cli.ts:382`, loaded at line 385, and its count is logged at line 397. The gateway's `/v1/chat/completions` is an OpenAI proxy to the local gateway — it does not route through AgentLoop. The TUI currently uses that proxy and therefore has zero tool access.

---

## 2. How Web/Telegram Invoke AgentLoop

Both channels follow the same pattern in `src/cli.ts`:

1. `adapter.onMessage(handler)` registers a callback.
2. Handler calls `dualSessionManager.getOrCreate(channel, peerId)` to get a session ID.
3. Handler calls `await finalAgentLoop.run(String(session.id), msg.text)` — **no onEvent callback** — and sends `result.text` back.

Web and telegram deliver **final text only**. The TUI spinner + live tool cards go beyond this and are a net capability gain, not a parity goal.

---

## 3. Architecture Decision: In-Process

**Decision: In-process bootstrap.**

The gateway `/v1/chat/completions` is an OpenAI proxy to the local gateway, not an AgentLoop endpoint. No streaming agent-run route exists on the gateway. The `src/core/gateway/sse-stream.ts` SSE broker fans out HookEvents, not AgentEvents. Building a new gateway route would add a TCP round-trip and require the daemon to be running. The TUI must bootstrap its own AgentLoop in-process.

---

## 4. Blocker: Missing toolId on AgentEvent

`AgentEvent` `tool-call` carries `{ name, args }` — no toolId.  
`AgentEvent` `tool-result` carries `{ name, result }` — no toolId.  
The dispatcher keys `ToolCallCard` by toolId. Without it, call↔result pairing fails in batched parallel execution (`executeToolCalls` runs parallel batches).

`tc.id` is already available at every emit site in `src/core/agent/loop-helpers.ts` (logged at line 386 but not emitted).

---

## 5. Required Code Changes

### 5.1 src/core/agent/types.ts — additive change

Extend two variants in the `AgentEvent` union. Existing callers that ignore toolId are unaffected.

Change lines 50-51 from:
```typescript
| { type: 'tool-call';   name: string; args: Record<string, unknown> }
| { type: 'tool-result'; name: string; result: unknown }
```
To:
```typescript
| { type: 'tool-call';   name: string; args: Record<string, unknown>; toolId: string }
| { type: 'tool-result'; name: string; result: unknown;               toolId: string }
```

### 5.2 src/core/agent/loop-helpers.ts — 5 emit sites

Add `toolId: tc.id` to every `emit({ type: 'tool-call' ... })` and `emit({ type: 'tool-result' ... })` call. Lines are approximately 385, 393, 402, 413, 418 (verify by searching for `emit({ type: 'tool-call'` and `emit({ type: 'tool-result'`).

Example:
```typescript
// line 385 — before
emit({ type: 'tool-call', name: tc.name, args: tc.arguments });
// after
emit({ type: 'tool-call', name: tc.name, args: tc.arguments, toolId: tc.id });
```

### 5.3 New file: src/cli/commands/chat/agent-loop-adapter.ts

Full public interface:

```typescript
export interface TuiAgentAdapterDeps {
  agentLoop:      AgentLoop;
  sessionManager: { getOrCreate(channel: string, peerId: string): Promise<{ id: string | number }> };
}

export class TuiAgentAdapter {
  constructor(private deps?: TuiAgentAdapterDeps) {}

  /** Stream one user turn. Yields text and done only; fires dispatcher for tool events. */
  async *stream(opts: {
    sessionId: string;
    message:   string;
    signal:    AbortSignal;
  }): AsyncGenerator<ProviderChunk>
}
```

**Self-bootstrap (when deps is absent):**

```typescript
// Brain — same pattern as cli.ts:280
import { Brain }           from '../../../core/brain/brain.js';
import { ToolRegistry }    from '../../../core/tools/registry.js';
import { loadBuiltinTools } from '../../../core/tools/loader.js';
import { SessionManager }  from '../../../core/sessions/manager.js';
import { AgentLoop }       from '../../../core/agent/loop.js';
import Database            from 'better-sqlite3';

const config = await ConfigLoader.load();  // same as cli.ts
const brain  = new Brain(config);

const registry = new ToolRegistry();
const toolsDir = new URL('../../../core/tools/builtin', import.meta.url).pathname;
await loadBuiltinTools(registry, toolsDir);

// Use a TUI-private DATA_DIR to avoid SQLite lock contention with the running daemon.
// Never share the daemon's DATA_DIR. See §6 for rationale.
const tuiDataDir = path.join(
  process.env['HOME'] ?? '/root',
  '.sudo-ai', 'tui-data',
);
fs.mkdirSync(tuiDataDir, { recursive: true });

const db            = new Database(path.join(tuiDataDir, 'sessions.db'));
const sessionMgr    = new SessionManager(db);
const agentLoop     = new AgentLoop(brain, registry, sessionMgr, { maxIterations: 500 });
```

**AgentEvent → ProviderChunk mapping:**

| AgentEvent type | Action | Notes |
|---|---|---|
| `stream-chunk` | yield `{ type: 'text', value: chunk }` | Partial text alongside tool-calls |
| `message` | yield `{ type: 'text', value: content }` | Final assistant text (stop path) |
| `tool-call` | `dispatcher.emit({ type: 'tool_start', toolId, toolName: name, args: JSON.stringify(args), gerund: toolNameToGerund(name) })` | NOT yielded — goes to dispatcher |
| `tool-result` | `dispatcher.emit({ type: 'tool_end', toolId, resultPreview, resultFull, isDiff, elapsedMs })` | NOT yielded — goes to dispatcher |
| `error` | `dispatcher.emit({ type: 'tool_error', toolId: lastActiveToolId, error, elapsedMs })` | If no active toolId, drop |
| `done` | yield `{ type: 'done' }` | End |
| `rich-response` | drop | — |
| `trace-meta` | drop | — |
| `compaction` | drop | — |

**elapsedMs tracking:** Adapter maintains `Map<string, number>` of `toolId → Date.now()`. Set on `tool-call`, read and delete on `tool-result` or `error`.

**isDiff detection:** `resultFull.trimStart().startsWith('@@')` or contains `\n-` / `\n+` lines.

**resultPreview:** `resultFull.slice(0, 120).replace(/\n/g, ' ')`.

**Cancellation:** Wrap `agentLoop.run()` in `Promise.race`:

```typescript
const abortPromise = new Promise<never>((_, reject) =>
  opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
);
try {
  await Promise.race([agentLoop.run(opts.sessionId, opts.message, onEvent), abortPromise]);
} catch (err) {
  if (\!opts.signal.aborted) throw err;
  // aborted — fall through to done
}
yield { type: 'done' };
```

Note: when abort wins, AgentLoop.run() continues executing in the background (tool calls, SQLite writes) until the current iteration completes. This is a known leak — acceptable for CLI use. Document with a comment in the adapter.

**Permission dialog:** The veto gate runs inside AgentLoop before tool execution. There is no `tool_permission_request` AgentEvent source. The TUI `awaiting_approval` phase and `PermissionDialog` component remain in place but are never activated from the AgentLoop path. Do not remove them; do not attempt to wire them.

### 5.4 src/cli/commands/chat/App.tsx — surgical replace

**Add near top of App component (after existing refs):**

```typescript
const tuiSessionIdRef = useRef<string>(nanoid());
const tuiAdapterRef   = useRef<TuiAgentAdapter | null>(null);
```

Initialize adapter lazily on first submit (or in useEffect on mount). Import:
```typescript
import { TuiAgentAdapter } from './agent-loop-adapter.js';
```

**Replace lines 556-576 in handleSubmit:**

```typescript
// BEFORE:
for await (const chunk of chatStream({
  messages: conversationRef.current,
  system: systemPrompt,
  model,
  signal: ac.signal,
})) {

// AFTER:
if (\!tuiAdapterRef.current) tuiAdapterRef.current = new TuiAgentAdapter();
for await (const chunk of tuiAdapterRef.current.stream({
  sessionId: tuiSessionIdRef.current,
  message:   userText,
  signal:    ac.signal,
})) {
```

All existing chunk-handling code (`if chunk.type === 'text'`, `if chunk.type === 'done'`) is unchanged. The `conversationRef` and `systemPrompt` state variables are no longer used for the LLM call (AgentLoop maintains its own history via SessionManager). They can remain in state for the `/model` and `/system` slash commands which should be updated to print: `Model/system prompt control is not supported in AgentLoop mode.`

**Token accounting:** The adapter yields `{ type: 'done', usage: { outputTokens: Math.ceil(text.length / 4) } }` as an approximation since AgentLoop does not surface token counts. This keeps the header token counter incrementing realistically.

---

## 6. SQLite Contention with Running Daemon

`AgentLoop` constructor opens `audit.db`, `trust.db`, `veto-overrides.db` from `process.env['DATA_DIR']`. The daemon (pm2 `sudo-ai-v5`, pid 549522) holds those files open with better-sqlite3 write locks.

**Rule:** The TUI adapter MUST NOT use the daemon's `DATA_DIR`. The adapter sets its own `tuiDataDir` as `$HOME/.sudo-ai/tui-data/` before constructing AgentLoop, and never reads `process.env['DATA_DIR']`. The AgentLoop constructor will create clean databases in that directory. This means TUI-session trust scores and veto history are isolated from daemon history — acceptable.

If the builder sees `DATA_DIR` being read implicitly somewhere in the bootstrap path, add `process.env['DATA_DIR'] = tuiDataDir` at the top of the self-bootstrap block before constructing AgentLoop.

---

## 7. Slash Commands /model and /system

`App.tsx:494-501` handles `/model` and `/system`. In the AgentLoop path, these have no effect (AgentLoop uses its own Brain config; it does not accept a runtime model override through the run() interface).

The builder must update these two cases in `handleSlashCommand` to print:
```
/model: not supported in AgentLoop mode. Set MODEL env var to change the model.
/system: not supported in AgentLoop mode. System prompt is loaded from config.
```

Do not remove the state variables — they are used by the header and info panel display.

---

## 8. File Ownership

One builder owns exactly these files — no other file is touched:

| File | Action |
|---|---|
| `/root/sudo-ai-v4/src/core/agent/types.ts` | Add `toolId: string` to `tool-call` and `tool-result` variants |
| `/root/sudo-ai-v4/src/core/agent/loop-helpers.ts` | Pass `toolId: tc.id` in all 5 emit sites |
| `/root/sudo-ai-v4/src/cli/commands/chat/agent-loop-adapter.ts` | New file — TuiAgentAdapter class |
| `/root/sudo-ai-v4/src/cli/commands/chat/App.tsx` | Replace chatStream call; add sessionId ref; update /model /system stubs |

---

## 9. Acceptance Criteria

1. `sudo-ai chat` → type "list files in /tmp" → the agent executes `bash` or file tool, tool card appears (running → done), final text renders. No empty reply.
2. A 5-step chained task completes with 5 tool cards rendered sequentially in the TUI.
3. Ctrl+C during an agent turn returns the TUI to `idle` with `[cancelled]` appended. Background AgentLoop work may continue for up to one iteration before terminating naturally (documented leak — acceptable).
4. `tsc --noEmit` passes with zero new errors after the types.ts extension.
5. All 3049+ existing tests pass (the types.ts change is additive; no existing caller reads toolId).
6. `sudo-ai chat` started while daemon is running (pm2 sudo-ai-v5) does not throw SQLite lock errors.
7. `/model foo` and `/system bar` print the "not supported" message instead of silently changing state that has no effect.
8. Token counter in header increments after each turn (approximated via output length).

