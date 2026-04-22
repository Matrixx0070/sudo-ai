/**
 * @file dispatcher.ts — In-process tool event bus + shared ToolCallCard types.
 * App.tsx subscribes via dispatcher.on(). emitDemo() fires a test sequence.
 */

import type {
  ToolStartChunk,
  ToolEndChunk,
  ToolErrorChunk,
  ToolPermissionChunk,
} from './provider.js';

// ---------------------------------------------------------------------------
// ToolCallCard types (shared between ToolCallCard.tsx and App.tsx)
// ---------------------------------------------------------------------------

export type ToolStatus = 'running' | 'done' | 'error';

export interface ToolCallCard {
  toolId: string;
  name: string;
  args: string;
  status: ToolStatus;
  elapsedMs: number;
  resultPreview: string;
  resultFull: string;
  isDiff: boolean;
  expanded: boolean;
  startedAt: number;
}

// ---------------------------------------------------------------------------
// Event type alias
// ---------------------------------------------------------------------------

export type ToolEvent =
  | ToolStartChunk
  | ToolEndChunk
  | ToolErrorChunk
  | ToolPermissionChunk;

type ToolEventHandler = (event: ToolEvent) => void;

// ---------------------------------------------------------------------------
// Dispatcher implementation
// ---------------------------------------------------------------------------

const _handlers = new Set<ToolEventHandler>();

function on(handler: ToolEventHandler): () => void {
  _handlers.add(handler);
  return () => { _handlers.delete(handler); };
}

function emit(event: ToolEvent): void {
  _handlers.forEach(h => {
    try { h(event); } catch { /* never crash the bus */ }
  });
}

/**
 * emitDemo — fires a 3-step demo sequence for local testing.
 * tool_start → (500ms) tool_end
 */
function emitDemo(): void {
  const toolId = `demo-${Date.now()}`;
  emit({
    type: 'tool_start',
    toolId,
    toolName: 'bash',
    args: 'git diff HEAD~1',
    gerund: 'Running…',
  });
  setTimeout(() => {
    emit({
      type: 'tool_end',
      toolId,
      resultPreview: '8 lines changed',
      resultFull: `@@ -12,6 +12,8 @@ export const App: React.FC = () => {\n const [phase, setPhase] = useState<AppPhase>('splash');\n-  const [alignment] = useState<AlignmentStatus>('green');\n+  const [digest, setDigest] = useState<DigestData>(initialDigest);\n+  const [federation, setFed] = useState<FederationData>({ peers: [], count: 0 });`,
      isDiff: true,
      elapsedMs: 412,
    });
  }, 500);
}

export const dispatcher = { on, emit, emitDemo };
