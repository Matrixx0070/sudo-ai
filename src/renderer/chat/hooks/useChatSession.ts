import { useState, useCallback, useEffect } from 'react';
import { getChatPeerId } from '../peer';
import { loadHistory, saveHistory, clearHistory } from '../history';

export type Message = {
  role: 'user' | 'ai';
  content: string;
  timestamp: Date;
  /** Object/data URL for an attached image, rendered inline as a preview. */
  imageUrl?: string;
  /** Data URL for an attached audio clip (e.g. a voice reply), rendered as a player. */
  audioUrl?: string;
  /** Data/object URL for a non-image, non-audio file, rendered as a download link. */
  fileUrl?: string;
  /** Filename for a non-image attachment, shown as a chip / download label. */
  fileName?: string;
};

export type CurrentResponse =
  | { type: 'thinking'; text: string }
  | { type: 'progress'; text: string; progress?: number }
  | { type: 'streaming'; text: string }
  // BO11/S13: live phase row (spinner + label + elapsed counter).
  | { type: 'phase'; phase: 'waiting' | 'running' | 'streaming'; label: string; elapsedSec: number }
  | null;

const HISTORY_KEY = `sudo-chat-history:${getChatPeerId()}`;

export function useChatSession() {
  // Restore the prior conversation (text + media markers) persisted on this browser.
  const [messages, setMessages] = useState<Message[]>(() => loadHistory(HISTORY_KEY));
  const [currentResponse, setCurrentResponse] = useState<CurrentResponse>(null);
  const [error, setError] = useState<string | null>(null);
  // BO11/S13: always-visible model | context chip; persists across turns once seen.
  const [chip, setChip] = useState<string | null>(null);

  // Persist on every change so a reload restores the conversation.
  useEffect(() => {
    saveHistory(HISTORY_KEY, messages);
  }, [messages]);

  const addMessage = useCallback((message: Message) => {
    setMessages((prev) => [...prev, message]);
    setError(null);
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
    setCurrentResponse(null);
    setError(null);
    clearHistory(HISTORY_KEY);
  }, []);

  return {
    messages,
    currentResponse,
    error,
    chip,
    addMessage,
    clearMessages,
    setCurrentResponse,
    setError,
    setChip,
  };
}
