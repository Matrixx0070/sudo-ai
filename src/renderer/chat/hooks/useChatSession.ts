import { useState, useCallback } from 'react';

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
