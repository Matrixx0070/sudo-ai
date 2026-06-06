import React from 'react';
import type { View } from '@renderer/App';

interface NavItem {
  view: View;
  label: string;
  icon: React.ReactNode;
}

interface SidebarProps {
  activeView: View;
  onNavigate: (view: View) => void;
}

function IconDashboard() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="2" y="2" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="11" y="2" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="2" y="11" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="11" y="11" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function IconChat() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M3 5a2 2 0 012-2h10a2 2 0 012 2v7a2 2 0 01-2 2H7l-4 3V5z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconPipeline() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="4" cy="10" r="2" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="10" cy="10" r="2" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="16" cy="10" r="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 10h2M12 10h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconSkills() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M10 2l2.09 6.26L18 9.27l-4.5 4.38L14.18 18 10 15.54 5.82 18l1.18-4.35L2 9.27l5.91-1.01L10 2z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconSystem() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="16" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 17h8M10 14v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconSettings() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
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

const TOP_ITEMS: NavItem[] = [
  { view: 'dashboard', label: 'Dashboard', icon: <IconDashboard /> },
  { view: 'chat', label: 'Chat', icon: <IconChat /> },
  { view: 'pipeline', label: 'Pipeline', icon: <IconPipeline /> },
  { view: 'skills', label: 'Skills', icon: <IconSkills /> },
  { view: 'system', label: 'System', icon: <IconSystem /> },
];

export function Sidebar({ activeView, onNavigate }: SidebarProps) {
  return (
    <nav
      aria-label="Main navigation"
      className="flex flex-col items-center w-[60px] h-full bg-[var(--bg-secondary)] border-r border-[var(--border)] py-3 flex-shrink-0"
    >
      {/* Logo mark */}
      <div className="w-9 h-9 rounded-lg bg-[var(--accent)] flex items-center justify-center mb-4 flex-shrink-0">
        <span className="text-white font-bold text-xs select-none">S3</span>
      </div>

      {/* Top nav items */}
      <ul className="flex flex-col gap-1 flex-1 w-full px-2" role="list">
        {TOP_ITEMS.map((item) => {
          const isActive = activeView === item.view;
          return (
            <li key={item.view}>
              <button
                onClick={() => onNavigate(item.view)}
                aria-label={item.label}
                aria-current={isActive ? 'page' : undefined}
                title={item.label}
                className={[
                  'w-full flex items-center justify-center p-2.5 rounded-lg transition-colors duration-150',
                  isActive
                    ? 'bg-[var(--accent)] text-white'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-card)]',
                ].join(' ')}
              >
                {item.icon}
              </button>
            </li>
          );
        })}
      </ul>

      {/* Bottom: settings */}
      <div className="w-full px-2">
        <button
          onClick={() => onNavigate('settings')}
          aria-label="Settings"
          aria-current={activeView === 'settings' ? 'page' : undefined}
          title="Settings"
          className={[
            'w-full flex items-center justify-center p-2.5 rounded-lg transition-colors duration-150',
            activeView === 'settings'
              ? 'bg-[var(--accent)] text-white'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-card)]',
          ].join(' ')}
        >
          <IconSettings />
        </button>
      </div>
    </nav>
  );
}
