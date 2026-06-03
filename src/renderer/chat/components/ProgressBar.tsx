import React from 'react';

interface ProgressBarProps {
  label: string;
  progress?: number;
}

export function ProgressBar({ label, progress }: ProgressBarProps) {
  return (
    <div className="flex gap-2.5 items-center animation-fade-in">
      <div className="w-7 h-7 rounded-full bg-gray-700 border border-gray-600 flex items-center justify-center flex-shrink-0 mt-0.5 text-xs font-bold text-emerald-400">
        S
      </div>
      <div className="flex-1 max-w-[75%]">
        <div className="text-xs text-gray-400 mb-1">{label}</div>
        <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-500 rounded-full transition-all duration-300"
            style={{ width: `${Math.min(100, Math.max(0, progress || 0))}%` }}
          />
        </div>
      </div>
    </div>
  );
}
