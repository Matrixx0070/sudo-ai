import { create } from 'zustand';

export type MessageRole = 'user' | 'assistant' | 'system';

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  status: 'running' | 'done' | 'error';
  durationMs?: number;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
}

export type Persona = 'default' | 'coder' | 'researcher' | 'creative';

interface ChatState {
  messages: ChatMessage[];
  isStreaming: boolean;
  isThinking: boolean;
  thinkingText: string;
  currentModel: string;
  currentPersona: Persona;
  streamingMessageId: string | null;

  addMessage: (msg: ChatMessage) => void;
  appendToMessage: (id: string, chunk: string) => void;
  setStreaming: (streaming: boolean, messageId?: string) => void;
  setThinking: (thinking: boolean, text?: string) => void;
  setModel: (model: string) => void;
  setPersona: (persona: Persona) => void;
  updateToolCall: (messageId: string, toolCall: ToolCall) => void;
  clear: () => void;
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  isStreaming: false,
  isThinking: false,
  thinkingText: 'SUDO is thinking...',
  currentModel: 'claude-sonnet-4-6',
  currentPersona: 'default',
  streamingMessageId: null,

  addMessage: (msg) =>
    set((state) => ({ messages: [...state.messages, msg] })),

  appendToMessage: (id, chunk) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === id ? { ...m, content: m.content + chunk } : m
      ),
    })),

  setStreaming: (streaming, messageId) =>
    set({ isStreaming: streaming, streamingMessageId: messageId ?? null }),

  setThinking: (thinking, text) =>
    set({ isThinking: thinking, thinkingText: text ?? 'SUDO is thinking...' }),

  setModel: (model) => set({ currentModel: model }),

  setPersona: (persona) => set({ currentPersona: persona }),

  updateToolCall: (messageId, toolCall) =>
    set((state) => ({
      messages: state.messages.map((m) => {
        if (m.id !== messageId) return m;
        const existing = m.toolCalls ?? [];
        const idx = existing.findIndex((t) => t.id === toolCall.id);
        if (idx === -1) {
          return { ...m, toolCalls: [...existing, toolCall] };
        }
        const updated = [...existing];
        updated[idx] = toolCall;
        return { ...m, toolCalls: updated };
      }),
    })),

  clear: () =>
    set({ messages: [], isStreaming: false, isThinking: false, streamingMessageId: null }),
}));
