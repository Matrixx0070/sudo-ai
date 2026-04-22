import React from 'react';
import { useOfficeStore } from '@renderer/stores/officeStore.js';
import { AGENTS } from '../constants.js';
import type { AgentState } from '../types.js';

const STATE_LABELS: Record<AgentState, string> = {
  idle: 'Idle',
  working: 'Working',
  thinking: 'Thinking',
  talking: 'Talking',
  walking: 'Moving',
  break: 'On Break',
  error: 'Error',
};

const STATE_COLORS: Record<AgentState, string> = {
  idle: '#6b7280',
  working: '#22c55e',
  thinking: '#eab308',
  talking: '#3b82f6',
  walking: '#14b8a6',
  break: '#a855f7',
  error: '#ef4444',
};

function formatTimeSince(timestamp: number): string {
  const diff = Math.floor((Date.now() - timestamp) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

export function AgentPanel(): React.ReactElement | null {
  const selectedAgent = useOfficeStore((s) => s.selectedAgent);
  const agents = useOfficeStore((s) => s.agents);
  const selectAgent = useOfficeStore((s) => s.selectAgent);
  const resetCamera = useOfficeStore((s) => s.resetCamera);

  if (!selectedAgent) return null;

  const runtime = agents[selectedAgent];
  const definition = AGENTS.find((a) => a.code === selectedAgent);

  if (!runtime || !definition) return null;

  function handleClose(): void {
    selectAgent(null);
    resetCamera();
  }

  const stateColor = STATE_COLORS[runtime.state];
  const progressPct = Math.min(100, Math.max(0, runtime.taskProgress));

  return (
    <div
      role="complementary"
      aria-label={`Agent panel for ${definition.name}`}
      className="pointer-events-none fixed inset-0 z-40"
    >
      <aside
        className="pointer-events-auto absolute right-0 top-0 flex h-full w-80 flex-col gap-0 overflow-y-auto rounded-l-xl bg-gray-900/90 backdrop-blur-sm"
        style={{ borderLeft: `3px solid ${definition.color}` }}
      >
        {/* Header */}
        <div
          className="flex items-start justify-between px-5 pb-3 pt-5"
          style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}
        >
          <div>
            <h2
              className="text-lg font-bold leading-tight text-white"
              style={{ color: definition.color }}
            >
              {definition.name}
            </h2>
            <p className="text-xs text-gray-400">{definition.code}</p>
            <p className="mt-0.5 text-sm text-gray-300">{definition.role}</p>
          </div>

          <button
            type="button"
            onClick={handleClose}
            className="rounded p-1 text-gray-400 transition-colors hover:bg-gray-700 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
            aria-label="Close agent panel"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* State badge */}
        <div className="px-5 py-4">
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: stateColor }}
              aria-hidden="true"
            />
            <span className="text-sm font-medium text-white">
              {STATE_LABELS[runtime.state]}
            </span>
          </div>
        </div>

        {/* Current task */}
        <div
          className="px-5 py-4"
          style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}
        >
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-gray-500">
            Current Task
          </p>
          {runtime.currentTask ? (
            <>
              <p className="mb-2 text-sm text-gray-200">{runtime.currentTask}</p>
              {/* Progress bar */}
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-700">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${progressPct}%`,
                    backgroundColor: definition.color,
                  }}
                  role="progressbar"
                  aria-valuenow={progressPct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="Task progress"
                />
              </div>
              <p className="mt-1 text-right text-xs text-gray-500">{progressPct}%</p>
            </>
          ) : (
            <p className="text-sm text-gray-500 italic">No active task</p>
          )}
        </div>

        {/* Last activity */}
        <div
          className="px-5 py-4"
          style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}
        >
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-gray-500">
            Last Activity
          </p>
          <p className="text-sm text-gray-300">{runtime.lastActivity}</p>
          <p className="mt-0.5 text-xs text-gray-600">
            {formatTimeSince(runtime.lastActivityTime)}
          </p>
        </div>

        {/* Location */}
        <div
          className="px-5 py-4"
          style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}
        >
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-gray-500">
            Location
          </p>
          <p className="text-sm capitalize text-gray-300">
            {runtime.currentRoom.replace(/-/g, ' ')}
          </p>
        </div>
      </aside>
    </div>
  );
}

export default AgentPanel;
