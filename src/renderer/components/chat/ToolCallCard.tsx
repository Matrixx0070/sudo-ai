import React, { useState } from 'react';
import { Spinner } from '@renderer/components/common/Spinner';
import type { ToolCall } from '@renderer/stores/chatStore';

interface ToolCallCardProps {
  toolCall: ToolCall;
}

const MAX_PREVIEW_CHARS = 300;

export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [resultExpanded, setResultExpanded] = useState(false);

  const resultStr = toolCall.result ?? '';
  const isLong = resultStr.length > MAX_PREVIEW_CHARS;
  const displayResult = resultExpanded ? resultStr : resultStr.slice(0, MAX_PREVIEW_CHARS);

  return (
    <div
      className="mt-2 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] text-xs overflow-hidden"
      aria-label={`Tool call: ${toolCall.name}`}
    >
      {/* Header — always visible, click to expand */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--bg-card)] transition-colors"
        aria-expanded={expanded}
      >
        {/* Status icon */}
        <span className="flex-shrink-0">
          {toolCall.status === 'running' && <Spinner size="sm" />}
          {toolCall.status === 'done' && (
            <span className="text-[var(--accent-green)] font-bold">✓</span>
          )}
          {toolCall.status === 'error' && (
            <span className="text-[var(--accent-red)] font-bold">✕</span>
          )}
        </span>

        {/* Tool name */}
        <span className="font-mono font-semibold text-[var(--accent)] flex-1">
          {toolCall.name}
        </span>

        {/* Duration */}
        {toolCall.durationMs !== undefined && (
          <span className="text-[var(--text-secondary)]">{toolCall.durationMs}ms</span>
        )}

        {/* Chevron */}
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
          className={['transition-transform duration-150', expanded ? 'rotate-180' : ''].join(' ')}
        >
          <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-3 pb-3 space-y-2 border-t border-[var(--border)]">
          {/* Arguments */}
          <div>
            <div className="text-[var(--text-secondary)] font-semibold py-1.5">Arguments</div>
            <pre className="bg-[var(--bg-primary)] rounded p-2 overflow-x-auto text-[var(--text-primary)] text-xs leading-relaxed">
              {JSON.stringify(toolCall.args, null, 2)}
            </pre>
          </div>

          {/* Result */}
          {resultStr && (
            <div>
              <div className="text-[var(--text-secondary)] font-semibold py-1.5">Result</div>
              <pre className="bg-[var(--bg-primary)] rounded p-2 overflow-x-auto text-[var(--text-primary)] text-xs leading-relaxed whitespace-pre-wrap">
                {displayResult}
                {isLong && !resultExpanded && '…'}
              </pre>
              {isLong && !resultExpanded && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setResultExpanded(true);
                  }}
                  className="text-[var(--accent)] hover:underline mt-1"
                >
                  Show full result
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
