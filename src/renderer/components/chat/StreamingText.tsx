import React from 'react';

interface StreamingTextProps {
  text: string;
  isStreaming: boolean;
}

export function StreamingText({ text, isStreaming }: StreamingTextProps) {
  return (
    <span>
      {text}
      {isStreaming && (
        <span
          aria-hidden="true"
          className="inline-block w-0.5 h-4 bg-[var(--accent)] ml-0.5 align-text-bottom cursor-blink"
        />
      )}
    </span>
  );
}
