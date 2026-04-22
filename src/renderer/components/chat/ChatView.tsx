import React, { useEffect, useRef } from 'react';
import { useChatStore } from '@renderer/stores/chatStore';
import { nanoid } from 'nanoid';
import { useIpcOn } from '@renderer/hooks/useIpc';
import { MessageBubble } from './MessageBubble';
import { InputBar } from './InputBar';
import { Button } from '@renderer/components/common/Button';

export function ChatView() {
  const {
    messages,
    isStreaming,
    isThinking,
    thinkingText,
    streamingMessageId,
    addMessage,
    appendToMessage,
    setStreaming,
    setThinking,
    clear,
  } = useChatStore();
  const bottomRef = useRef<HTMLDivElement>(null);

  // Listen for stream chunks from main process
  useIpcOn('agent:stream-chunk', (...args) => {
    const data = args[0] as { messageId?: string; chunk?: string; done?: boolean };
    if (data.chunk && streamingMessageId) {
      appendToMessage(streamingMessageId, data.chunk);
    }
    if (data.done) {
      setStreaming(false);
    }
  });

  // Subscribe to WebSocket status events (thinking / progress) emitted by ipc-client
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ type: string; text?: string }>).detail;
      if (detail.type === 'thinking') {
        setThinking(true, detail.text ?? 'SUDO is thinking...');
      } else if (detail.type === 'progress') {
        setThinking(true, detail.text ?? 'Working on it...');
      }
    };
    window.addEventListener('sudo:status', handler);
    return () => window.removeEventListener('sudo:status', handler);
  }, [setThinking]);

  // Handle server-pushed messages (POST /api/message → WS → UI)
  useEffect(() => {
    // User message echoed from API injection
    const echoHandler = (e: Event) => {
      const detail = (e as CustomEvent<{ text: string }>).detail;
      addMessage({ id: nanoid(), role: 'user', content: detail.text, timestamp: Date.now() });
      setThinking(true, 'SUDO is thinking...');
    };
    // SUDO's reply pushed without a pending form submit
    const pushHandler = (e: Event) => {
      const text = (e as CustomEvent<string>).detail;
      setThinking(false);
      addMessage({ id: nanoid(), role: 'assistant', content: text, timestamp: Date.now() });
    };
    window.addEventListener('sudo:user-echo', echoHandler);
    window.addEventListener('sudo:push', pushHandler);
    return () => {
      window.removeEventListener('sudo:user-echo', echoHandler);
      window.removeEventListener('sudo:push', pushHandler);
    };
  }, [addMessage, setThinking]);

  // Clear thinking indicator once the assistant message has content
  useEffect(() => {
    if (!isThinking) return;
    const latest = messages[messages.length - 1];
    if (latest?.role === 'assistant' && latest.content.length > 0) {
      setThinking(false);
    }
  }, [messages, isThinking, setThinking]);

  // Auto-scroll to bottom when messages or thinking state update
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isThinking]);

  const hasMessages = messages.length > 0;

  return (
    <div className="flex flex-col h-full">
      {/* Message list */}
      <div
        role="log"
        aria-label="Chat messages"
        aria-live="polite"
        className="flex-1 overflow-y-auto px-4 py-4 space-y-4"
      >
        {!hasMessages && (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-center">
            <div className="w-16 h-16 rounded-2xl bg-[var(--accent)]/20 flex items-center justify-center">
              <span className="text-3xl font-bold text-[var(--accent)]">S</span>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-[var(--text-primary)]">
                SUDO-AI is ready
              </h2>
              <p className="text-sm text-[var(--text-secondary)] mt-1 max-w-sm">
                Ask anything. Autonomous agent with tool access, skill execution, and full pipeline
                control.
              </p>
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            isStreaming={isStreaming && msg.id === streamingMessageId}
          />
        ))}

        {/* Thinking / progress indicator */}
        {isThinking && (
          <div
            role="status"
            aria-live="polite"
            aria-label="SUDO is thinking"
            className="flex items-center gap-3 px-1 py-1"
          >
            <div
              className="w-7 h-7 rounded-full bg-[var(--bg-card)] border border-[var(--border)] flex items-center justify-center text-[var(--accent)] text-xs font-bold flex-shrink-0"
              aria-hidden="true"
            >
              S
            </div>
            <div className="flex items-center gap-2">
              <span className="flex gap-1" aria-hidden="true">
                <span
                  className="w-2 h-2 bg-[var(--accent)] rounded-full animate-bounce"
                  style={{ animationDelay: '0ms' }}
                />
                <span
                  className="w-2 h-2 bg-[var(--accent)] rounded-full animate-bounce"
                  style={{ animationDelay: '150ms' }}
                />
                <span
                  className="w-2 h-2 bg-[var(--accent)] rounded-full animate-bounce"
                  style={{ animationDelay: '300ms' }}
                />
              </span>
              <span className="text-sm text-[var(--text-secondary)]">{thinkingText}</span>
            </div>
          </div>
        )}

        <div ref={bottomRef} aria-hidden="true" />
      </div>

      {/* Clear button — only shown when there are messages */}
      {hasMessages && (
        <div className="flex justify-end px-4 py-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={clear}
            className="text-[10px]"
          >
            Clear conversation
          </Button>
        </div>
      )}

      {/* Input bar */}
      <InputBar />
    </div>
  );
}
