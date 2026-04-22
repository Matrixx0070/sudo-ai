import React, { useEffect, useState } from 'react';
import { StageProgress } from './StageProgress';
import { Badge } from '@renderer/components/common/Badge';
import { useIpcInvoke, useIpcOn } from '@renderer/hooks/useIpc';

interface PipelineRun {
  id: string;
  title: string;
  channel: string;
  status: 'running' | 'completed' | 'failed' | 'queued';
  currentStage: number;
  completedStages: number[];
  failedStage?: number;
  startedAt: number;
  completedAt?: number;
}

const STATUS_BADGE: Record<PipelineRun['status'], { status: 'online' | 'offline' | 'warning' | 'info' | 'neutral'; label: string }> = {
  running: { status: 'info', label: 'Running' },
  completed: { status: 'online', label: 'Completed' },
  failed: { status: 'offline', label: 'Failed' },
  queued: { status: 'neutral', label: 'Queued' },
};

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m < 1) return `${s}s`;
  return `${m}m ${s % 60}s`;
}

export function PipelineView() {
  const [runs, setRuns] = useState<PipelineRun[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const getPipeline = useIpcInvoke<{ runs: PipelineRun[] }>('pipeline:status');

  useEffect(() => {
    getPipeline().then((data) => {
      if (data?.runs) setRuns(data.runs);
    });
  }, []);

  useIpcOn('pipeline:status', (...args) => {
    const data = args[0] as { runs?: PipelineRun[] };
    if (data?.runs) setRuns(data.runs);
  });

  const selectedRun = runs.find((r) => r.id === selected);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex-1 flex min-h-0">
        {/* Run list */}
        <div className="w-72 border-r border-[var(--border)] overflow-y-auto flex-shrink-0">
          <div className="px-4 py-3 border-b border-[var(--border)]">
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">Pipeline Runs</h2>
          </div>

          {runs.length === 0 ? (
            <div className="p-4 text-sm text-[var(--text-secondary)] italic">
              No pipeline runs yet.
            </div>
          ) : (
            <ul role="list" className="divide-y divide-[var(--border)]">
              {runs.map((run) => {
                const badge = STATUS_BADGE[run.status];
                return (
                  <li key={run.id}>
                    <button
                      onClick={() => setSelected(run.id)}
                      aria-current={selected === run.id ? 'true' : undefined}
                      className={[
                        'w-full text-left px-4 py-3 transition-colors',
                        selected === run.id
                          ? 'bg-[var(--accent)]/10 border-l-2 border-[var(--accent)]'
                          : 'hover:bg-[var(--bg-card)]',
                      ].join(' ')}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium text-[var(--text-primary)] truncate flex-1 mr-2">
                          {run.title}
                        </span>
                        <Badge status={badge.status} label={badge.label} dot />
                      </div>
                      <div className="text-[10px] text-[var(--text-secondary)]">{run.channel}</div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Detail panel */}
        <div className="flex-1 overflow-y-auto p-5">
          {!selectedRun ? (
            <div className="flex flex-col items-center justify-center h-full text-center gap-3">
              <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true">
                <circle cx="10" cy="20" r="4" stroke="#374151" strokeWidth="1.5" />
                <circle cx="20" cy="20" r="4" stroke="#374151" strokeWidth="1.5" />
                <circle cx="30" cy="20" r="4" stroke="#374151" strokeWidth="1.5" />
                <path d="M14 20h2M24 20h2" stroke="#374151" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <p className="text-sm text-[var(--text-secondary)]">Select a run to see details</p>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Run header */}
              <div>
                <div className="flex items-center gap-3 mb-1">
                  <h3 className="text-base font-semibold text-[var(--text-primary)]">
                    {selectedRun.title}
                  </h3>
                  <Badge
                    status={STATUS_BADGE[selectedRun.status].status}
                    label={STATUS_BADGE[selectedRun.status].label}
                    dot
                  />
                </div>
                <p className="text-xs text-[var(--text-secondary)]">
                  Channel: <span className="text-[var(--text-primary)]">{selectedRun.channel}</span>
                  {selectedRun.completedAt && (
                    <>
                      {' '}&bull; Duration:{' '}
                      <span className="text-[var(--text-primary)]">
                        {formatDuration(selectedRun.completedAt - selectedRun.startedAt)}
                      </span>
                    </>
                  )}
                </p>
              </div>

              {/* Stage progress */}
              <section aria-label="Stage progress" className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4">
                <h4 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wide mb-4">
                  Stage Progress
                </h4>
                <StageProgress
                  currentStage={selectedRun.currentStage}
                  completedStages={selectedRun.completedStages}
                  failedStage={selectedRun.failedStage}
                />
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
