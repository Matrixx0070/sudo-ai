import React, { useEffect, useRef } from 'react';
import { MessageBubble } from './MessageBubble';
import { ThinkingIndicator } from './ThinkingIndicator';
import { ProgressBar } from './ProgressBar';
import type { Message, CurrentResponse } from '../hooks/useChatSession';

interface ChatWindowProps {
  messages: Message[];
  currentResponse: CurrentResponse;
  error: string | null;
}

export function ChatWindow({ messages, currentResponse, error }: ChatWindowProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [messages, currentResponse]);

  const isEmpty = messages.length === 0 && !currentResponse;

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto p-5 flex flex-col gap-4"
    >
      {isEmpty && (
        <div className="flex flex-col items-center justify-center h-full text-center gap-4">
          <div className="w-16 h-16 rounded-2xl bg-blue-500/15 flex items-center justify-center font-bold text-3xl text-blue-400">
            S
          </div>
          <h2 className="text-lg font-semibold">SUDO-AI is ready</h2>
          <p className="text-sm text-gray-400 max-w-md leading-relaxed">
            Ask anything. Autonomous agent with 200+ tools, consciousness layer, and full system access.
          </p>
        </div>
      )}

      {messages.map((msg, idx) => (
        <MessageBubble
          key={idx}
          role={msg.role}
          content={msg.content}
          timestamp={msg.timestamp}
          imageUrl={msg.imageUrl}
          audioUrl={msg.audioUrl}
          fileUrl={msg.fileUrl}
          fileName={msg.fileName}
        />
      ))}

      {currentResponse?.type === 'streaming' && (
        <MessageBubble role="ai" content={currentResponse.text} timestamp={new Date()} />
      )}

      {currentResponse?.type === 'thinking' && (
        <ThinkingIndicator text={currentResponse.text} />
      )}

      {currentResponse?.type === 'progress' && (
        <ProgressBar label={currentResponse.text} progress={currentResponse.progress} />
      )}

      {error && (
        <div className="flex gap-2.5 items-start animation-fade-in">
          <div className="w-7 h-7 rounded-full bg-gray-700 border border-gray-600 flex items-center justify-center flex-shrink-0 mt-0.5 text-red-400 text-xs font-bold">
            !
          </div>
          <div className="max-w-[75%] flex flex-col gap-1">
            <div className="px-3.5 py-2.5 rounded-[14px] bg-gray-700 border border-gray-600 text-sm leading-relaxed text-red-300">
              {error}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
