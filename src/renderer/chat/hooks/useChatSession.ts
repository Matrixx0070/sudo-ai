import { useState, useCallback } from 'react';

export type Message = {
  role: 'user' | 'ai';
  content: string;
  timestamp: Date;
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
