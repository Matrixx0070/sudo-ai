import React, { useRef, useState, useCallback } from 'react';
import { useChatStore, type Persona } from '@renderer/stores/chatStore';
import { ipcInvoke } from '@renderer/lib/ipc-client';
import { nanoid } from 'nanoid';

const PERSONAS: { value: Persona; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'coder', label: 'Coder' },
  { value: 'researcher', label: 'Researcher' },
  { value: 'creative', label: 'Creative' },
];

export function InputBar() {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { isStreaming, addMessage, setStreaming, setThinking, currentPersona, setPersona } =
    useChatStore();

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;

    // Add user message to store
    addMessage({
      id: nanoid(),
      role: 'user',
      content: trimmed,
      timestamp: Date.now(),
    });

    // Create placeholder assistant message
    const assistantId = nanoid();
    addMessage({
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    });

    setStreaming(true, assistantId);
    setThinking(true, 'SUDO is thinking...');
    setText('');

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    // Send via IPC invoke (request/response)
    ipcInvoke<{ success: boolean; response?: string; error?: string }>(
      'agent:send-message',
      { message: trimmed, persona: currentPersona }
    ).then((r) => {
      const store = useChatStore.getState();
      if (r?.success && r.response) {
        store.appendToMessage(assistantId, r.response);
      } else if (r?.error) {
        store.appendToMessage(assistantId, `Error: ${r.error}`);
      } else {
        store.appendToMessage(assistantId, 'No response received');
      }
      store.setThinking(false);
      store.setStreaming(false);
    }).catch((err: Error) => {
      const store = useChatStore.getState();
      store.appendToMessage(assistantId, `Error: ${err.message}`);
      store.setThinking(false);
      store.setStreaming(false);
    });
  }, [text, isStreaming, addMessage, setStreaming, setThinking, currentPersona]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    // Auto-resize
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  return (
    <div className="px-4 py-3 border-t border-[var(--border)] bg-[var(--bg-secondary)]">
      {/* Persona selector */}
      <div className="flex items-center gap-2 mb-2">
        <label htmlFor="persona-select" className="text-xs text-[var(--text-secondary)]">
          Persona:
        </label>
        <select
          id="persona-select"
          value={currentPersona}
          onChange={(e) => setPersona(e.target.value as Persona)}
          className="text-xs bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text-primary)] rounded-md px-2 py-1 cursor-pointer focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
        >
          {PERSONAS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      {/* Input row */}
      <div className="flex items-end gap-2">
        {/* File attachment */}
        <button
          aria-label="Attach file"
          className="p-2 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-card)] transition-colors flex-shrink-0"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M14 8.5l-6 6a4 4 0 01-5.66-5.66l6-6a2.5 2.5 0 013.54 3.54l-6 6a1 1 0 01-1.42-1.42l5.5-5.5"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </button>

        {/* Textarea */}
        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            id="chat-input"
            aria-label="Message input"
            placeholder="Message SUDO-AI… (Enter to send, Shift+Enter for newline)"
            value={text}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={isStreaming}
            className={[
              'w-full resize-none bg-[var(--bg-card)] border border-[var(--border)] rounded-xl',
              'px-3 py-2.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-secondary)]',
              'focus:outline-none focus:ring-1 focus:ring-[var(--accent)] transition-colors',
              'disabled:opacity-50 leading-relaxed max-h-40 overflow-y-auto',
            ].join(' ')}
          />
        </div>

        {/* Send button */}
        <button
          onClick={handleSend}
          disabled={!text.trim() || isStreaming}
          aria-label="Send message"
          className={[
            'p-2.5 rounded-xl transition-colors flex-shrink-0',
            text.trim() && !isStreaming
              ? 'bg-[var(--accent)] text-white hover:bg-blue-500'
              : 'bg-[var(--bg-card)] text-[var(--text-secondary)] cursor-not-allowed',
          ].join(' ')}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M2 8h12M10 4l4 4-4 4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      <p className="text-[10px] text-[var(--text-secondary)] mt-1.5 text-center">
        Enter to send — Shift+Enter for newline
      </p>
    </div>
  );
}
