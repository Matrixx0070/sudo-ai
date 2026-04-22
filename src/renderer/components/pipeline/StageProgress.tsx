import React from 'react';
import { Spinner } from '@renderer/components/common/Spinner';

const STAGES = [
  'Research',
  'Script',
  'Review',
  'Assets',
  'Voice',
  'Render',
  'Encode',
  'Thumbnail',
  'Metadata',
  'Upload',
];

interface StageProgressProps {
  currentStage: number; // 0-indexed, -1 = not started
  completedStages: number[]; // 0-indexed stage indices
  failedStage?: number;
}

export function StageProgress({ currentStage, completedStages, failedStage }: StageProgressProps) {
  return (
    <div aria-label="Pipeline stages" className="w-full">
      {/* Stage labels + icons */}
      <div className="flex items-start gap-0" role="list">
        {STAGES.map((stage, idx) => {
          const isCompleted = completedStages.includes(idx);
          const isCurrent = currentStage === idx;
          const isFailed = failedStage === idx;
          const isPending = !isCompleted && !isCurrent && !isFailed;

          return (
            <div
              key={stage}
              role="listitem"
              aria-label={`Stage ${idx + 1}: ${stage}${isCurrent ? ' (current)' : isCompleted ? ' (completed)' : isFailed ? ' (failed)' : ' (pending)'}`}
              className="flex flex-col items-center flex-1 min-w-0"
            >
              {/* Circle */}
              <div
                className={[
                  'w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold border-2 transition-colors',
                  isCompleted
                    ? 'bg-[var(--accent-green)] border-[var(--accent-green)] text-white'
                    : isCurrent
                    ? 'bg-[var(--accent)]/20 border-[var(--accent)] text-[var(--accent)]'
                    : isFailed
                    ? 'bg-[var(--accent-red)]/20 border-[var(--accent-red)] text-[var(--accent-red)]'
                    : 'bg-transparent border-[var(--border)] text-[var(--text-secondary)]',
                ].join(' ')}
              >
                {isCompleted ? (
                  <span aria-hidden="true">✓</span>
                ) : isCurrent ? (
                  <Spinner size="sm" />
                ) : isFailed ? (
                  <span aria-hidden="true">✕</span>
                ) : (
                  <span aria-hidden="true">{idx + 1}</span>
                )}
              </div>

              {/* Connector line (except last) */}
              <div className="w-full flex items-center justify-center relative" aria-hidden="true">
                {idx < STAGES.length - 1 && (
                  <div
                    className={[
                      'absolute left-1/2 top-[-14px] w-full h-0.5',
                      isCompleted ? 'bg-[var(--accent-green)]' : 'bg-[var(--border)]',
                    ].join(' ')}
                    style={{ left: '50%', width: '100%', transform: 'none' }}
                  />
                )}
              </div>

              {/* Label */}
              <span
                className={[
                  'text-[9px] mt-1.5 text-center leading-tight truncate w-full px-0.5',
                  isCurrent
                    ? 'text-[var(--accent)] font-semibold'
                    : isCompleted
                    ? 'text-[var(--accent-green)]'
                    : isFailed
                    ? 'text-[var(--accent-red)]'
                    : 'text-[var(--text-secondary)]',
                ].join(' ')}
              >
                {stage}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
