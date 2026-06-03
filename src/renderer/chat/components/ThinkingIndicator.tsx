import React from 'react';

interface ThinkingIndicatorProps {
  text: string;
}

export function ThinkingIndicator({ text }: ThinkingIndicatorProps) {
  return (
    <div className="flex gap-2.5 items-center animation-fade-in">
      <div className="w-7 h-7 rounded-full bg-gray-700 border border-gray-600 flex items-center justify-center flex-shrink-0 mt-0.5 text-xs font-bold text-emerald-400">
        S
      </div>
      <div className="flex items-center gap-2 px-3.5 py-2 text-sm text-gray-400">
        <span>{text}</span>
        <span className="dots flex">
          <span className="animate-blink">.</span>
          <span className="animate-blink animation-delay-200">.</span>
          <span className="animate-blink animation-delay-400">.</span>
        </span>
      </div>
    </div>
  );
}
