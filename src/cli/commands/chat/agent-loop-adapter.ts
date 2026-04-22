/**
 * @file agent-loop-adapter.ts
 * TuiAgentAdapter — in-process AgentLoop bridge for the TUI chat window.
 *
 * Self-bootstraps Brain + ToolRegistry + SessionManager + AgentLoop using
 * a TUI-private data directory (~/.sudo-ai/tui-data/) to avoid SQLite lock
 * contention with the running pm2 daemon (sudo-ai-v5, port 18900).
 *
 * Maps AgentEvent → ProviderChunk:
 *   stream-chunk / message → yield { type: 'text', value }
 *   tool-call             → dispatcher.emit(tool_start)   [NOT yielded]
 *   tool-result           → dispatcher.emit(tool_end)     [NOT yielded]
 *   error                 → dispatcher.emit(tool_error)   [NOT yielded]
 *   done                  → yield { type: 'done' }
 *   rich-response / trace-meta / compaction → dropped
 *
 * Cancellation: Promise.race with the AbortSignal. Known leak: AgentLoop.run()
 * continues executing in the background (tool calls, SQLite writes) until the
 * current iteration completes naturally. Acceptable for CLI use.
 */

import path from 'node:path';
import fs from 'node:fs';
import type { ProviderChunk } from './provider.js';
import { dispatcher } from './dispatcher.js';
import { toolNameToGerund } from './components/GerundSpinner.js';

// ---------------------------------------------------------------------------
// Optional injected deps (for testing / advanced callers).
// When absent the adapter self-bootstraps.
// ---------------------------------------------------------------------------

export interface TuiAgentAdapterDeps {
  agentLoop: {
    run(
      sessionId: string,
      message: string,
      onEvent?: (event: import('../../../core/agent/types.js').AgentEvent) => void,
    ): Promise<{ text: string; attachments: unknown[] }>;
  };
  sessionManager: {
    getOrCreate(channel: string, peerId: string): Promise<{ id: string | number }>;
  };
}

// ---------------------------------------------------------------------------
// TuiAgentAdapter
// ---------------------------------------------------------------------------

export class TuiAgentAdapter {
  private deps?: TuiAgentAdapterDeps;
  // Lazily resolved (resolved on first stream() call).
  private _resolvedDeps: TuiAgentAdapterDeps | null = null;

  constructor(deps?: TuiAgentAdapterDeps) {
    this.deps = deps;
  }

  // ---------------------------------------------------------------------------
  // Bootstrap (called once on first use)
  // ---------------------------------------------------------------------------

  private async _bootstrap(): Promise<TuiAgentAdapterDeps> {
    if (this._resolvedDeps) return this._resolvedDeps;
    if (this.deps) {
      this._resolvedDeps = this.deps;
      return this._resolvedDeps;
    }

    // Use a TUI-private DATA_DIR to avoid SQLite lock contention with the running daemon.
    // The daemon holds audit.db / trust.db / veto-overrides.db open with write locks.
    const tuiDataDir = path.join(
      process.env['HOME'] ?? '/root',
      '.sudo-ai',
      'tui-data',
    );
    fs.mkdirSync(tuiDataDir, { recursive: true });

    // Set DATA_DIR before constructing AgentLoop so all sub-modules that read it
    // (AuditTrail, VetoOverrideStore, TrustTierTracker, etc.) use the TUI-private path.
    process.env['DATA_DIR'] = tuiDataDir;

    // --- Config ---
    const { ConfigLoader } = await import('../../../core/config/loader.js');
    const configLoader = new ConfigLoader(process.cwd());
    await configLoader.load();
    const config = configLoader.get();

    // --- Brain ---
    const { Brain } = await import('../../../core/brain/brain.js');
    const brain = new Brain(config);

    // --- ToolRegistry + builtin tools ---
    const { ToolRegistry } = await import('../../../core/tools/registry.js');
    const { loadBuiltinTools } = await import('../../../core/tools/loader.js');
    const registry = new ToolRegistry();
    ToolRegistry.setGlobal(registry);
    const toolsDir = new URL('../../../core/tools/builtin', import.meta.url).pathname;
    await loadBuiltinTools(registry, toolsDir);
    // Diagnostic: bypass pino/Ink filtering — writes to stderr unconditionally.
    process.stderr.write(`[tui-bootstrap] tools loaded: ${registry.listEnabled().length}\n`);

    // Register superpowers (12 advanced capabilities) for tool parity with prod.
    try {
      const { registerSuperpowers } = await import('../../../core/superpowers/index.js');
      registerSuperpowers(registry);
    } catch (err: unknown) {
      process.stderr.write(`[tui-bootstrap] superpowers import failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }

    // --- MindDB + SessionManager (TUI-private DB path) ---
    const { MindDB } = await import('../../../core/memory/db.js');
    const { SessionManager } = await import('../../../core/sessions/manager.js');
    const db = new MindDB(path.join(tuiDataDir, 'mind.db'));
    const sessionMgr = new SessionManager(db);

    // --- AgentLoop ---
    const { AgentLoop } = await import('../../../core/agent/loop.js');
    const agentLoop = new AgentLoop(brain, registry, sessionMgr, { maxIterations: 500 });

    // --- InjectionDetector (Wave 6O) — stateless pure detector, no DB. Fail-open. ---
    try {
      const { InjectionDetector } = await import('../../../core/cognition/injection-detector.js');
      agentLoop.setInjectionDetector(new InjectionDetector({
        strictMode: process.env['SUDO_INJECTION_STRICT'] === '1',
      }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      void msg; // fail-open — injection scanning is defense-in-depth
    }

    // --- ConfidenceCalibrationTracker (Wave 6L + 6Q 8th signal). Fail-open. ---
    try {
      const Database = (await import('better-sqlite3')).default;
      const calDb = new Database(path.join(tuiDataDir, 'calibration.db'));
      const { ConfidenceCalibrationTracker } = await import('../../../core/cognition/confidence-calibration-tracker.js');
      const tracker = new ConfidenceCalibrationTracker(calDb);
      agentLoop.setConfidenceCalibrationTracker(tracker);
      // Wire 8th signal (Brier-drift) into AlignmentAggregator — mirror cli.ts line 913.
      (agentLoop.getAlignmentAggregator() as unknown as Record<string, unknown>)['confidenceCalibrationTracker'] = tracker;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      void msg; // fail-open — calibration is defense-in-depth
    }

    this._resolvedDeps = {
      agentLoop,
      sessionManager: sessionMgr as TuiAgentAdapterDeps['sessionManager'],
    };
    return this._resolvedDeps;
  }

  // ---------------------------------------------------------------------------
  // stream — main API consumed by App.tsx
  // ---------------------------------------------------------------------------

  async *stream(opts: {
    sessionId: string;
    message: string;
    signal: AbortSignal;
  }): AsyncGenerator<ProviderChunk> {
    const { agentLoop, sessionManager } = await this._bootstrap();

    // Ensure session exists before calling agentLoop.run() — AgentLoop.run() calls
    // sessionManager.get(sessionId) and throws if the session is not found.
    // The Web/Telegram pattern is: getOrCreate → session.id → run(session.id, msg).
    // NOTE: 'cli' is not in ChannelType; we use 'web' as the closest semantic match.
    const session = await sessionManager.getOrCreate('web' as import('../../../core/channels/types.js').ChannelType, opts.sessionId);
    const resolvedSessionId = String(session.id);

    // elapsedMs tracking: toolId → start timestamp (ms since epoch)
    const startTimes = new Map<string, number>();
    let lastActiveToolId = '';
    let outputText = '';

    // Collected chunks to yield after run() resolves
    const yieldQueue: ProviderChunk[] = [];
    let runError: Error | null = null;

    const onEvent = (event: import('../../../core/agent/types.js').AgentEvent): void => {
      switch (event.type) {
        case 'stream-chunk':
          outputText += event.chunk;
          yieldQueue.push({ type: 'text', value: event.chunk });
          break;

        case 'message':
          outputText += event.content;
          yieldQueue.push({ type: 'text', value: event.content });
          break;

        case 'tool-call': {
          const { toolId, name, args } = event;
          lastActiveToolId = toolId;
          startTimes.set(toolId, Date.now());
          dispatcher.emit({
            type: 'tool_start',
            toolId,
            toolName: name,
            args: JSON.stringify(args),
            gerund: toolNameToGerund(name),
          });
          break;
        }

        case 'tool-result': {
          const { toolId, name, result } = event;
          const resultFull = typeof result === 'string' ? result : JSON.stringify(result ?? '');
          const elapsedMs = startTimes.has(toolId)
            ? Date.now() - (startTimes.get(toolId) ?? Date.now())
            : 0;
          startTimes.delete(toolId);
          const resultPreview = resultFull.slice(0, 120).replace(/\n/g, ' ');
          const trimmed = resultFull.trimStart();
          const isDiff = trimmed.startsWith('@@')
            || (trimmed.includes('\n-') && trimmed.includes('\n+'));
          void name; // suppress unused warning — toolId is the correlation key
          dispatcher.emit({
            type: 'tool_end',
            toolId,
            resultPreview,
            resultFull,
            isDiff,
            elapsedMs,
          });
          break;
        }

        case 'error': {
          if (lastActiveToolId) {
            const elapsedMs = startTimes.has(lastActiveToolId)
              ? Date.now() - (startTimes.get(lastActiveToolId) ?? Date.now())
              : 0;
            startTimes.delete(lastActiveToolId);
            dispatcher.emit({
              type: 'tool_error',
              toolId: lastActiveToolId,
              error: event.error,
              elapsedMs,
            });
          }
          break;
        }

        // Dropped — not surfaced in TUI
        case 'done':
        case 'rich-response':
        case 'trace-meta':
        case 'compaction':
          break;
      }
    };

    const abortPromise = new Promise<never>((_, reject) =>
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
    );

    try {
      await Promise.race([
        agentLoop.run(resolvedSessionId, opts.message, onEvent),
        abortPromise,
      ]);
    } catch (err) {
      if (!opts.signal.aborted) {
        runError = err instanceof Error ? err : new Error(String(err));
      }
      // aborted path falls through to done
    }

    // Flush text chunks accumulated during run
    for (const chunk of yieldQueue) {
      yield chunk;
    }

    if (runError) {
      // Surface non-abort errors as a text chunk so the TUI renders something
      yield { type: 'text', value: `\n[Error: ${runError.message}]` };
    }

    // Approximate token accounting (AgentLoop does not surface token counts)
    yield {
      type: 'done',
      usage: { outputTokens: Math.ceil(outputText.length / 4) },
    };
  }
}
