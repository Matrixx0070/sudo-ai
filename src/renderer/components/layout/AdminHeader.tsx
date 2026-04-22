import React from 'react';
import type { View } from '@renderer/App';

interface AdminHeaderProps {
  activeView: View;
}

const VIEW_TITLES: Record<string, string> = {
  'office':              'Crystal Palace Office',
  'chat':                'Chat',
  'admin-dashboard':     'Dashboard',
  'admin-models':        'AI Models',
  'admin-channels':      'Channels',
  'admin-tools':         'Tools',
  'admin-consciousness': 'Consciousness',
  'admin-cron':          'Cron Jobs',
  'admin-settings':      'Settings',
  'admin-security':      'Security',
  'admin-logs':          'Logs',
  'admin-system':        'System',
  'admin-sessions':      'Sessions',
};

function IconBell() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 2a4 4 0 00-4 4v2.5l-1 1.5h10l-1-1.5V6a4 4 0 00-4-4zM6.5 12a1.5 1.5 0 003 0"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function AdminHeader({ activeView }: AdminHeaderProps) {
  const title = VIEW_TITLES[activeView] ?? activeView;

  return (
    <header
      aria-label="Page header"
      style={{
        height: '48px',
        minHeight: '48px',
        background: '#111827',
        borderBottom: '1px solid #1f2937',
        display: 'flex',
        alignItems: 'center',
        padding: '0 20px',
        flexShrink: 0,
        boxSizing: 'border-box',
      }}
    >
      {/* Left spacer — keeps title centred */}
      <div style={{ flex: 1 }} />

      {/* Center: page title */}
      <div
        style={{
          position: 'absolute',
          left: '50%',
          transform: 'translateX(-50%)',
          pointerEvents: 'none',
        }}
      >
        <h1
          style={{
            margin: 0,
            fontSize: '14px',
            fontWeight: 600,
            color: '#f9fafb',
            fontFamily: 'Inter, sans-serif',
            letterSpacing: '-0.1px',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </h1>
      </div>

      {/* Right: status + bell */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: '12px',
        }}
      >
        {/* Online status */}
        <div
          role="status"
          aria-label="System status: Online"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
          }}
        >
          {/* Green dot */}
          <span
            aria-hidden="true"
            style={{
              width: '7px',
              height: '7px',
              borderRadius: '50%',
              background: '#22c55e',
              display: 'inline-block',
              boxShadow: '0 0 0 2px rgba(34, 197, 94, 0.2)',
            }}
          />
          <span
            style={{
              fontSize: '12px',
              color: '#9ca3af',
              fontFamily: 'Inter, sans-serif',
              fontWeight: 500,
            }}
          >
            Online
          </span>
        </div>

        {/* Bell button */}
        <button
          aria-label="Notifications"
          style={{
            background: 'none',
            border: 'none',
            color: '#6b7280',
            cursor: 'pointer',
            padding: '6px',
            borderRadius: '6px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'background 0.12s, color 0.12s',
          }}
          onMouseEnter={(e) => {
            const btn = e.currentTarget as HTMLButtonElement;
            btn.style.background = '#1f2937';
            btn.style.color = '#f3f4f6';
          }}
          onMouseLeave={(e) => {
            const btn = e.currentTarget as HTMLButtonElement;
            btn.style.background = 'none';
            btn.style.color = '#6b7280';
          }}
        >
          <IconBell />
        </button>
      </div>
    </header>
  );
}
