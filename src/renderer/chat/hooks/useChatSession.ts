import { useState, useCallback } from 'react';

export type Message = {
  role: 'user' | 'ai';
  content: string;
  timestamp: Date;
  /** Object/data URL for an attached image, rendered inline as a preview. */
  imageUrl?: string;
  /** Filename for a non-image attachment, shown as a chip. */
  fileName?: string;
};

export type CurrentResponse =
  | { type: 'thinking'; text: string }
  | { type: 'progress'; text: string; progress?: number }
  | null;

export function useChatSession() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [currentResponse, setCurrentResponse] = useState<CurrentResponse>(null);
  const [error, setError] = useState<string | null>(null);

  const addMessage = useCallback((message: Message) => {
    setMessages((prev) => [...prev, message]);
    setError(null);
  }, []);

  return {
    messages,
    currentResponse,
    error,
    addMessage,
    setCurrentResponse,
    setError,
  };
}
