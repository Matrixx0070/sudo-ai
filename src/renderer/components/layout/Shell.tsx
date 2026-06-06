import React from 'react';
import { Sidebar } from './Sidebar.js';
import { Header } from './Header.js';
import { AdminSidebar } from './AdminSidebar.js';
import { AdminHeader } from './AdminHeader.js';
import { isElectron } from '@renderer/lib/env';
import type { View } from '@renderer/App';

interface ShellProps {
  activeView: View;
  onNavigate: (view: View) => void;
  children: React.ReactNode;
}

export function Shell({ activeView, onNavigate, children }: ShellProps) {
  if (isElectron) {
    // Original Electron layout: sidebar on left, header+content on right
    return (
      <div className="flex h-screen w-screen overflow-hidden bg-[var(--bg-primary)]">
        {/* Left sidebar */}
        <Sidebar activeView={activeView} onNavigate={onNavigate} />

        {/* Right column: header + content */}
        <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
          <Header />
          <main
            id="main-content"
            className="flex-1 overflow-hidden"
            aria-label={`${activeView} view`}
          >
            {children}
          </main>
        </div>
      </div>
    );
  }

  // Immersive views (chat) — full-screen, no sidebar/header
  const isImmersive = activeView === 'chat';

  if (isImmersive) {
    return (
      <div
        style={{
          position: 'relative',
          height: '100vh',
          width: '100vw',
          overflow: 'hidden',
          background: '#0a0e1a',
        }}
      >
        {/* Floating nav button to return to admin */}
        <button
          onClick={() => onNavigate('admin-dashboard')}
          style={{
            position: 'absolute',
            top: 12,
            left: 12,
            zIndex: 100,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 14px',
            background: 'rgba(0,0,0,0.7)',
            border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: 8,
            color: '#93c5fd',
            fontSize: 12,
            fontWeight: 600,
            fontFamily: 'Inter, sans-serif',
            cursor: 'pointer',
            backdropFilter: 'blur(8px)',
          }}
          aria-label="Back to admin panel"
        >
          &#8592; Admin
        </button>
        <main
          id="main-content"
          style={{ width: '100%', height: '100%', overflow: 'hidden' }}
          aria-label={`${activeView} view`}
        >
          {children}
        </main>
      </div>
    );
  }

  // Admin layout: sidebar + header + content
  return (
    <div
      style={{
        display: 'flex',
        height: '100vh',
        width: '100vw',
        overflow: 'hidden',
        background: '#0a0e1a',
      }}
    >
      <AdminSidebar activeView={activeView} onNavigate={onNavigate} />
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          overflow: 'hidden',
        }}
      >
        <AdminHeader activeView={activeView} />
        <main
          id="main-content"
          style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}
          aria-label={`${activeView} view`}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
