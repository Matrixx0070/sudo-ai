import React, { useEffect, useState } from 'react';
import { useChatStore } from '@renderer/stores/chatStore';
import { useIpcOn } from '@renderer/hooks/useIpc';
import { Badge } from '@renderer/components/common/Badge';
import { isElectron } from '@renderer/lib/env';
import type { View } from '@renderer/App';

interface AgentState {
  status: 'online' | 'offline' | 'busy';
  mood: string;
  apiCostToday: number;
}

interface HeaderProps {
  /** Only used in web mode — current active view */
  activeView?: View;
  /** Only used in web mode — navigation callback */
  onNavigate?: (view: View) => void;
}

// ---------------------------------------------------------------------------
// Web nav items
// ---------------------------------------------------------------------------

interface WebNavItem {
  view: View;
  label: string;
  icon: React.ReactNode;
}

function IconChatSmall() {
  return (
    <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M3 5a2 2 0 012-2h10a2 2 0 012 2v7a2 2 0 01-2 2H7l-4 3V5z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconDashboardSmall() {
  return (
    <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="2" y="2" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="11" y="2" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="2" y="11" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="11" y="11" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function IconSettingsSmall() {
  return (
    <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M10 2v2M10 16v2M2 10h2M16 10h2M4.22 4.22l1.42 1.42M14.36 14.36l1.42 1.42M4.22 15.78l1.42-1.42M14.36 5.64l1.42-1.42"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

const WEB_NAV_ITEMS: WebNavItem[] = [
  { view: 'chat',      label: 'Chat',      icon: <IconChatSmall /> },
  { view: 'dashboard', label: 'Dashboard', icon: <IconDashboardSmall /> },
  { view: 'settings',  label: 'Settings',  icon: <IconSettingsSmall /> },
];

// ---------------------------------------------------------------------------
// Web header
// ---------------------------------------------------------------------------

function WebHeader({ activeView, onNavigate }: Required<HeaderProps>) {
  return (
    <header
      style={{
        height: '56px',
        background: '#111827',
        borderBottom: '1px solid #1f2937',
        display: 'flex',
        alignItems: 'center',
        padding: '0 24px',
        flexShrink: 0,
        gap: '16px',
      }}
      aria-label="Application header"
    >
      {/* Brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div
          style={{
            width: '32px',
            height: '32px',
            background: '#3b82f6',
            borderRadius: '8px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
          aria-hidden="true"
        >
          <span style={{ color: '#fff', fontWeight: 700, fontSize: '13px', letterSpacing: '-0.5px' }}>
            S3
          </span>
        </div>
        <span style={{ color: '#f9fafb', fontWeight: 700, fontSize: '18px', letterSpacing: '-0.3px' }}>
          SUDO-AI
        </span>
        <span
          style={{ color: '#6b7280', fontSize: '12px', marginLeft: '4px' }}
          className="hidden sm:inline"
        >
          Autonomous AI Agent Platform
        </span>
      </div>

      {/* Top navigation */}
      <nav
        aria-label="Main navigation"
        style={{ display: 'flex', gap: '4px', marginLeft: 'auto' }}
      >
        {WEB_NAV_ITEMS.map((item) => {
          const active = activeView === item.view;
          return (
            <button
              key={item.view}
              onClick={() => onNavigate(item.view)}
              aria-label={item.label}
              aria-current={active ? 'page' : undefined}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '6px 12px',
                borderRadius: '6px',
                border: 'none',
                cursor: 'pointer',
                fontSize: '13px',
                fontWeight: active ? 600 : 400,
                color: active ? '#fff' : '#9ca3af',
                background: active ? '#3b82f6' : 'transparent',
                transition: 'background 0.15s, color 0.15s',
              }}
              onMouseEnter={(e) => {
                if (!active) {
                  (e.currentTarget as HTMLButtonElement).style.background = '#1f2937';
                  (e.currentTarget as HTMLButtonElement).style.color = '#f3f4f6';
                }
              }}
              onMouseLeave={(e) => {
                if (!active) {
                  (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                  (e.currentTarget as HTMLButtonElement).style.color = '#9ca3af';
                }
              }}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Electron header (unchanged from original)
// ---------------------------------------------------------------------------

function ElectronHeader() {
  const currentModel = useChatStore((s) => s.currentModel);
  const [agentState, setAgentState] = useState<AgentState>({
    status: 'online',
    mood: 'focused',
    apiCostToday: 0,
  });

  useIpcOn('agent:state-changed', (...args) => {
    const data = args[0] as Partial<AgentState>;
    setAgentState((prev) => ({ ...prev, ...data }));
  });

  const statusBadge = agentState.status === 'online'
    ? 'online'
    : agentState.status === 'busy'
    ? 'warning'
    : 'offline';

  return (
    <header
      className="flex items-center justify-between px-4 h-12 bg-[var(--bg-secondary)] border-b border-[var(--border)] flex-shrink-0"
      aria-label="Application header"
    >
      {/* Left: agent status */}
      <div className="flex items-center gap-3">
        <Badge
          status={statusBadge}
          label={agentState.status}
          dot
        />
        <span className="text-xs text-[var(--text-secondary)] hidden sm:inline">
          Model:{' '}
          <span className="text-[var(--text-primary)] font-medium">{currentModel}</span>
        </span>
        <span className="text-xs text-[var(--text-secondary)] hidden md:inline">
          Mood:{' '}
          <span className="text-[var(--accent-yellow)] font-medium">{agentState.mood}</span>
        </span>
      </div>

      {/* Right: cost + actions */}
      <div className="flex items-center gap-3">
        <span className="text-xs text-[var(--text-secondary)]">
          Cost today:{' '}
          <span className="text-[var(--accent-green)] font-medium">
            ${agentState.apiCostToday.toFixed(2)}
          </span>
        </span>

        {/* Notification bell */}
        <button
          aria-label="Notifications"
          className="p-1.5 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-card)] transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M8 2a4 4 0 00-4 4v2.5l-1 1.5h10l-1-1.5V6a4 4 0 00-4-4zM6.5 12a1.5 1.5 0 003 0"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        {/* Minimize to tray */}
        <button
          aria-label="Minimize to tray"
          className="p-1.5 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-card)] transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3 8h10M8 13l-5-5M8 13l5-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Public export — renders the correct header based on environment
// ---------------------------------------------------------------------------

export function Header({ activeView, onNavigate }: HeaderProps) {
  if (!isElectron) {
    // Web mode — need nav props; provide safe fallbacks if somehow missing
    const view = activeView ?? 'dashboard';
    const navigate = onNavigate ?? (() => {});
    return <WebHeader activeView={view} onNavigate={navigate} />;
  }

  return <ElectronHeader />;
}
