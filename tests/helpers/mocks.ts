/**
 * Mock factories for SUDO-AI v3 test suite.
 * Returns typed vi mocks for Brain, ToolRegistry, MindDB, SessionManager,
 * and ConsciousnessOrchestrator.
 */

import { vi } from 'vitest';
import type { BrainResponse, BrainRequest } from '../../src/core/brain/types.js';
import type { ToolDefinition, ToolResult, ToolContext } from '../../src/core/tools/types.js';
import type { Session } from '../../src/core/sessions/types.js';
import { validConfig } from './fixtures.js';

// ---------------------------------------------------------------------------
// Brain mock
// ---------------------------------------------------------------------------

export function createMockBrain() {
  const defaultResponse: BrainResponse = {
    content: 'Hello from mock brain',
    toolCalls: [],
    usage: {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      estimatedCost: 0.001,
    },
    model: 'xai/grok-3-fast',
    finishReason: 'stop',
  };

  return {
    call: vi.fn(async (_request: BrainRequest): Promise<BrainResponse> => defaultResponse),
    stream: vi.fn(async function* (_request: BrainRequest): AsyncGenerator<string> {
      yield 'Hello ';
      yield 'from ';
      yield 'stream';
    }),
    setPersona: vi.fn(),
    setMood: vi.fn(),
    setRAGEngine: vi.fn(),
    getSystemPrompt: vi.fn(async () => 'Mock system prompt'),
    getFailoverStatus: vi.fn(() => []),
  };
}

// ---------------------------------------------------------------------------
// ToolRegistry mock
// ---------------------------------------------------------------------------

export function createMockToolRegistry() {
  const tools: Map<string, ToolDefinition> = new Map();

  return {
    register: vi.fn((tool: ToolDefinition) => { tools.set(tool.name, tool); }),
    registerMany: vi.fn((toolList: ToolDefinition[]) => {
      for (const t of toolList) tools.set(t.name, t);
    }),
    unregister: vi.fn((name: string) => { tools.delete(name); }),
    get: vi.fn((name: string) => tools.get(name)),
    getByCategory: vi.fn(() => []),
    listAll: vi.fn(() => [...tools.values()]),
    listEnabled: vi.fn(() => [...tools.values()]),
    disable: vi.fn(),
    enable: vi.fn(),
    isEnabled: vi.fn(() => true),
    getSchemaForLLM: vi.fn(() => []),
    execute: vi.fn(async (_name: string, _params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> => ({
      success: true,
      output: 'mock tool result',
      data: { mock: true },
    })),
    executeCall: vi.fn(async () => ({
      toolCallId: 'mock-call-id',
      name: 'mock.tool',
      result: { success: true, output: 'mock result' },
      durationMs: 10,
    })),
    size: 0,
    enabledSize: 0,
  };
}

// ---------------------------------------------------------------------------
// MindDB mock
// ---------------------------------------------------------------------------

export function createMockMindDB() {
  const chunks: Map<number, { id: number; text: string; path: string; source: string }> = new Map();
  const sessions: Map<string, { id: string; model: string; title?: string }> = new Map();
  const messages: Array<{ id: number; session_id: string; role: string; content: string }> = [];
  let nextId = 1;

  const mockDb = {
    prepare: vi.fn(() => ({
      all: vi.fn(() => []),
      get: vi.fn(() => undefined),
      run: vi.fn(() => ({ changes: 0, lastInsertRowid: nextId++ })),
    })),
  };

  return {
    db: mockDb,
    vecLoaded: false,
    storeChunk: vi.fn((text: string, path: string, source: string) => {
      const id = nextId++;
      const chunk = { id, text, path, source, hash: 'mock-hash', isEvergreen: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      chunks.set(id, chunk);
      return chunk;
    }),
    getChunk: vi.fn((id: number) => chunks.get(id)),
    deleteChunk: vi.fn(() => true),
    getChunkByHash: vi.fn(() => undefined),
    storeSession: vi.fn((s: { id: string; model: string; title?: string }) => { sessions.set(s.id, s); }),
    storeMessage: vi.fn((_sessionId: string, _role: string, _content: string) => {
      const id = nextId++;
      messages.push({ id, session_id: _sessionId, role: _role, content: _content });
      return id;
    }),
    getMessage: vi.fn((id: number) => messages.find((m) => m.id === id)),
    getSessionMessages: vi.fn((_sessionId: string) => []),
    storeTask: vi.fn(() => nextId++),
    updateTask: vi.fn(),
    storePipelineRun: vi.fn(() => nextId++),
    updatePipelineRun: vi.fn(),
    storeApiCost: vi.fn(() => nextId++),
    storeCronRun: vi.fn(() => nextId++),
    storeVideoMetrics: vi.fn(() => nextId++),
    storeContentIdea: vi.fn(() => nextId++),
    close: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// SessionManager mock
// ---------------------------------------------------------------------------

export function createMockSessionManager() {
  const sessionStore: Map<string, Session> = new Map();

  function makeSession(id: string, channel: string = 'telegram', peerId: string = 'user-123'): Session {
    return {
      id,
      channel: channel as Session['channel'],
      peerId,
      state: 'active',
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  const defaultSession = makeSession('test-session-id');
  sessionStore.set('test-session-id', defaultSession);

  return {
    getOrCreate: vi.fn(async (channel: string, peerId: string): Promise<Session> => {
      const key = `${channel}:${peerId}`;
      if (!sessionStore.has(key)) {
        const s = makeSession(`session-${key}`, channel, peerId);
        sessionStore.set(key, s);
        sessionStore.set(s.id, s);
      }
      return sessionStore.get(key)!;
    }),
    get: vi.fn(async (sessionId: string): Promise<Session | undefined> => {
      return sessionStore.get(sessionId);
    }),
    save: vi.fn(async (session: Session) => {
      sessionStore.set(session.id, session);
    }),
    archive: vi.fn(async (sessionId: string) => {
      const s = sessionStore.get(sessionId);
      if (s) s.state = 'archived';
    }),
    listActive: vi.fn(async () => [...sessionStore.values()].filter((s) => s.state === 'active')),
    exportSession: vi.fn(async () => '# Mock Export'),
    pruneOldSessions: vi.fn(async () => 0),
    scopeMode: 'main',
    cacheSize: sessionStore.size,
    peerQueue: { enqueue: vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()) },
    // helper to add test sessions
    _addSession: (s: Session) => { sessionStore.set(s.id, s); },
    _getStore: () => sessionStore,
  };
}

// ---------------------------------------------------------------------------
// ConsciousnessOrchestrator mock
// ---------------------------------------------------------------------------

export function createMockConsciousnessOrchestrator() {
  return {
    boot: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    onInteractionStart: vi.fn(async (_userId: string, _message: string) => ({
      contextSummary: 'Mock context summary',
      activeConcepts: ['concept1', 'concept2'],
    })),
    onInteractionEnd: vi.fn(async () => undefined),
    getConsciousnessContext: vi.fn(() => '## Internal State\nMock consciousness context'),
    getState: vi.fn(() => ({
      isBooted: true,
      bodyState: { energy: 0.8, clarity: 0.7, sampledAt: new Date().toISOString() },
      emotionalState: { dominantEmotion: 'neutral', intensity: 0.5, tags: [], valence: 0 },
      dominantDrive: 'curiosity',
      thoughtCount: 3,
      isStreaming: false,
      isSleeping: false,
      lastInteraction: new Date().toISOString(),
    })),
    introspect: vi.fn(async (_question: string) => 'Mock introspection answer'),
    attachSleepCycle: vi.fn(),
    attachSelfEvolution: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Minimal tool definition helper
// ---------------------------------------------------------------------------

export function makeToolDefinition(
  name: string,
  category: ToolDefinition['category'] = 'system',
  executeResult: ToolResult = { success: true, output: `${name} executed` },
): ToolDefinition {
  return {
    name,
    description: `Mock tool: ${name}`,
    category,
    parameters: {
      input: {
        type: 'string',
        description: 'Input parameter',
        required: false,
      },
    },
    execute: vi.fn(async () => executeResult),
  };
}

// ---------------------------------------------------------------------------
// Minimal tool context helper
// ---------------------------------------------------------------------------

export function makeToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'test-session-id',
    workingDir: '/tmp',
    config: validConfig,
    logger: console,
    ...overrides,
  };
}
